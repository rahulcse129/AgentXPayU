import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, floorToCent, ceilToCent, toMajor, assertMicros } from "../src/money.ts";
import { IdempotencyConflict, Ledger, MemoryStore, type LedgerStore } from "../src/ledger/ledger.ts";
import { SqliteStore } from "../src/ledger/sqlite.ts";

// ---------------------------------------------------------------- money

test("floorToCent never rounds up; ceilToCent never rounds down", () => {
  assert.equal(floorToCent(cents(3) + 9_999), cents(3));
  assert.equal(ceilToCent(cents(3) + 1), cents(4));
  assert.equal(floorToCent(cents(3)), cents(3));
});

test("toMajor converts whole cents to decimal major units", () => {
  assert.equal(toMajor(cents(124)), 1.24);
});

test("assertMicros rejects floats and negatives", () => {
  assert.throws(() => assertMicros(1.5));
  assert.throws(() => assertMicros(-1));
  assertMicros(0);
});

// ---------------------------------------------------------------- ledger, run against both stores

const stores: [string, () => LedgerStore][] = [
  ["MemoryStore", () => new MemoryStore()],
  ["SqliteStore", () => new SqliteStore(":memory:")],
];

const pay = { key: "J:s1:p:1", jobId: "J", stepId: "s1", providerId: "p", amount: cents(2), payTo: "0xabc" };

for (const [name, make] of stores) {
  test(`${name}: payment is pending before money moves, then paid`, () => {
    const l = new Ledger(make(), () => 1);
    const row = l.beginPayment(pay);
    assert.equal(row.status, "pending");
    assert.equal(l.inFlight("J"), cents(2));
    assert.equal(l.spent("J"), 0);
    l.markPaid(pay.key, "0xtx");
    assert.equal(l.inFlight("J"), 0);
    assert.equal(l.spent("J"), cents(2));
  });

  test(`${name}: a retry with the same payload resumes the row`, () => {
    const l = new Ledger(make());
    l.beginPayment(pay);
    const again = l.beginPayment(pay);
    assert.equal(again.attempts, 2);
    assert.equal(l.payments("J").length, 1);
  });

  test(`${name}: a retry with a different payload is an idempotency conflict`, () => {
    const l = new Ledger(make());
    l.beginPayment(pay);
    assert.throws(() => l.beginPayment({ ...pay, amount: cents(3) }), IdempotencyConflict);
    assert.throws(() => l.beginPayment({ ...pay, payTo: "0xdef" }), IdempotencyConflict);
  });

  test(`${name}: markPaid twice is a no-op; failing a paid payment throws`, () => {
    const l = new Ledger(make());
    l.beginPayment(pay);
    l.markPaid(pay.key, "0xtx");
    l.markPaid(pay.key, "0xother");
    assert.equal(l.payments()[0]!.txHash, "0xtx");
    assert.throws(() => l.markFailed(pay.key, "late"));
  });

  test(`${name}: a refusal is recorded once and moves no money`, () => {
    const l = new Ledger(make());
    const r = { jobId: "J", stepId: "s1", providerId: "rogue", quoted: cents(9), payTo: "0xdead", reason: "overquote" };
    l.recordRefusal(r);
    l.recordRefusal(r);
    assert.equal(l.payments("J").length, 1);
    assert.equal(l.payments("J")[0]!.status, "refused");
    assert.equal(l.spent("J"), 0);
    assert.equal(l.events("J").filter((e) => e.type === "payment.refused").length, 2);
  });

  test(`${name}: hold lifecycle authorize → increment → capture`, () => {
    const l = new Ledger(make());
    l.recordHold("J", "int_1", cents(75));
    l.recordIncrement("J", cents(124));
    l.recordCapture("J", cents(100));
    assert.deepEqual(l.hold("J"), { jobId: "J", holdId: "int_1", authorized: cents(124), captured: cents(100), status: "captured" });
    const types = l.events("J").map((e) => e.type);
    assert.deepEqual(types, ["hold.authorized", "hold.incremented", "hold.captured"]);
  });

  test(`${name}: cancel releases the whole hold`, () => {
    const l = new Ledger(make());
    l.recordHold("J", "int_1", cents(75));
    l.recordCancel("J", "nothing spent");
    assert.equal(l.hold("J")!.status, "cancelled");
  });
}

test("SqliteStore matches MemoryStore on the same sequence of operations", () => {
  const run = (store: LedgerStore) => {
    let t = 0;
    const l = new Ledger(store, () => ++t);
    l.recordHold("J", "int_1", cents(100));
    l.beginPayment(pay);
    l.markPaid(pay.key, "0x1");
    l.beginPayment({ ...pay, key: "J:s2:p:1", stepId: "s2" });
    l.markFailed("J:s2:p:1", "timeout");
    l.recordRefusal({ jobId: "J", stepId: "s3", providerId: "r", quoted: 5, payTo: "0xd", reason: "x" });
    l.recordCapture("J", cents(2));
    // JSON round-trip: SQLite returns absent optional columns as `undefined` keys, memory omits them.
    return JSON.parse(
      JSON.stringify({
        payments: l.payments().map(({ createdAt: _c, ...p }) => p).sort((a, b) => a.key.localeCompare(b.key)),
        hold: l.hold("J"),
        events: l.events().map(({ seq, type, jobId, data }) => ({ seq, type, jobId, data })),
      }),
    );
  };
  assert.deepEqual(run(new SqliteStore(":memory:")), run(new MemoryStore()));
});

test("SqliteStore rejects a capture above the authorized amount at the database level", () => {
  const s = new SqliteStore(":memory:");
  assert.throws(() => s.upsertHold({ jobId: "J", holdId: "h", authorized: 10, captured: 11, status: "captured" }));
});
