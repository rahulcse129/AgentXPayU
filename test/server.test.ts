import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createEngineServer, type Meta } from "../src/server/main.ts";
import type { RunSummary, SessionMessage } from "../src/server/session.ts";

/** Runs the engine server offline, fast, on a random port. */
async function engine() {
  const { server } = createEngineServer({ PACE_SCALE: "0", APPROVAL_TIMEOUT_MS: "5000" });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  return { server, base, post };
}

/** Reads the SSE stream, calls onMessage for each message, resolves when the run finishes. */
async function follow(base: string, onMessage: (m: SessionMessage) => void | Promise<void>): Promise<SessionMessage[]> {
  const res = await fetch(`${base}/api/stream`);
  const reader = res.body!.getReader();
  const seen: SessionMessage[] = [];
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return seen;
    buf += new TextDecoder().decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const m = JSON.parse(line.slice(6)) as SessionMessage;
      seen.push(m);
      await onMessage(m);
      if (m.kind === "run.finished" || m.kind === "run.failed") {
        await reader.cancel();
        return seen;
      }
    }
  }
}

test("a scripted dashboard run hits every beat and reconciles four ways", { timeout: 30_000 }, async () => {
  const { server, base, post } = await engine();
  try {
    const meta = (await (await fetch(`${base}/api/meta`)).json()) as Meta;
    assert.equal(meta.mode, "mock");
    assert.deepEqual(
      meta.rails.map((r) => [r.rail, r.source]),
      [
        ["Airwallex holds", "simulated"],
        ["Metal x402 payments", "simulated"],
        ["Metal mandates", "not built"],
        ["Metal clearing", "simulated"],
        ["LLM (judge, feed, report)", "off"],
      ],
    );

    const done = follow(base, async (m) => {
      // Beat 4: B's customer approves. Beat 5: a second customer declines.
      if (m.kind === "approval.requested") await post(m.jobId === "B" ? "/api/approve" : "/api/decline", { jobId: m.jobId });
    });
    const started = await post("/api/run", { scripted: true });
    assert.equal(started.status, 202);
    assert.equal((await post("/api/run", { scripted: true })).status, 409, "one run at a time");

    const seen = await done;
    const events = seen.flatMap((m) => (m.kind === "event" ? [m.event] : []));
    const types = new Set(events.map((e) => e.type));
    for (const t of ["fault.step_changed", "fault.provider_slowed", "payment.refused", "provider.blocked", "reserve.granted", "hold.incremented", "job.degraded", "hold.captured", "float.withdrawn"]) {
      assert.ok(types.has(t), `missing ${t}`);
    }
    const answers = events.filter((e) => e.type === "hold.increase_answer").map((e) => [e.jobId, e.data.answer]);
    assert.deepEqual(answers, [["B", "approved"], ["C", "declined"]]);

    const finished = seen.find((m) => m.kind === "run.finished") as { summary: RunSummary } | undefined;
    assert.ok(finished, JSON.stringify(seen.find((m) => m.kind === "run.failed")));
    const s = finished.summary;
    assert.deepEqual(s.violations, []);
    assert.equal(s.reconciled, true);
    assert.ok(s.totals.ledgerPaid > 0);
    for (const j of s.jobs) {
      assert.equal(j.ledgerPaid, j.railSettled);
      assert.equal(j.railSettled, j.clearingRedeemed);
      assert.equal(j.clearingRedeemed, j.captured);
      assert.ok(j.captured <= j.holdFinal);
      assert.equal(j.receipt.filter((r) => r.status === "paid").reduce((a, r) => a + r.paid, 0), j.ledgerPaid);
      for (const r of j.receipt) {
        if (r.status === "paid") {
          assert.ok(r.paid <= r.listPrice, "never above list price");
          assert.ok(r.txHash && r.clearingTotal !== undefined && r.why);
        }
      }
    }
    const b = s.jobs.find((j) => j.jobId === "B")!;
    assert.ok(b.holdFinal > b.holdInitial, "B's hold was raised");
    const c = s.jobs.find((j) => j.jobId === "C")!;
    assert.equal(c.holdFinal, c.holdInitial, "C declined: hold unchanged");
    assert.equal(c.status, "budget_limited");
    assert.ok(s.jobs.some((j) => j.receipt.some((r) => r.status === "refused" && r.providerId === "model-bargain")));
  } finally {
    server.close();
  }
});

test("controls: mandate test is honestly unavailable; others need a run; approvals need a pending request", async () => {
  const { server, post } = await engine();
  try {
    const mandate = await post("/api/control", { action: "mandate_test" });
    assert.equal(mandate.status, 501);
    assert.match(((await mandate.json()) as { message: string }).message, /not built/);
    assert.equal((await post("/api/control", { action: "slow_lite" })).status, 409);
    assert.equal((await post("/api/control", { action: "drop_tables" })).status, 400);
    assert.equal((await post("/api/approve", { jobId: "B" })).status, 404);
  } finally {
    server.close();
  }
});
