import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, usd } from "../src/money.ts";
import { CATALOG } from "../src/policy/catalog.ts";
import { DEFAULT_POLICY } from "../src/policy/types.ts";
import { Ledger, MemoryStore } from "../src/ledger/ledger.ts";
import { InsufficientFloat, PaymentRefused } from "../src/payments/types.ts";
import { MandateRefused, MockMandateGateway, parseCliOutput } from "../src/payments/mandate.ts";
import { MandateManager } from "../src/payments/mandate-manager.ts";
import { toUsdzCents } from "../src/payments/mandate-money.ts";

const LITE = CATALOG.find((p) => p.id === "model-lite")!.payTo;
const STD = CATALOG.find((p) => p.id === "model-std")!.payTo;
const ROGUE_ADDR = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";

const manager = (cap = DEFAULT_POLICY.maxHold) => {
  const ledger = new Ledger(new MemoryStore());
  const gw = new MockMandateGateway();
  return { ledger, gw, m: new MandateManager(gw, CATALOG, cap).attach(ledger) };
};
const pay = (m: MandateManager, key: string, payTo: string, amount: number) => m.pay({ idempotencyKey: key, payTo, amount, asset: "USDZ" });

// ---------------------------------------------------------------- amounts and CLI output

test("mandate amounts are written to the cent, and anything finer is refused, not rounded", () => {
  assert.equal(toUsdzCents(cents(5)), "0.05");
  assert.equal(toUsdzCents(usd(1.5)), "1.50");
  assert.equal(toUsdzCents(usd(3)), "3.00");
  assert.equal(toUsdzCents(0), "0.00");
  assert.throws(() => toUsdzCents(15_000), PaymentRefused);
  assert.throws(() => toUsdzCents(-1));
});

test("metal-agent's key-value output parses, as printed by `mandate credential create` 0.3.3", () => {
  // Captured from a real (offline) run of the CLI with a throwaway key.
  const out = [
    "credential C:/tmp/m1.json",
    "mandate 0x81d9a0c8d6239cda0e95fe9a0825e5334cd2e2266285895225f96bf858d21fe9",
    "per-payment-cap 3 *USDZ",
    "budget 1.5 *USDZ until expiry",
    "payee 0x11111111111111111111111111111111111111A1 model-lite",
    "payee 0x11111111111111111111111111111111111111A2 model-std",
    "mandate-key-file C:/tmp/m1.key.json (created)",
  ].join("\n");
  const kv = parseCliOutput(out);
  assert.equal(kv.get("mandate"), "0x81d9a0c8d6239cda0e95fe9a0825e5334cd2e2266285895225f96bf858d21fe9");
  assert.equal(kv.get("payee"), "0x11111111111111111111111111111111111111A1 model-lite", "first value kept");
  assert.equal(kv.get("mandate-key-file"), "C:/tmp/m1.key.json (created)");
});

// ---------------------------------------------------------------- the mandate's rules

test("the simulated mandate enforces payee allowlist, per-payment cap, budget and revocation", async () => {
  const { m, gw } = manager(cents(30));
  await m.deposit(cents(50));
  await assert.rejects(pay(m, "k1", ROGUE_ADDR, cents(1)), /not on the mandate's payee list/);
  await assert.rejects(pay(m, "k2", LITE, cents(31)), /per-payment cap/);
  await pay(m, "k3", LITE, cents(30));
  await assert.rejects(pay(m, "k4", STD, cents(21)), InsufficientFloat, "float accounting catches it first");
  await m.close();
  await assert.rejects(gw.pull({ paymentId: "k5", payTo: LITE, amount: cents(1) }), /revoked/);
  assert.equal(gw.metal.totalSettled(), cents(30), "only the allowed payment moved");
});

test("a mandate refusal is a PaymentRefused (the engine records it and reroutes), and is logged", async () => {
  const { m, ledger } = manager();
  await m.deposit(cents(50));
  const err = await pay(m, "k1", ROGUE_ADDR, cents(1)).catch((e) => e);
  assert.ok(err instanceof MandateRefused && err instanceof PaymentRefused);
  const ev = ledger.events().find((e) => e.type === "mandate.refused");
  assert.equal(ev?.data.payTo, ROGUE_ADDR);
  assert.equal(ev?.data.source, "simulated");
});

test("the mandate's own budget refuses past it, even if our float accounting were wrong", async () => {
  const gw = new MockMandateGateway();
  await gw.open({ payees: [{ address: LITE }], perPaymentCap: cents(50), budget: cents(10) });
  await gw.pull({ paymentId: "a", payTo: LITE, amount: cents(8) });
  await assert.rejects(gw.pull({ paymentId: "b", payTo: LITE, amount: cents(3) }), /exceed the budget/);
});

test("a repeated payment id pays once; the same id with another amount is refused by the manager", async () => {
  const { m, gw } = manager();
  await m.deposit(cents(50));
  const a = await pay(m, "k", LITE, cents(4));
  const b = await pay(m, "k", LITE, cents(4));
  assert.equal(a.txHash, b.txHash);
  assert.equal(gw.metal.totalSettled(), cents(4));
  await assert.rejects(pay(m, "k", LITE, cents(5)), /different payload/);
});

// ---------------------------------------------------------------- lifecycle

test("lifecycle: open on deposit, raise after a hold increase, revoke on close, all in the ledger", async () => {
  const { m, ledger, gw } = manager();
  await m.deposit(usd(1.5));
  assert.equal(m.active?.budget, usd(1.5));
  assert.equal(m.active?.payees.length, CATALOG.length);
  await m.onHoldIncreased("B", cents(75), cents(124));
  assert.equal(m.active?.budget, usd(1.5) + cents(49));
  await m.onHoldIncreased("B", cents(124), cents(124));
  assert.equal(m.active?.budget, usd(1.5) + cents(49), "no raise without an increase");
  await m.close();
  assert.equal(await m.close(), "", "closing twice is a no-op");
  assert.deepEqual(
    ledger.events().map((e) => e.type),
    ["mandate.opened", "mandate.raised", "mandate.revoked"],
  );
  // Revoking returns the unspent budget, so the simulated float is conserved.
  assert.equal(gw.metal.deposited, gw.metal.withdrawn + gw.metal.totalSettled());
});

test("a second deposit raises the open mandate instead of opening another", async () => {
  const { m, ledger } = manager();
  await m.deposit(cents(10));
  await m.deposit(cents(5));
  assert.equal(m.active?.budget, cents(15));
  assert.equal(await m.balance(), cents(15));
  assert.equal(ledger.events().filter((e) => e.type === "mandate.opened").length, 1);
});
