import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { USDZ } from "@metalntwx/metal-pay";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { cents } from "../src/money.ts";
import { InsufficientFloat, TransientError } from "../src/payments/types.ts";
import {
  METAL_TESTNET,
  METAL_TESTNET_CHAIN_ID,
  MetalFloatGateway,
  PaymentRefused,
  fromBaseUnits,
  nonceFor,
  toBaseUnits,
  type MetalChain,
  type Settler,
} from "../src/payments/metal.ts";

// Hardhat/Anvil test key #0: public, worthless, used only against the fakes below.
const PK: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PAYEE = "0x11111111111111111111111111111111111111a2";
const NOW = 1_793_485_000_000;

/** A chain that knows which (payer, nonce) pairs settled, and in which tx, for how much. */
class FakeChain implements MetalChain {
  used = new Map<string, { txHash: Hex; value: bigint }>();
  wallet = toBaseUnits(cents(500));
  blockTime = NOW / 1000;
  id = METAL_TESTNET_CHAIN_ID;
  async chainId() {
    return this.id;
  }
  async latestBlockTime() {
    return this.blockTime;
  }
  async balanceOf() {
    return this.wallet;
  }
  async authorizationUsed(_p: Hex, nonce: Hex) {
    return this.used.has(nonce);
  }
  async findSettlement(_p: Hex, nonce: Hex) {
    return this.used.get(nonce) ?? null;
  }
}

/** A facilitator that settles (marking the nonce used on the fake chain) unless told otherwise. */
class FakeSettler implements Settler {
  calls: { payload: any; req: any }[] = [];
  next: "ok" | "timeout" | "timeout_after_settle" | { refuse: string } = "ok";
  private n = 0;
  constructor(private readonly chain: FakeChain) {}
  async settle(payload: any, req: any) {
    this.calls.push({ payload, req });
    const mode = this.next;
    const nonce = payload.payload.authorization.nonce as Hex;
    if (mode === "timeout") throw new FacilitatorTimeoutError("settle", 60_000);
    if (typeof mode === "object") return { success: false, errorReason: mode.refuse };
    if (this.chain.used.has(nonce)) return { success: false, errorReason: "nonce_already_used" };
    const txHash = `0x${(++this.n).toString(16).padStart(64, "0")}` as Hex;
    this.chain.used.set(nonce, { txHash, value: BigInt(payload.payload.authorization.value) });
    if (mode === "timeout_after_settle") throw new FacilitatorTimeoutError("settle", 60_000);
    return { success: true, transaction: txHash };
  }
}

function world(opts: { skew?: number } = {}) {
  const chain = new FakeChain();
  const settler = new FakeSettler(chain);
  const gw = new MetalFloatGateway({ privateKey: PK, chain, settler, now: () => NOW + (opts.skew ?? 0) * 1000 });
  return { chain, settler, gw };
}

const pay = (gw: MetalFloatGateway, key = "J:s1:model-std:1", amount = cents(4), payTo = PAYEE) =>
  gw.pay({ idempotencyKey: key, payTo, amount, asset: "USDZ" });

// ---------------------------------------------------------------- units and nonces

test("micros convert to 18-decimal USDZ base units exactly, and back", () => {
  assert.equal(toBaseUnits(cents(1)), 10_000_000_000_000_000n);
  assert.equal(fromBaseUnits(10_000_000_000_000_000n), cents(1));
  assert.throws(() => fromBaseUnits(10_000_000_000_000_001n), /not a whole number of micros/);
});

