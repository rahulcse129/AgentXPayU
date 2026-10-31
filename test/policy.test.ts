import { test } from "node:test";
import assert from "node:assert/strict";
import { cents, usd } from "../src/money.ts";
import { CATALOG, providerById } from "../src/policy/catalog.ts";
import {
  allocateReserve,
  chooseProvider,
  degradePlan,
  eligibleProviders,
  estimateRemaining,
  freshHealth,
  headroom,
  planHoldIncrease,
  recordLatency,
  recordQuality,
  recordQuoteViolation,
  shouldEscalate,
  splitFloat,
  stepCost,
  verifyQuote,
} from "../src/policy/policy.ts";
import { DEFAULT_POLICY, type ProviderHealth, type Step } from "../src/policy/types.ts";

const health = (): Map<string, ProviderHealth> => new Map(CATALOG.map((p) => [p.id, freshHealth(p)]));
const model = (units: number, extra: Partial<Step> = {}): Step => ({ id: "m", kind: "model", units, minTier: 1, maxLatencyMs: 1000, ...extra });
const search: Step = { id: "s", kind: "search", units: 1, minTier: 2, maxLatencyMs: 1000 };
const budget = (hold: number, spent = 0, inFlight = 0) => ({ holdAmount: hold, spent, inFlight });
const noRogue = CATALOG.filter((p) => p.id !== "model-bargain");

// ---------------------------------------------------------------- budget

test("headroom subtracts spent and in-flight", () => {
  assert.equal(headroom(budget(cents(100), cents(30), cents(20))), cents(50));
});

test("stepCost is price times units", () => {
  assert.equal(stepCost(providerById("model-std"), model(7)), cents(14));
});

// ---------------------------------------------------------------- chooseProvider

test("chooseProvider picks the cheapest fast provider", () => {
  const r = chooseProvider({ step: model(3), budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: health() });
  assert.ok(r.ok);
  assert.equal(r.provider.id, "model-lite");
  assert.equal(r.cost, cents(3));
});

test("chooseProvider accepts a cost exactly equal to headroom and float", () => {
  const r = chooseProvider({ step: model(3), budget: budget(cents(3)), floatAvailable: cents(3), providers: noRogue, health: health() });
  assert.ok(r.ok);
  assert.equal(r.cost, cents(3));
});

test("chooseProvider one micro short of headroom is over_hold", () => {
  const r = chooseProvider({ step: model(3), budget: budget(cents(3) - 1), floatAvailable: usd(1), providers: noRogue, health: health() });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === "over_hold" && r.cheapestCost === cents(3));
});

test("chooseProvider with zero float reports over_float", () => {
  const r = chooseProvider({ step: model(1), budget: budget(usd(1)), floatAvailable: 0, providers: noRogue, health: health() });
  assert.ok(!r.ok && r.reason === "over_float");
});

test("chooseProvider respects minimum tier", () => {
  const r = chooseProvider({ step: model(2, { minTier: 2 }), budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: health() });
  assert.ok(r.ok && r.provider.id === "model-std");
  assert.ok(r.rejected.some((x) => x.id === "model-lite" && x.why === "tier_too_low"));
});

test("chooseProvider skips blocked and excluded providers", () => {
  const h = health();
  h.set("model-lite", { ...h.get("model-lite")!, blocked: true });
  const r = chooseProvider({ step: model(1), budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: h, exclude: new Set(["model-std"]) });
  assert.ok(r.ok && r.provider.id === "model-premium");
  assert.ok(r.rejected.some((x) => x.id === "model-lite" && x.why === "blocked"));
});

test("chooseProvider prefers a fast provider over a cheaper slow one", () => {
  const h = health();
  h.set("model-lite", { ...h.get("model-lite")!, latencyEmaMs: 2500 });
  const r = chooseProvider({ step: model(2), budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: h });
  assert.ok(r.ok && r.provider.id === "model-std");
  assert.match(r.reason, /skipped slow: model-lite/);
});

