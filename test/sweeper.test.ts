import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../src/money.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import { SqliteStore } from "../src/ledger/sqlite.ts";
import { sweepOrphanedHolds } from "../src/ledger/sweeper.ts";
import { MockAirwallex } from "../src/payments/mock-airwallex.ts";
import { MockMetal } from "../src/payments/mock-metal.ts";
import { TransientError, type HoldGateway } from "../src/payments/types.ts";

/**
 * A "crash": the engine wrote holds and payments to a persistent ledger, then died. The holds
 * (MockAirwallex here, Airwallex intents in production) and the rail (MockMetal) outlive it.
 */
async function crashedWorld() {
  const store = new SqliteStore(":memory:");
  const ledger = new Ledger(store);
  const airwallex = new MockAirwallex();
  const metal = new MockMetal();
  await metal.deposit(cents(100));
  const hold = async (jobId: string, amount: number) => {
    const { holdId } = await airwallex.authorize({ jobId, amount });
    ledger.recordHold(jobId, holdId, amount);
    return holdId;
  };
  const paid = async (jobId: string, step: string, amount: number) => {
    const key = `${jobId}:${step}:p:1`;
    ledger.beginPayment({ key, jobId, stepId: step, providerId: "p", amount, payTo: "0xp" });
    const { txHash } = await metal.pay({ idempotencyKey: key, payTo: "0xp", amount, asset: "USDZ" });
    ledger.markPaid(key, txHash);
  };
  return { store, ledger, airwallex, metal, hold, paid };
}

const quiet = () => {};

test("captures exactly what each crashed job spent, and cancels a job that spent nothing", async () => {
  const w = await crashedWorld();
  const hA = await w.hold("A", cents(100));
  await w.paid("A", "s1", cents(12));
  await w.paid("A", "s2", 25_500); // 2.55¢: captured floored to the cent
  const hB = await w.hold("B", cents(75));
  const r = await sweepOrphanedHolds({ store: w.store, holds: w.airwallex, float: w.metal, log: quiet });
  assert.deepEqual([r.swept, r.captured, r.cancelled, r.skipped, r.errors.length], [2, 1, 1, 0, 0]);
  assert.equal(w.airwallex.holds.get(hA)!.captured, cents(14));
  assert.equal(w.airwallex.holds.get(hB)!.status, "cancelled");
  assert.equal(w.store.getHold("A")!.status, "captured");
  assert.equal(w.store.getHold("B")!.status, "cancelled");
  assert.deepEqual(w.airwallex.violations, []);
});

test("payments left pending are resolved from the rail before capturing: settled counts, unsettled does not", async () => {
  const w = await crashedWorld();
  const h = await w.hold("A", cents(100));
  // Crashed after the rail settled but before the ledger heard back:
  w.ledger.beginPayment({ key: "A:s1:p:1", jobId: "A", stepId: "s1", providerId: "p", amount: cents(7), payTo: "0xp" });
  await w.metal.pay({ idempotencyKey: "A:s1:p:1", payTo: "0xp", amount: cents(7), asset: "USDZ" });
  // Crashed before the rail saw it at all:
  w.ledger.beginPayment({ key: "A:s2:p:1", jobId: "A", stepId: "s2", providerId: "p", amount: cents(9), payTo: "0xp" });
  await sweepOrphanedHolds({ store: w.store, holds: w.airwallex, float: w.metal, log: quiet });
  assert.equal(w.airwallex.holds.get(h)!.captured, cents(7), "customer pays what the providers were paid");
  assert.equal(w.store.getPayment("A:s1:p:1")!.status, "paid");
  assert.equal(w.store.getPayment("A:s2:p:1")!.status, "failed");
});

test("without a rail to ask, a hold with pending payments is left open and reported, never guessed", async () => {
  const w = await crashedWorld();
  const h = await w.hold("A", cents(100));
  w.ledger.beginPayment({ key: "A:s1:p:1", jobId: "A", stepId: "s1", providerId: "p", amount: cents(7), payTo: "0xp" });
  const r = await sweepOrphanedHolds({ store: w.store, holds: w.airwallex, log: quiet });
  assert.equal(r.skipped, 1);
  assert.match(r.errors[0]!, /pending payment\(s\) unresolved/);
  assert.equal(w.airwallex.holds.get(h)!.status, "authorized");
  assert.ok(w.store.listEvents("A").some((e) => e.type === "hold.sweep_skipped"));
});

test("holds already captured or cancelled are left alone; a second sweep finds nothing", async () => {
  const w = await crashedWorld();
  await w.hold("A", cents(100));
  await w.paid("A", "s1", cents(5));
  await sweepOrphanedHolds({ store: w.store, holds: w.airwallex, float: w.metal, log: quiet });
  const again = await sweepOrphanedHolds({ store: w.store, holds: w.airwallex, float: w.metal, log: quiet });
  assert.equal(again.swept, 0);
  assert.deepEqual(w.airwallex.violations, [], "no double capture");
});

test("a transient capture error is retried; a permanent one is reported and the hold left for later", async () => {
  const w = await crashedWorld();
  const h = await w.hold("A", cents(100));
  await w.paid("A", "s1", cents(5));
  let fails = 1;
  const flaky: HoldGateway = {
    authorize: (r) => w.airwallex.authorize(r),
    increment: (id, t) => w.airwallex.increment(id, t),
    cancel: (id, why) => w.airwallex.cancel(id, why),
    capture: async (id, amount) => {
      if (fails-- > 0) throw new TransientError("airwallex 503");
      return w.airwallex.capture(id, amount);
    },
  };
  const r = await sweepOrphanedHolds({ store: w.store, holds: flaky, float: w.metal, log: quiet, retryDelayMs: 1 });
  assert.equal(r.captured, 1);
  assert.equal(w.airwallex.holds.get(h)!.captured, cents(5));

  const w2 = await crashedWorld();
  await w2.hold("B", cents(50));
  await w2.paid("B", "s1", cents(5));
  const broken: HoldGateway = { ...flaky, capture: async () => { throw new Error("intent not found"); } };
  const r2 = await sweepOrphanedHolds({ store: w2.store, holds: broken, float: w2.metal, log: quiet, retryDelayMs: 1 });
  assert.equal(r2.errors.length, 1);
  assert.equal(w2.store.getHold("B")!.status, "authorized");
});