test("the nonce is a pure function of the idempotency key", () => {
  assert.equal(nonceFor("J:s1:p:1"), nonceFor("J:s1:p:1"));
  assert.notEqual(nonceFor("J:s1:p:1"), nonceFor("J:s1:p:2"));
  assert.match(nonceFor("x"), /^0x[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- the x402 payload

test("pay sends an exact-scheme x402 payment whose EIP-3009 signature verifies for our address", async () => {
  const { gw, settler } = world();
  await gw.deposit(cents(100));
  const { txHash } = await pay(gw);
  assert.match(txHash, /^0x/);
  const { payload, req } = settler.calls[0]!;
  assert.deepEqual(req, {
    scheme: "exact",
    network: METAL_TESTNET,
    asset: USDZ.address,
    amount: toBaseUnits(cents(4)).toString(),
    payTo: getAddress(PAYEE),
    maxTimeoutSeconds: 120,
    extra: { name: "USD Zero", version: "1", primaryType: "TransferWithAuthorization" },
  });
  assert.equal(payload.x402Version, 2);
  assert.deepEqual(payload.accepted, req);
  const a = payload.payload.authorization;
  assert.equal(a.from, gw.address);
  assert.equal(a.to, getAddress(PAYEE));
  assert.equal(a.nonce, nonceFor("J:s1:model-std:1"));
  assert.equal(a.validAfter, "0");
  assert.equal(Number(a.validBefore), NOW / 1000 + 120);
  const ok = await verifyTypedData({
    address: gw.address,
    domain: { name: "USD Zero", version: "1", chainId: METAL_TESTNET_CHAIN_ID, verifyingContract: USDZ.address },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: 0n, validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: payload.payload.signature,
  });
  assert.equal(ok, true);
});

// ---------------------------------------------------------------- never twice

test("a repeated key returns the first settlement and asks the facilitator nothing", async () => {
  const { gw, settler } = world();
  await gw.deposit(cents(100));
  const a = await pay(gw);
  const b = await pay(gw);
  assert.equal(a.txHash, b.txHash);
  assert.equal(settler.calls.length, 1);
  assert.equal(await gw.balance(), cents(96));
});

test("a repeated key with a different amount or payee is refused", async () => {
  const { gw } = world();
  await gw.deposit(cents(100));
  await pay(gw);
  await assert.rejects(pay(gw, undefined, cents(5)), /different payload/);
  await assert.rejects(pay(gw, undefined, cents(4), "0x11111111111111111111111111111111111111b1"), /different payload/);
});

test("after a crash, a new process finds the payment on chain and does not pay again", async () => {
  const { gw, settler, chain } = world();
  await gw.deposit(cents(100));
  const first = await pay(gw);
  const restarted = new MetalFloatGateway({ privateKey: PK, chain, settler, now: () => NOW });
  await restarted.deposit(cents(100));
  assert.deepEqual(await pay(restarted), first);
  assert.equal(settler.calls.length, 1);
  assert.deepEqual(await restarted.lookup("J:s1:model-std:1"), { txHash: first.txHash, amount: cents(4) });
});

test("a facilitator timeout is a TransientError; the retry finds the settlement instead of paying twice", async () => {
  const { gw, settler } = world();
  await gw.deposit(cents(100));
  settler.next = "timeout_after_settle";
  await assert.rejects(pay(gw), TransientError);
  settler.next = "ok";
  const retry = await pay(gw);
  assert.match(retry.txHash, /^0x/);
  assert.equal(settler.calls.length, 1, "the retry was answered from chain");
  assert.equal(await gw.balance(), cents(96));
});

test("a timeout before settling is also a TransientError, and the retry pays with the same nonce", async () => {
  const { gw, settler } = world();
  await gw.deposit(cents(100));
  settler.next = "timeout";
  await assert.rejects(pay(gw), TransientError);
  assert.equal(await gw.lookup("J:s1:model-std:1"), null);
  settler.next = "ok";
  await pay(gw);
  assert.equal(settler.calls.length, 2);
  assert.equal(settler.calls[0]!.payload.payload.authorization.nonce, settler.calls[1]!.payload.payload.authorization.nonce);
});

// ---------------------------------------------------------------- refusals and guards

test("a refusal that moved nothing is PaymentRefused; an insufficient-funds refusal is InsufficientFloat", async () => {
  const { gw, settler } = world();
  await gw.deposit(cents(100));
  settler.next = { refuse: "authorization_window" };
  await assert.rejects(pay(gw), PaymentRefused);
  settler.next = { refuse: "insufficient_funds" };
  await assert.rejects(pay(gw, "J:s2:x:1"), InsufficientFloat);
  assert.equal(await gw.balance(), cents(100));
});

test("pay refuses before signing when the local clock is far from chain time", async () => {
  const { gw, settler } = world({ skew: -106 });
  await gw.deposit(cents(100));
  await assert.rejects(pay(gw), /106s off Metal testnet/);
  assert.equal(settler.calls.length, 0);
});

test("pay refuses an RPC that is not Metal testnet", async () => {
  const { gw, chain, settler } = world();
  chain.id = 1;
  await gw.deposit(cents(100));
  await assert.rejects(pay(gw), /not Metal testnet/);
  assert.equal(settler.calls.length, 0);
});

test("float is accounting against the wallet: deposit is capped by the on-chain balance", async () => {
  const { gw, chain } = world();
  chain.wallet = toBaseUnits(cents(10));
  await gw.deposit(cents(10));
  await assert.rejects(gw.deposit(1), InsufficientFloat);
  await assert.rejects(pay(gw, "k", cents(11)), InsufficientFloat);
  await gw.withdraw(cents(10));
  assert.equal(await gw.balance(), 0);
});

test("only USDZ, only positive whole micros", async () => {
  const { gw } = world();
  await gw.deposit(cents(100));
  await assert.rejects(gw.pay({ idempotencyKey: "k", payTo: PAYEE, amount: cents(1), asset: "USDC" }), /USDZ only/);
  await assert.rejects(gw.pay({ idempotencyKey: "k", payTo: PAYEE, amount: 0, asset: "USDZ" }), /invalid amount/);
});