test("chooseProvider falls back to a slow provider when no fast one fits", () => {
  const h = health();
  h.set("model-lite", { ...h.get("model-lite")!, latencyEmaMs: 2500 });
  const r = chooseProvider({ step: model(2), budget: budget(cents(3)), floatAvailable: usd(1), providers: noRogue, health: h });
  assert.ok(r.ok && r.provider.id === "model-lite");
  assert.match(r.reason, /accepting a slower one/);
});

test("chooseProvider with all providers slow still returns the cheapest that fits", () => {
  const h = health();
  for (const p of noRogue) h.set(p.id, { ...freshHealth(p), latencyEmaMs: 9999 });
  const r = chooseProvider({ step: model(1), budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: h });
  assert.ok(r.ok && r.provider.id === "model-lite");
});

test("chooseProvider tie on price breaks by latency", () => {
  // model-lite and model-bargain are both 1¢; give bargain lower latency.
  const h = health();
  h.set("model-bargain", { ...h.get("model-bargain")!, latencyEmaMs: 100 });
  const r = chooseProvider({ step: model(1), budget: budget(usd(1)), floatAvailable: usd(1), providers: CATALOG, health: h });
  assert.ok(r.ok && r.provider.id === "model-bargain");
});

test("chooseProvider with no capable provider is no_provider", () => {
  const r = chooseProvider({ step: search, budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: health(), exclude: new Set(["search"]) });
  assert.ok(!r.ok && r.reason === "no_provider");
});

test("eligibleProviders honours minTierOverride", () => {
  const e = eligibleProviders({ step: model(1), budget: budget(usd(1)), floatAvailable: usd(1), providers: noRogue, health: health(), minTierOverride: 3 });
  assert.deepEqual(e.fast.map((p) => p.id), ["model-premium"]);
});

// ---------------------------------------------------------------- verifyQuote

const std = providerById("model-std");
const quote = (over: Partial<{ amount: number; asset: string; payTo: string }> = {}) => ({
  amount: stepCost(std, model(2)),
  asset: "USDZ",
  payTo: std.payTo,
  nonce: "k",
  ...over,
});

test("verifyQuote accepts list price", () => {
  assert.deepEqual(verifyQuote(quote(), std, model(2), DEFAULT_POLICY), { ok: true });
});

test("verifyQuote accepts an underquote", () => {
  assert.deepEqual(verifyQuote(quote({ amount: 1 }), std, model(2), DEFAULT_POLICY), { ok: true });
});

test("verifyQuote accepts a payee address in a different case", () => {
  assert.deepEqual(verifyQuote(quote({ payTo: std.payTo.toUpperCase().replace("0X", "0x") }), std, model(2), DEFAULT_POLICY), { ok: true });
});

test("verifyQuote refuses one micro over list", () => {
  const r = verifyQuote(quote({ amount: stepCost(std, model(2)) + 1 }), std, model(2), DEFAULT_POLICY);
  assert.ok(!r.ok && r.reason === "overquote");
});

test("verifyQuote refuses negative and fractional amounts", () => {
  assert.ok(!verifyQuote(quote({ amount: -1 }), std, model(2), DEFAULT_POLICY).ok);
  assert.ok(!verifyQuote(quote({ amount: 1.5 }), std, model(2), DEFAULT_POLICY).ok);
});

