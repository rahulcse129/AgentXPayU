/**
 * Recovery of live-card dashboard runs: a crash leaves the run's SQLite ledger behind, and the next
 * engine start sweeps it (src/server/recover.ts). Card holds here are a fake that records calls.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger/ledger.ts";
import { SqliteStore } from "../src/ledger/sqlite.ts";
import { openRunLedger, RUN_RAILS_EVENT, sweepRunLedgers, type PaymentRail } from "../src/server/recover.ts";
import type { HoldGateway } from "../src/payments/types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "margin-recover-"));
  dirs.push(d);
  return d;
};

class FakeHolds implements HoldGateway {
  readonly source = "live" as const;
  calls: string[] = [];
  async authorize(): Promise<{ holdId: string }> {
    throw new Error("not used");
  }
  async increment() {}
  async capture(holdId: string, amount: number) {
    this.calls.push(`capture ${holdId} ${amount}`);
  }
  async cancel(holdId: string) {
    this.calls.push(`cancel ${holdId}`);
  }
}

/** A run that crashed mid-job: hold authorized, some payments paid, maybe one left pending. */
function crashedRun(dir: string, tag: string, rail: PaymentRail, opts: { paid: number[]; pending?: number }) {
  const store = openRunLedger(dir, tag);
  const ledger = new Ledger(store);
  ledger.log(null, RUN_RAILS_EVENT, { runTag: tag, holds: "airwallex", payments: rail });
  ledger.recordHold("A", `int_${tag}`, 1_000_000);
  opts.paid.forEach((amount, i) => {
    const key = `A:step${i}:p`;
    ledger.beginPayment({ key, jobId: "A", stepId: `step${i}`, providerId: "p", payTo: "0x1", amount });
    ledger.markPaid(key, `0xtx${i}`);
  });
  if (opts.pending) ledger.beginPayment({ key: "A:last:p", jobId: "A", stepId: "last", providerId: "p", payTo: "0x1", amount: opts.pending });
  store.close(); // the process dies here
}

describe("sweepRunLedgers", () => {
  test("captures what a crashed run spent, once, and the next start finds nothing to do", async () => {
    const dir = tempDir();
    crashedRun(dir, "r1", "simulated", { paid: [20_000, 240_000] });
    const holds = new FakeHolds();
    const r = await sweepRunLedgers({ dir, holds, log: () => {} });
    assert.deepEqual(holds.calls, ["capture int_r1 260000"]);
    assert.equal(r.captured, 1);

    const again = await sweepRunLedgers({ dir, holds, log: () => {} });
    assert.equal(again.captured + again.cancelled, 0);
    assert.equal(holds.calls.length, 1);

    const store = new SqliteStore(join(dir, "r1.db"));
    assert.equal(store.getHold("A")?.status, "captured");
    store.close();
  });

  test("cancels a hold when nothing was spent", async () => {
    const dir = tempDir();
    crashedRun(dir, "r2", "simulated", { paid: [] });
    const holds = new FakeHolds();
    await sweepRunLedgers({ dir, holds, log: () => {} });
    assert.deepEqual(holds.calls, ["cancel int_r2"]);
  });

  test("simulated rail: a payment pending at the crash moved no money and is not captured", async () => {
    const dir = tempDir();
    crashedRun(dir, "r3", "simulated", { paid: [30_000], pending: 150_000 });
    const holds = new FakeHolds();
    await sweepRunLedgers({ dir, holds, log: () => {} });
    assert.deepEqual(holds.calls, ["capture int_r3 30000"]);
  });

  test("x402 rail: a pending payment the chain says settled is captured too", async () => {
    const dir = tempDir();
    crashedRun(dir, "r4", "x402", { paid: [30_000], pending: 150_000 });
    const holds = new FakeHolds();
    const x402Lookup = { lookup: async (key: string) => (key === "A:last:p" ? { txHash: "0xsettled", amount: 150_000 } : null) };
    await sweepRunLedgers({ dir, holds, x402Lookup, log: () => {} });
    assert.deepEqual(holds.calls, ["capture int_r4 180000"]);
  });

  test("mandate rail: a pending payment cannot be resolved after a restart, so the hold is left open and reported", async () => {
    const dir = tempDir();
    crashedRun(dir, "r5", "mandate", { paid: [30_000], pending: 150_000 });
    const holds = new FakeHolds();
    const r = await sweepRunLedgers({ dir, holds, log: () => {} });
    assert.deepEqual(holds.calls, []);
    assert.equal(r.skipped, 1);
    assert.match(r.errors[0]!, /r5 A: 1 pending payment\(s\) unresolved/);
  });

  test("a missing folder is fine: nothing to sweep", async () => {
    const r = await sweepRunLedgers({ dir: join(tempDir(), "nope"), holds: new FakeHolds(), log: () => {} });
    assert.equal(r.files, 0);
  });
});
