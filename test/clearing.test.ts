import { test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../src/money.ts";
import { ClearingEmulator } from "../src/clearing/emulator.ts";
import { ClearingViolation } from "../src/clearing/port.ts";
import { EMULATOR_TEST_KEY, Eip712Signer, HmacSigner } from "../src/clearing/signer.ts";
import { clearingFromEnv } from "../src/clearing/config.ts";

const A = "0x11111111111111111111111111111111111111a1";
const B = "0x11111111111111111111111111111111111111b1";
const emu = () => new ClearingEmulator(new HmacSigner());

test("EIP-712 signer: signature verifies, and any field change breaks it", async () => {
  const s = new Eip712Signer(EMULATOR_TEST_KEY);
  const m = { jobKey: "J", payee: A, cumulative: cents(7), epoch: 3 };
  const sig = await s.sign(m);
  assert.match(sig, /^0x[0-9a-f]{130}$/);
  assert.equal(await s.verify(m, sig), true);
  assert.equal(await s.verify({ ...m, cumulative: cents(8) }, sig), false);
  assert.equal(await s.verify({ ...m, payee: B }, sig), false);
  assert.equal(await s.verify({ ...m, epoch: 4 }, sig), false);
  assert.equal(await new Eip712Signer(`0x${"1".repeat(64)}`).verify(m, sig), false);
});

test("a later running total supersedes an earlier one; redemption pays only the difference", async () => {
  const c = emu();
  await c.openDeposit("J", cents(50));
  await c.signRunningTotal("J", A, cents(2));
  await c.signRunningTotal("J", A, cents(5));
  const e1 = await c.closeEpoch();
  assert.deepEqual((await c.settle(e1)).map((r) => [r.cumulative, r.amount]), [[cents(5), cents(5)]]);
  await c.signRunningTotal("J", A, cents(9));
  const e2 = await c.closeEpoch();
  assert.deepEqual((await c.settle(e2)).map((r) => [r.cumulative, r.amount]), [[cents(9), cents(4)]]);
  assert.deepEqual(await c.withdraw("J"), { amount: cents(41) });
  assert.deepEqual(c.status("J"), { deposited: cents(50), redeemed: cents(9), withdrawn: cents(41), final: true });
});

test("resending the same total returns the original signed statement and pays nothing extra", async () => {
  const c = emu();
  await c.openDeposit("J", cents(50));
  const a = await c.signRunningTotal("J", A, cents(3));
  const b = await c.signRunningTotal("J", A.toUpperCase().replace("0X", "0x"), cents(3));
  assert.deepEqual(a, b);
  assert.equal(c.signed.length, 1);
  await c.settle(await c.closeEpoch());
  await c.settle(await c.closeEpoch());
  assert.equal(c.redemptions.length, 1);
  assert.equal(c.status("J")!.redeemed, cents(3));
});

test("totals across payees never exceed the deposit; raising the deposit makes room", async () => {
  const c = emu();
  await c.openDeposit("J", cents(10));
  await c.signRunningTotal("J", A, cents(6));
  await assert.rejects(c.signRunningTotal("J", B, cents(5)), ClearingViolation);
  await c.raiseDeposit("J", cents(11));
  await c.signRunningTotal("J", B, cents(5));
  assert.equal(c.violations.length, 1);
});

test("rule breaks are refused and recorded", async () => {
  const c = emu();
  await c.openDeposit("J", cents(10));
  await assert.rejects(c.openDeposit("J", cents(10)), /second deposit/);
  await c.signRunningTotal("J", A, cents(4));
  await assert.rejects(c.signRunningTotal("J", A, cents(3)), /went down/);
  await assert.rejects(c.raiseDeposit("J", cents(10)), /not above/);
  await assert.rejects(c.settle(c.currentEpoch), /open epoch/);
  await assert.rejects(c.withdraw("J"), /before epoch 1 settled/);
  await assert.rejects(c.signRunningTotal("nope", A, 1), /no deposit/);
  assert.equal(c.violations.length, 6);
});

test("withdrawal waits for every epoch the job signed in; no signing after withdrawal", async () => {
  const c = emu();
  await c.openDeposit("J", cents(10));
  await c.settle(await c.closeEpoch());
  await c.signRunningTotal("J", A, cents(1)); // epoch 2, still open
  await assert.rejects(c.withdraw("J"), /before epoch 2 settled/);
  const e = await c.closeEpoch();
  await c.settle(e);
  await assert.rejects(c.settle(e), /settled twice/);
  await c.withdraw("J");
  await assert.rejects(c.signRunningTotal("J", A, cents(2)), /after its deposit was withdrawn/);
  await assert.rejects(c.withdraw("J"), /second withdrawal/);
});

test("a total signed after an epoch closed waits for the next epoch", async () => {
  const c = emu();
  await c.openDeposit("J", cents(10));
  const e1 = await c.closeEpoch();
  await c.signRunningTotal("J", A, cents(1));
  assert.equal((await c.settle(e1)).length, 0);
  assert.equal((await c.settle(await c.closeEpoch())).length, 1);
});

test("a tampered signature is not redeemed", async () => {
  const c = new ClearingEmulator(new Eip712Signer(EMULATOR_TEST_KEY));
  await c.openDeposit("J", cents(10));
  const t = await c.signRunningTotal("J", A, cents(1));
  t.signature = `0x${"ab".repeat(65)}`;
  assert.equal((await c.settle(await c.closeEpoch())).length, 0);
  assert.match(c.violations[0]!, /bad signature/);
});

test("CLEARING_MODE selects the emulator, refuses live, and can be turned off", () => {
  assert.equal(clearingFromEnv({})?.source, "simulated");
  assert.equal(clearingFromEnv({ CLEARING_MODE: "emulator" })?.source, "simulated");
  assert.equal(clearingFromEnv({ CLEARING_MODE: "off" }), undefined);
  assert.throws(() => clearingFromEnv({ CLEARING_MODE: "live" }), /not available to builders on testnet/);
});