test("verifyQuote refuses a wrong payee", () => {
  const r = verifyQuote(quote({ payTo: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" }), std, model(2), DEFAULT_POLICY);
  assert.ok(!r.ok && r.reason === "wrong_payee");
});

test("verifyQuote refuses a wrong asset", () => {
  const r = verifyQuote(quote({ asset: "USDC" }), std, model(2), DEFAULT_POLICY);
  assert.ok(!r.ok && r.reason === "wrong_asset");
});

// ---------------------------------------------------------------- reputation

test("recordLatency is an exponential moving average", () => {
  const h = recordLatency({ latencyEmaMs: 400, qualityFailures: 0, blocked: false }, 2400, { latencyAlpha: 0.5 });
  assert.equal(h.latencyEmaMs, 1400);
});

test("recordQuality ignores scores at the junk threshold", () => {
  const h0 = freshHealth(std);
  assert.equal(recordQuality(h0, DEFAULT_POLICY.junkThreshold, DEFAULT_POLICY), h0);
});

test("recordQuality blocks after maxQualityFailures junk answers", () => {
  let h = freshHealth(std);
  h = recordQuality(h, 0.05, DEFAULT_POLICY);
  assert.equal(h.blocked, false);
  h = recordQuality(h, 0.05, DEFAULT_POLICY);
  assert.equal(h.blocked, true);
  assert.match(h.blockReason!, /2 junk answers/);
});

test("recordQuoteViolation blocks immediately", () => {
  const h = recordQuoteViolation(freshHealth(std), "quoted too much");
  assert.equal(h.blocked, true);
  assert.match(h.blockReason!, /quoted too much/);
});

// ---------------------------------------------------------------- premium

test("shouldEscalate: good score never escalates", () => {
  const r = shouldEscalate({ score: 0.7, premiumCost: 1, budget: budget(usd(1)), floatAvailable: usd(1), reservedForRemaining: 0, cfg: DEFAULT_POLICY });
  assert.equal(r.escalate, false);
});

test("shouldEscalate: weak score escalates only when premium fits after reserving remaining steps", () => {
  const args = { score: 0.5, budget: budget(cents(50)), floatAvailable: cents(50), cfg: DEFAULT_POLICY };
  assert.equal(shouldEscalate({ ...args, premiumCost: cents(30), reservedForRemaining: cents(20) }).escalate, true);
  assert.equal(shouldEscalate({ ...args, premiumCost: cents(30), reservedForRemaining: cents(20) + 1 }).escalate, false);
});

test("shouldEscalate uses the tighter of hold and float", () => {
  const r = shouldEscalate({ score: 0.1, premiumCost: cents(30), budget: budget(usd(1)), floatAvailable: cents(29), reservedForRemaining: 0, cfg: DEFAULT_POLICY });
  assert.equal(r.escalate, false);
});

// ---------------------------------------------------------------- projections

test("estimateRemaining sums the cheapest eligible provider per step, skipping blocked ones", () => {
  const h = health();
  assert.equal(estimateRemaining([model(3), search], noRogue, h), cents(3) + cents(2));
  h.set("model-lite", { ...h.get("model-lite")!, blocked: true });
  assert.equal(estimateRemaining([model(3), search], noRogue, h), cents(6) + cents(2));
});

test("estimateRemaining skips providers that already failed that step, and only that step", () => {
  const excluded = new Map([["a", new Set(["model-lite"])]]);
  const steps = [model(3, { id: "a" }), model(3, { id: "b" })];
  assert.equal(estimateRemaining(steps, noRogue, health(), excluded), cents(6) + cents(3));
});

test("degradePlan prices steps at providers still available, so its plan can actually be bought", () => {
  const excluded = new Map([["a", new Set(["model-lite"])]]);
  const r = degradePlan([model(3, { id: "a" })], cents(4), noRogue, health(), excluded);
  assert.deepEqual(r.steps.map((s) => s.units), [2]);
});

// ---------------------------------------------------------------- hold increases

test("planHoldIncrease returns null when the plan fits exactly", () => {
  assert.equal(planHoldIncrease(budget(cents(50), cents(20), cents(10)), cents(20), DEFAULT_POLICY), null);
});

test("planHoldIncrease asks for need plus buffer, rounded up to the cent", () => {
  const p = planHoldIncrease(budget(cents(50), cents(20)), cents(40) + 1, DEFAULT_POLICY);
  assert.ok(p);
  assert.equal(p.newTotal, cents(60) + cents(5) + cents(1));
  assert.equal(p.increment, p.newTotal - cents(50));
});

test("planHoldIncrease never exceeds maxHold", () => {
  const p = planHoldIncrease(budget(cents(50)), usd(10), DEFAULT_POLICY);
  assert.equal(p!.newTotal, DEFAULT_POLICY.maxHold);
});

test("planHoldIncrease returns null when already at maxHold", () => {
  assert.equal(planHoldIncrease(budget(DEFAULT_POLICY.maxHold), usd(10), DEFAULT_POLICY), null);
});

// ---------------------------------------------------------------- degradation

test("degradePlan drops optional steps and lowers model tier first", () => {
  const steps: Step[] = [model(2, { id: "a", minTier: 2, premiumEligible: true }), { ...search, id: "opt", optional: true }];
  const r = degradePlan(steps, usd(1), noRogue, health());
  assert.deepEqual(r.dropped, ["opt"]);
  assert.equal(r.steps[0]!.minTier, 1);
  assert.equal(r.steps[0]!.premiumEligible, false);
});

test("degradePlan shrinks the largest model step until it fits", () => {
  const r = degradePlan([model(5, { id: "a" }), model(2, { id: "b" })], cents(4), noRogue, health());
  assert.ok(estimateRemaining(r.steps, noRogue, health()) <= cents(4));
  assert.deepEqual(r.steps.map((s) => s.units), [2, 2]);
});

test("degradePlan with zero room drops everything", () => {
  const r = degradePlan([model(1, { id: "a" }), { ...search, id: "b" }], 0, noRogue, health());
  assert.equal(r.steps.length, 0);
  assert.deepEqual(r.dropped, ["b", "a"]);
});

// ---------------------------------------------------------------- reserve

test("allocateReserve favours the job closest to finishing", () => {
  const r = allocateReserve(
    [
      { jobId: "A", shortfall: cents(20), completedSteps: 1, totalSteps: 5 },
      { jobId: "B", shortfall: cents(20), completedSteps: 4, totalSteps: 5 },
    ],
    cents(30),
  );
  assert.deepEqual(r.order, ["B"]);
  assert.equal(r.left, cents(10));
});

test("allocateReserve tie-breaks by smaller shortfall then job id", () => {
  const r = allocateReserve(
    [
      { jobId: "B", shortfall: cents(5), completedSteps: 1, totalSteps: 2 },
      { jobId: "A", shortfall: cents(5), completedSteps: 1, totalSteps: 2 },
      { jobId: "C", shortfall: cents(3), completedSteps: 1, totalSteps: 2 },
    ],
    cents(100),
  );
  assert.deepEqual(r.order, ["C", "A", "B"]);
});

test("allocateReserve never over-grants and ignores zero shortfalls", () => {
  const r = allocateReserve(
    [
      { jobId: "A", shortfall: cents(10), completedSteps: 0, totalSteps: 1 },
      { jobId: "B", shortfall: 0, completedSteps: 0, totalSteps: 1 },
    ],
    cents(10),
  );
  assert.deepEqual([...r.grants], [["A", cents(10)]]);
  assert.equal(r.left, 0);
});

test("allocateReserve with zero reserve grants nothing", () => {
  const r = allocateReserve([{ jobId: "A", shortfall: 1, completedSteps: 0, totalSteps: 1 }], 0);
  assert.equal(r.grants.size, 0);
});

// ---------------------------------------------------------------- float split

test("splitFloat is proportional to holds and never exceeds the pool", () => {
  const s = splitFloat(
    [
      { jobId: "A", hold: usd(1) },
      { jobId: "B", hold: cents(75) },
      { jobId: "C", hold: cents(75) },
    ],
    usd(1.5),
    cents(30),
  );
  const total = [...s.values()].reduce((a, b) => a + b, 0);
  assert.ok(total <= usd(1.2));
  assert.equal(s.get("A"), Math.floor((usd(1.2) * usd(1)) / usd(2.5)));
});

test("splitFloat with reserve above float gives everyone zero", () => {
  const s = splitFloat([{ jobId: "A", hold: usd(1) }], cents(10), cents(20));
  assert.equal(s.get("A"), 0);
});

test("splitFloat with zero holds gives zero", () => {
  const s = splitFloat([{ jobId: "A", hold: 0 }], usd(1), 0);
  assert.equal(s.get("A"), 0);
});
