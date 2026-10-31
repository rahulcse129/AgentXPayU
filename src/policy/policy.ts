/**
 * The policy module. Pure functions, no I/O, no LLM.
 * Every money decision the agent makes goes through here.
 */
import { ceilToCent, fmt, type Micros } from "../money.ts";
import type {
  JobBudget,
  PaymentRequirement,
  PolicyConfig,
  ProviderHealth,
  ProviderSpec,
  Step,
  Tier,
} from "./types.ts";

// ---------------------------------------------------------------- budget

export function headroom(b: JobBudget): Micros {
  return b.holdAmount - b.spent - b.inFlight;
}

export function stepCost(p: ProviderSpec, step: Step): Micros {
  return p.pricePerUnit * step.units;
}

// ---------------------------------------------------------------- provider choice

export type RejectReason = "blocked" | "wrong_kind" | "tier_too_low" | "too_slow";

export interface ChooseInput {
  step: Step;
  budget: JobBudget;
  /** Float this job may still spend (its allocation plus any reserve granted). */
  floatAvailable: Micros;
  providers: ProviderSpec[];
  health: ReadonlyMap<string, ProviderHealth>;
  /** Force at least this tier (used when escalating to premium). */
  minTierOverride?: Tier;
  /** Providers to skip for this attempt (e.g. just refused). */
  exclude?: ReadonlySet<string>;
}

export type ChooseResult =
  | {
      ok: true;
      provider: ProviderSpec;
      cost: Micros;
      reason: string;
      rejected: { id: string; why: RejectReason }[];
    }
  | {
      ok: false;
      reason: "no_provider" | "over_hold" | "over_float";
      cheapestCost?: Micros;
      rejected: { id: string; why: RejectReason }[];
    };

export function effectiveLatency(p: ProviderSpec, health: ReadonlyMap<string, ProviderHealth>): number {
  return health.get(p.id)?.latencyEmaMs ?? p.nominalLatencyMs;
}

/** Providers that can do this step at all, ignoring money, split into fast and slow. */
export function eligibleProviders(input: ChooseInput): {
  fast: ProviderSpec[];
  slow: ProviderSpec[];
  rejected: { id: string; why: RejectReason }[];
} {
  const { step, providers, health } = input;
  const minTier = Math.max(step.minTier, input.minTierOverride ?? 1);
  const rejected: { id: string; why: RejectReason }[] = [];
  const capable: ProviderSpec[] = [];

  for (const p of providers) {
    if (p.kind !== step.kind) continue;
    if (input.exclude?.has(p.id)) continue;
    if (health.get(p.id)?.blocked) {
      rejected.push({ id: p.id, why: "blocked" });
      continue;
    }
    if (p.tier < minTier) {
      rejected.push({ id: p.id, why: "tier_too_low" });
      continue;
    }
    capable.push(p);
  }

  const fast = capable.filter((p) => effectiveLatency(p, health) <= step.maxLatencyMs);
  const slow = capable.filter((p) => !fast.includes(p));
  for (const p of slow) rejected.push({ id: p.id, why: "too_slow" });
  return { fast, slow, rejected };
}

/**
 * Cheapest provider that fits both the card hold headroom and the job's float.
 * Fast providers are tried first (cheapest, then fastest). A slow provider is used only
 * when no fast one fits the budget: a slow answer beats no answer, but never beats the hold.
 */
export function chooseProvider(input: ChooseInput): ChooseResult {
  const { step, budget, floatAvailable, health } = input;
  const { fast, slow, rejected } = eligibleProviders(input);
  if (fast.length === 0 && slow.length === 0) return { ok: false, reason: "no_provider", rejected };

  const byCost = (a: ProviderSpec, b: ProviderSpec) =>
    stepCost(a, step) - stepCost(b, step) || effectiveLatency(a, health) - effectiveLatency(b, health);
  const room = headroom(budget);
  const all = [...fast, ...slow];
  const cheapestCost = Math.min(...all.map((p) => stepCost(p, step)));
  const skippedSlow = slow.map((p) => p.id);

  for (const [group, label] of [
    [[...fast].sort(byCost), "fast"],
    [[...slow].sort(byCost), "slow"],
  ] as const) {
    for (const p of group) {
      const cost = stepCost(p, step);
      if (cost <= room && cost <= floatAvailable) {
        const note =
          label === "slow"
            ? " (no fast provider fits the budget; accepting a slower one)"
            : skippedSlow.length
              ? `; skipped slow: ${skippedSlow.join(", ")}`
              : "";
        return {
          ok: true,
          provider: p,
          cost,
          reason: `${p.id} is the cheapest tier-${p.tier} option that fits${note}`,
          rejected,
        };
      }
    }
  }
  if (cheapestCost > room) return { ok: false, reason: "over_hold", cheapestCost, rejected };
  return { ok: false, reason: "over_float", cheapestCost, rejected };
}

