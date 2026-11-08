/**
 * Airwallex gateway behaviour under network loss, with fetch stubbed (no sandbox needed).
 * A live run on 2026-11-09 lost the network for ~17s; captures failed and two holds stayed open.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { AirwallexHoldGateway } from "../src/payments/airwallex.ts";
import { BrowserConfirmedHolds } from "../src/payments/airwallex-browser.ts";
import { TransientError } from "../src/payments/types.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; body?: Record<string, unknown> };

/** Stub fetch: login always works; other calls follow `script` (an Error = network failure). */
function stubFetch(script: Array<Error | { status: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/authentication/login")) return new Response(JSON.stringify({ token: "t" }), { status: 200 });
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = script.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return calls;
}

const gateway = (retryDelaysMs = [0, 0, 0]) => new AirwallexHoldGateway({ clientId: "c", apiKey: "k", retryDelaysMs });

describe("AirwallexHoldGateway retries", () => {
  test("capture survives a network drop and retries with the same request_id", async () => {
    const calls = stubFetch([new TypeError("fetch failed"), new TypeError("fetch failed"), { status: 200, body: { id: "int_1" } }]);
    await gateway().capture("int_1", 420_000);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.body?.request_id === "margin-int_1-capture"));
    assert.equal(calls[2]!.body?.amount, 0.42);
  });

  test("5xx is retried; gives up as TransientError once the delays run out", async () => {
    stubFetch([{ status: 503, body: {} }, { status: 502, body: {} }, { status: 500, body: {} }]);
    await assert.rejects(gateway([0, 0]).cancel("int_1", "nothing_spent"), TransientError);
  });

  test("a 4xx is not retried", async () => {
    const calls = stubFetch([{ status: 400, body: { code: "invalid_argument" } }, { status: 200, body: {} }]);
    await assert.rejects(gateway().capture("int_1", 10_000), (e: unknown) => !(e instanceof TransientError));
    assert.equal(calls.length, 1);
  });

  test("a login that fails on the network is transient too", async () => {
    let logins = 0;
    globalThis.fetch = (async (input: string | URL) => {
      if (String(input).endsWith("/authentication/login") && logins++ === 0) throw new TypeError("fetch failed");
      if (String(input).endsWith("/authentication/login")) return new Response(JSON.stringify({ token: "t" }), { status: 200 });
      return new Response(JSON.stringify({ id: "int_1", status: "REQUIRES_CAPTURE", amount: 1, currency: "USD" }), { status: 200 });
    }) as typeof fetch;
    const intent = await gateway().retrieve("int_1");
    assert.equal(intent.status, "REQUIRES_CAPTURE");
    assert.equal(logins, 2);
  });
});

describe("BrowserConfirmedHolds", () => {
  test("keeps polling through a network blip until the card is authorized", async () => {
    stubFetch([
      { status: 200, body: { id: "int_9", client_secret: "s" } }, // create
      { status: 200, body: { id: "int_9", status: "REQUIRES_PAYMENT_METHOD", amount: 1, currency: "USD" } },
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"), // one retrieve gives up after 3 retries; the poll carries on
      { status: 200, body: { id: "int_9", status: "REQUIRES_CAPTURE", amount: 1, currency: "USD" } },
    ]);
    const asked: string[] = [];
    const holds = new BrowserConfirmedHolds(gateway(), (r) => asked.push(r.holdId), { pollMs: 0, sleep: async () => {} });
    assert.deepEqual(await holds.authorize({ jobId: "A", amount: 1_000_000 }), { holdId: "int_9" });
    assert.deepEqual(asked, ["int_9"]);
  });

  test("a cancelled intent is refused, not used as a hold", async () => {
    stubFetch([
      { status: 200, body: { id: "int_8", client_secret: "s" } },
      { status: 200, body: { id: "int_8", status: "CANCELLED", amount: 1, currency: "USD" } },
    ]);
    const holds = new BrowserConfirmedHolds(gateway(), () => {}, { pollMs: 0, sleep: async () => {} });
    await assert.rejects(holds.authorize({ jobId: "A", amount: 1_000_000 }), /not placed/);
  });
});
