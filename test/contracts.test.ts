/**
 * Adapter contract tests. The same suite runs against the mock and the live adapter;
 * live runs are skipped unless their env keys are present (see .env.example).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cents } from "../src/money.ts";
import { InsufficientFloat, type FloatGateway, type HoldGateway } from "../src/payments/types.ts";
import { MockMetal } from "../src/payments/mock-metal.ts";
import { MockMandateGateway } from "../src/payments/mandate.ts";
import { MandateManager } from "../src/payments/mandate-manager.ts";
import { CATALOG } from "../src/policy/catalog.ts";
import { DEFAULT_POLICY } from "../src/policy/types.ts";
import { MetalFloatGateway } from "../src/payments/metal.ts";
import { MockAirwallex } from "../src/payments/mock-airwallex.ts";
import { AirwallexHoldGateway } from "../src/payments/airwallex.ts";

const PAYEE = "0x11111111111111111111111111111111111111a1";
const uniq = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function floatContract(name: string, make: () => FloatGateway, skip: string | false) {
  describe(`FloatGateway contract: ${name}`, { skip }, () => {
    test("deposit raises the balance", async () => {
      const g = make();
      const before = await g.balance();
      await g.deposit(cents(10));
      assert.equal(await g.balance(), before + cents(10));
    });

    test("pay is idempotent on the key: same tx, debited once", async () => {
      const g = make();
      await g.deposit(cents(10));
      const before = await g.balance();
      const key = `contract:${uniq()}`;
      const req = { idempotencyKey: key, payTo: PAYEE, amount: cents(1), asset: "USDZ" };
      const a = await g.pay(req);
      const b = await g.pay(req);
      assert.equal(a.txHash, b.txHash);
      assert.equal(await g.balance(), before - cents(1));
    });

    test("pay with a reused key and a different payload is refused", async () => {
      const g = make();
      await g.deposit(cents(10));
      const key = `contract:${uniq()}`;
      await g.pay({ idempotencyKey: key, payTo: PAYEE, amount: cents(1), asset: "USDZ" });
      await assert.rejects(g.pay({ idempotencyKey: key, payTo: PAYEE, amount: cents(2), asset: "USDZ" }));
    });

    test("lookup finds a settled key and returns null for an unknown one", async () => {
      const g = make();
      await g.deposit(cents(10));
      const key = `contract:${uniq()}`;
      const { txHash } = await g.pay({ idempotencyKey: key, payTo: PAYEE, amount: cents(1), asset: "USDZ" });
      assert.deepEqual(await g.lookup(key), { txHash, amount: cents(1) });
      assert.equal(await g.lookup(`contract:${uniq()}`), null);
    });

    test("paying more than the balance throws InsufficientFloat", async () => {
      const g = make();
      const bal = await g.balance();
      await assert.rejects(
        g.pay({ idempotencyKey: `contract:${uniq()}`, payTo: PAYEE, amount: bal + 1, asset: "USDZ" }),
        InsufficientFloat,
      );
    });

    test("withdraw lowers the balance", async () => {
      const g = make();
      await g.deposit(cents(5));
      const before = await g.balance();
      await g.withdraw(cents(5));
      assert.equal(await g.balance(), before - cents(5));
    });
  });
}

function holdContract(name: string, make: () => HoldGateway, skip: string | false) {
  describe(`HoldGateway contract: ${name}`, { skip }, () => {
    test("authorize → increment → partial capture", async () => {
      const g = make();
      const { holdId } = await g.authorize({ jobId: `c-${uniq()}`, amount: cents(75) });
      await g.increment(holdId, cents(124));
      await g.capture(holdId, cents(100));
    });

    test("authorize → cancel", async () => {
      const g = make();
      const { holdId } = await g.authorize({ jobId: `c-${uniq()}`, amount: cents(75) });
      await g.cancel(holdId, "nothing_spent");
    });

    test("capture above the authorized amount is rejected", async () => {
      const g = make();
      const { holdId } = await g.authorize({ jobId: `c-${uniq()}`, amount: cents(75) });
      await assert.rejects(g.capture(holdId, cents(76)));
      await g.cancel(holdId, "test cleanup");
    });

    test("a settled hold cannot be captured again", async () => {
      const g = make();
      const { holdId } = await g.authorize({ jobId: `c-${uniq()}`, amount: cents(75) });
      await g.capture(holdId, cents(10));
      await assert.rejects(g.capture(holdId, cents(10)));
    });
  });
}

const liveMetal = process.env.METAL_PRIVATE_KEY && process.env.METAL_RPC_URL;
const liveAirwallex = process.env.AIRWALLEX_CLIENT_ID && process.env.AIRWALLEX_API_KEY && process.env.AIRWALLEX_TEST_PAYMENT_METHOD;

floatContract("MockMetal", () => new MockMetal(), false);
floatContract("MandateManager (simulated mandate)", () => new MandateManager(new MockMandateGateway(), CATALOG, DEFAULT_POLICY.maxHold), false);
floatContract("MetalFloatGateway (testnet)", () => MetalFloatGateway.fromEnv(), liveMetal ? false : "set METAL_PRIVATE_KEY and METAL_RPC_URL");

holdContract("MockAirwallex", () => new MockAirwallex(), false);
holdContract(
  "AirwallexHoldGateway (sandbox)",
  () => {
    const g = AirwallexHoldGateway.fromEnv();
    // Sandbox runs confirm server-side with a test card so there is an authorized hold to act on.
    const pm = JSON.parse(process.env.AIRWALLEX_TEST_PAYMENT_METHOD!);
    return {
      authorize: (r) => g.authorize({ ...r, paymentMethod: pm }),
      increment: (id, t) => g.increment(id, t),
      capture: (id, a) => g.capture(id, a),
      cancel: (id, r) => g.cancel(id, r),
    };
  },
  liveAirwallex ? false : "set AIRWALLEX_CLIENT_ID, AIRWALLEX_API_KEY and AIRWALLEX_TEST_PAYMENT_METHOD",
);