// ---------------------------------------------------------------- rogue provider defence

export type QuoteCheck =
  | { ok: true }
  | { ok: false; reason: "overquote" | "wrong_payee" | "wrong_asset"; detail: string };

/**
 * Every 402 is checked against the published price list before we pay.
 * Paying less than list is fine; paying more, or to another address, never is.
 */
export function verifyQuote(
  req: PaymentRequirement,
  provider: ProviderSpec,
  step: Step,
  cfg: Pick<PolicyConfig, "asset">,
): QuoteCheck {
  if (req.asset !== cfg.asset) {
    return { ok: false, reason: "wrong_asset", detail: `asked for ${req.asset}, we pay in ${cfg.asset}` };
  }
  if (req.payTo.toLowerCase() !== provider.payTo.toLowerCase()) {
    return { ok: false, reason: "wrong_payee", detail: `asked to pay ${req.payTo}, registered ${provider.payTo}` };
  }
  const expected = stepCost(provider, step);
  if (!Number.isSafeInteger(req.amount) || req.amount < 0 || req.amount > expected) {
    return {
      ok: false,
      reason: "overquote",
      detail: `quoted ${fmt(req.amount)}, list price ${fmt(expected)} (${req.amount} vs ${expected} micros)`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- provider reputation

export function freshHealth(p: ProviderSpec): ProviderHealth {
  return { latencyEmaMs: p.nominalLatencyMs, qualityFailures: 0, blocked: false };
}

export function recordLatency(h: ProviderHealth, sampleMs: number, cfg: Pick<PolicyConfig, "latencyAlpha">): ProviderHealth {
  return { ...h, latencyEmaMs: Math.round(cfg.latencyAlpha * sampleMs + (1 - cfg.latencyAlpha) * h.latencyEmaMs) };
}

export function recordQuality(
  h: ProviderHealth,
  score: number,
  cfg: Pick<PolicyConfig, "junkThreshold" | "maxQualityFailures">,
): ProviderHealth {
  if (score >= cfg.junkThreshold) return h;
  const failures = h.qualityFailures + 1;
  const blocked = h.blocked || failures >= cfg.maxQualityFailures;
  return {
    ...h,
    qualityFailures: failures,
    blocked,
    blockReason: blocked && !h.blocked ? `${failures} junk answers after payment` : h.blockReason,
  };
}

export function recordQuoteViolation(h: ProviderHealth, detail: string): ProviderHealth {
  return { ...h, blocked: true, blockReason: `refused 402: ${detail}` };
}

// ---------------------------------------------------------------- premium

/** Buy a premium redo only when the answer is weak and the premium cost fits both limits. */
export function shouldEscalate(args: {
  score: number;
  premiumCost: Micros;
  budget: JobBudget;
  floatAvailable: Micros;
  /** Cost of the remaining required steps at their cheapest. Premium must not starve them. */
  reservedForRemaining: Micros;
  cfg: Pick<PolicyConfig, "qualityThreshold">;
}): { escalate: boolean; reason: string } {
  const { score, premiumCost, budget, floatAvailable, reservedForRemaining, cfg } = args;
  if (score >= cfg.qualityThreshold) return { escalate: false, reason: `score ${score.toFixed(2)} is good enough` };
  const room = Math.min(headroom(budget), floatAvailable) - reservedForRemaining;
  if (premiumCost > room) {
    return { escalate: false, reason: `score ${score.toFixed(2)} is weak but premium does not fit the remaining budget` };
  }
  return { escalate: true, reason: `score ${score.toFixed(2)} below ${cfg.qualityThreshold}; premium fits the budget` };
}

// ---------------------------------------------------------------- projections

/**
 * Cheapest possible cost of the remaining steps, ignoring latency. Used for hold and reserve planning.
 * `excluded` (stepId -> provider ids) leaves out providers that already failed that step, so the
 * estimate prices what can actually still be bought.
 */
export function estimateRemaining(
  steps: Step[],
  providers: ProviderSpec[],
  health: ReadonlyMap<string, ProviderHealth>,
  excluded?: ReadonlyMap<string, ReadonlySet<string>>,
): Micros {
  let total = 0;
  for (const step of steps) {
    const skip = excluded?.get(step.id);
    const costs = providers
      .filter((p) => p.kind === step.kind && p.tier >= step.minTier && !health.get(p.id)?.blocked && !skip?.has(p.id))
      .map((p) => stepCost(p, step));
    if (costs.length) total += Math.min(...costs);
  }
  return total;
}

// ---------------------------------------------------------------- hold increases

export interface HoldIncreasePlan {
  newTotal: Micros;
  increment: Micros;
  reason: string;
}

/**
 * Returns a plan if the projected spend exceeds the hold. The caller must get the
 * customer's approval and a successful incremental authorization BEFORE spending past the old hold.
 */
export function planHoldIncrease(
  budget: JobBudget,
  projectedRemaining: Micros,
  cfg: Pick<PolicyConfig, "maxHold" | "holdIncreaseBuffer">,
): HoldIncreasePlan | null {
  const need = budget.spent + budget.inFlight + projectedRemaining;
  if (need <= budget.holdAmount) return null;
  const newTotal = Math.min(ceilToCent(need + cfg.holdIncreaseBuffer), cfg.maxHold);
  if (newTotal <= budget.holdAmount) return null;
  return {
    newTotal,
    increment: newTotal - budget.holdAmount,
    reason: `projected spend ${fmt(need)} exceeds hold ${fmt(budget.holdAmount)}`,
  };
}

// ---------------------------------------------------------------- graceful degradation

/**
 * When the customer declines (or does not answer) a hold increase, shrink the plan
 * to fit what is left: drop optional steps, use the lowest model tier, then cut paragraphs.
 */
export function degradePlan(
  remaining: Step[],
  room: Micros,
  providers: ProviderSpec[],
  health: ReadonlyMap<string, ProviderHealth>,
  excluded?: ReadonlyMap<string, ReadonlySet<string>>,
): { steps: Step[]; dropped: string[]; note: string } {
  const dropped: string[] = [];
  let steps = remaining.filter((s) => {
    if (s.optional) dropped.push(s.id);
    return !s.optional;
  });
  steps = steps.map((s) => (s.kind === "model" ? { ...s, minTier: 1 as Tier, premiumEligible: false } : s));

  let cost = estimateRemaining(steps, providers, health, excluded);
  // Shrink model steps one paragraph at a time, largest first, until the plan fits.
  while (cost > room) {
    const biggest = steps
      .filter((s) => s.kind === "model" && s.units > 1)
      .sort((a, b) => b.units - a.units)[0];
    if (!biggest) break;
    steps = steps.map((s) => (s === biggest ? { ...s, units: s.units - 1 } : s));
    cost = estimateRemaining(steps, providers, health, excluded);
  }
  // Still over: drop trailing steps. The job ends with a partial, clearly labelled answer.
  while (cost > room && steps.length > 0) {
    const last = steps[steps.length - 1]!;
    dropped.push(last.id);
    steps = steps.slice(0, -1);
    cost = estimateRemaining(steps, providers, health, excluded);
  }
  return {
    steps,
    dropped,
    note: `${steps.length} steps kept, ${dropped.length} dropped, plan now costs ${fmt(cost)} of ${fmt(room)} left`,
  };
}

// ---------------------------------------------------------------- shared reserve

export interface ReserveRequest {
  jobId: string;
  /** Extra float this job needs to finish. */
  shortfall: Micros;
  completedSteps: number;
  totalSteps: number;
}

/**
 * Grant the shared reserve to jobs closest to finishing first (a nearly done report is
 * worth more than a half done one), then to the smallest shortfall. Never over-grant.
 */
export function allocateReserve(
  requests: ReserveRequest[],
  reserve: Micros,
): { grants: Map<string, Micros>; left: Micros; order: string[] } {
  const grants = new Map<string, Micros>();
  const order: string[] = [];
  let left = reserve;
  const ranked = requests
    .filter((r) => r.shortfall > 0)
    .sort((a, b) => {
      const pa = a.completedSteps / Math.max(1, a.totalSteps);
      const pb = b.completedSteps / Math.max(1, b.totalSteps);
      return pb - pa || a.shortfall - b.shortfall || a.jobId.localeCompare(b.jobId);
    });
  for (const r of ranked) {
    if (r.shortfall <= left) {
      grants.set(r.jobId, r.shortfall);
      left -= r.shortfall;
      order.push(r.jobId);
    }
  }
  return { grants, left, order };
}

/** Split float across jobs in proportion to their holds, keeping a shared reserve back. */
export function splitFloat(
  holds: { jobId: string; hold: Micros }[],
  float: Micros,
  reserve: Micros,
): Map<string, Micros> {
  const pool = Math.max(0, float - reserve);
  const total = holds.reduce((s, h) => s + h.hold, 0);
  const out = new Map<string, Micros>();
  for (const h of holds) {
    out.set(h.jobId, total === 0 ? 0 : Math.floor((pool * h.hold) / total));
  }
  return out;
}
