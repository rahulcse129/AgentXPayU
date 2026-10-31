/**
 * Builds one fully mocked world (Airwallex, Metal, providers, customers), runs the
 * orchestrator in it, and checks every invariant afterwards.
 */
import { cents, floorToCent, type Micros } from "../money.ts";
import { Ledger, MemoryStore } from "../ledger/ledger.ts";
import { CATALOG, ROGUE_PROVIDER_ID, providerById } from "../policy/catalog.ts";
import { DEFAULT_POLICY, type PolicyConfig, type Step, type Tier } from "../policy/types.ts";
import { MockAirwallex } from "../payments/mock-airwallex.ts";
import { MockMetal } from "../payments/mock-metal.ts";
import { InProcessProviders } from "../providers/in-process.ts";
import type { ProviderMode } from "../providers/logic.ts";
import { Orchestrator, type JobResult, type JobSpec, type Sabotage } from "../engine/orchestrator.ts";
import { ScriptedCustomers, TagJudge, type ApprovalAnswer, type ProviderPort, type QualityJudge } from "../engine/ports.ts";
import { ClearingEmulator } from "../clearing/emulator.ts";
import { EMULATOR_TEST_KEY, Eip712Signer, HmacSigner } from "../clearing/signer.ts";
import { between, pick, seeded } from "./rng.ts";

// ------------------------------------------------------------------ scenario

export interface Faults {
  overrun?: { round: number; jobId: string; stepId: string; factor: number };
  slowdown?: { round: number; providerId: string; latencyMs: number };
  rogueMode: ProviderMode;
  /** An otherwise honest provider that takes payment and fails to deliver. */
  flaky?: { providerId: string; round: number };
  customerAnswer: ApprovalAnswer;
  chain: { failBeforeSettleRate: number; ackLossRate: number };
  airwallex: { incrementDeclineRate: number; authorizeDeclineRate: number };
}

export interface Scenario {
  seed: number;
  jobs: JobSpec[];
  float: Micros;
  reserve: Micros;
  faults: Faults;
  policy: PolicyConfig;
}

export function randomScenario(seed: number): Scenario {
  const rng = seeded(seed);
  const nJobs = between(rng, 1, 4);
  const jobs: JobSpec[] = [];
  for (let j = 0; j < nJobs; j++) {
    const steps: Step[] = [];
    const nSteps = between(rng, 3, 8);
    for (let k = 0; k < nSteps; k++) {
      const kind = k === 0 ? "search" : pick(rng, ["model", "model", "model", "search", "data"] as const);
      steps.push({
        id: `s${k + 1}`,
        kind,
        units: kind === "model" ? between(rng, 1, 6) : 1,
        minTier: (kind === "model" ? pick(rng, [1, 1, 2]) : 2) as Tier,
        maxLatencyMs: between(rng, 600, 1200),
        optional: rng() < 0.2,
        premiumEligible: kind === "model" && rng() < 0.3,
      });
    }
    jobs.push({ id: `job${j + 1}`, customer: `cust${j + 1}`, hold: cents(between(rng, 30, 150)), steps });
  }
  const totalHolds = jobs.reduce((s, j) => s + j.hold, 0);
  const float = floorToCent(Math.floor(totalHolds * (0.4 + rng() * 0.8)));
  const reserve = floorToCent(Math.floor(float * rng() * 0.3));

  const target = pick(rng, jobs);
  const modelSteps = target.steps.filter((s) => s.kind === "model");
  const overrunStep = modelSteps.length ? pick(rng, modelSteps) : undefined;

  return {
    seed,
    jobs,
    float,
    reserve,
    policy: { ...DEFAULT_POLICY, maxHold: cents(between(rng, 150, 300)) },
    faults: {
      overrun:
        overrunStep && rng() < 0.6
          ? { round: between(rng, 1, 4), jobId: target.id, stepId: overrunStep.id, factor: between(rng, 2, 6) }
          : undefined,
      slowdown: rng() < 0.5 ? { round: between(rng, 1, 4), providerId: "model-lite", latencyMs: 2500 } : undefined,
      rogueMode: pick(rng, ["honest", "overquote", "wrong_payee", "junk", "crash_after_pay"] as const),
      flaky: rng() < 0.15 ? { providerId: pick(rng, ["model-std", "search", "data"]), round: between(rng, 1, 3) } : undefined,
      customerAnswer: pick(rng, ["approved", "approved", "declined", "timeout"] as const),
      chain: { failBeforeSettleRate: 0.05, ackLossRate: 0.05 },
      airwallex: { incrementDeclineRate: 0.1, authorizeDeclineRate: 0.03 },
    },
  };
}

// ------------------------------------------------------------------ run + check

/** Every Nth seed signs running totals with real EIP-712 instead of keyed hashes. */
export const EIP712_EVERY = 500;

export interface RunOutcome {
  seed: number;
  violations: string[];
  results: JobResult[];
  stats: Record<string, number>;
  ledger: Ledger;
}

/** Records which step each payment key was quoted for, so overpayment can be checked independently. */
export class RecordingProviders implements ProviderPort {
  readonly quoted = new Map<string, { providerId: string; units: number }>();
  constructor(private readonly inner: ProviderPort) {}
  requestQuote(providerId: string, step: Step, key: string) {
    this.quoted.set(key, { providerId, units: step.units });
    return this.inner.requestQuote(providerId, step, key);
  }
  deliver(providerId: string, step: Step, key: string, txHash: string) {
    return this.inner.deliver(providerId, step, key, txHash);
  }
}

export async function runScenario(sc: Scenario, sabotage?: Sabotage, opts: { judge?: QualityJudge } = {}): Promise<RunOutcome> {
  const rng = seeded(sc.seed ^ 0x9e3779b9);
  let clock = 0;
  const ledger = new Ledger(new MemoryStore(), () => ++clock);
  const airwallex = new MockAirwallex({ ...sc.faults.airwallex, rng });
  const metal = new MockMetal({ ...sc.faults.chain, rng });
  const inner = new InProcessProviders(CATALOG, rng);
  const providers = new RecordingProviders(inner);
  inner.control(ROGUE_PROVIDER_ID, { mode: sc.faults.rogueMode });
  const customers = new ScriptedCustomers(() => sc.faults.customerAnswer);
  // Real EIP-712 signatures on a sample of runs; keyed hashes elsewhere (EIP-712 recovery is ~14 ms).
  const clearing = new ClearingEmulator(sc.seed % EIP712_EVERY === 0 ? new Eip712Signer(EMULATOR_TEST_KEY) : new HmacSigner());

  const engine = new Orchestrator({
    ledger,
    holds: airwallex,
    float: metal,
    providers,
    judge: opts.judge ?? new TagJudge(),
    customers,
    clearing,
    catalog: CATALOG,
    policy: sc.policy,
    rng,
    sabotage,
  });

  const violations: string[] = [];
  let results: JobResult[] = [];
  try {
    results = await engine.run(sc.jobs, {
      float: sc.float,
      reserve: sc.reserve,
      clearingEpochRounds: 1 + (sc.seed % 4),
      onRound: (round, eng) => {
        const f = sc.faults;
        if (f.overrun && f.overrun.round === round) {
          eng.mutateStep(f.overrun.jobId, f.overrun.stepId, (s) => ({ ...s, units: s.units * f.overrun!.factor }));
        }
        if (f.slowdown && f.slowdown.round === round) inner.control(f.slowdown.providerId, { latencyMs: f.slowdown.latencyMs });
        if (f.flaky && f.flaky.round === round) inner.control(f.flaky.providerId, { mode: "crash_after_pay" });
      },
    });
  } catch (e) {
    violations.push(`run.crashed: ${String(e)}`);
  }

  violations.push(...checkInvariants({ ledger, airwallex, metal, quoted: providers.quoted, clearing }));

  const events = ledger.events();
  const count = (t: string) => events.filter((e) => e.type === t).length;
  const answers = events.filter((e) => e.type === "hold.increase_answer").map((e) => e.data.answer);
  const stats: Record<string, number> = {
    jobs: sc.jobs.length,
    payments: ledger.payments().filter((p) => p.status === "paid").length,
    refusedQuotes: count("payment.refused"),
    providersBlocked: count("provider.blocked"),
    junkCaught: count("answer.junk"),
    noDelivery: count("provider.no_delivery"),
    payRetries: count("payment.retry"),
    dedupedRetries: metal.dedupedRetries,
    increaseRequests: count("hold.increase_requested"),
    increasesApproved: answers.filter((a) => a === "approved").length,
    increasesDeclined: answers.filter((a) => a === "declined").length,
    increasesTimedOut: answers.filter((a) => a === "timeout").length,
    holdsIncremented: count("hold.incremented"),
    issuerDeclines: count("hold.increment_failed"),
    degradedJobs: new Set(events.filter((e) => e.type === "job.degraded").map((e) => e.jobId)).size,
    reserveGrants: count("reserve.granted"),
    premiumBuys: events.filter((e) => e.type === "agent.premium_check" && e.data.escalate).length,
    failedJobs: results.filter((r) => r.status === "failed").length,
    holdsCaptured: results.filter((r) => r.holdOutcome === "captured").length,
    holdsCancelled: results.filter((r) => r.holdOutcome === "cancelled").length,
    spent: results.reduce((s, r) => s + r.spent, 0),
    premiumOnlyCost: results.reduce((s, r) => s + r.premiumOnlyCost, 0),
    clearingTotalsSigned: clearing.signed.length,
    clearingRedemptions: clearing.redemptions.length,
    clearingRedeemed: clearing.redemptions.reduce((s, r) => s + r.amount, 0),
    clearingEpochs: clearing.currentEpoch - 1,
    clearingEip712Runs: clearing.signerKind === "eip712" ? 1 : 0,
  };
  return { seed: sc.seed, violations, results, stats, ledger };
}

// ------------------------------------------------------------------ invariants

export function checkInvariants(w: {
  ledger: Ledger;
  airwallex: MockAirwallex;
  metal: MockMetal;
  quoted: Map<string, { providerId: string; units: number }>;
  clearing?: ClearingEmulator;
}): string[] {
  const v: string[] = [];
  const { ledger, airwallex, metal, quoted, clearing } = w;

  // 1. Nobody ever tried to break an Airwallex rule (over-capture, double capture, ...).
  for (const msg of airwallex.violations) v.push(`airwallex.rule_broken: ${msg}`);

  // 2. Every hold ended captured or cancelled.
  for (const h of airwallex.holds.values()) {
    if (h.status === "authorized") v.push(`hold.orphaned: ${h.holdId} still authorized`);
  }

  // 3. Capture is exactly what was spent (to the cent), never more than authorized.
  //    And spending never ran ahead of the authorization at ANY point in time.
  const jobIds = new Set(ledger.payments().map((p) => p.jobId));
  for (const h of airwallex.holds.values()) jobIds.add(h.jobId);
  for (const jobId of jobIds) {
    const hold = ledger.hold(jobId);
    const spent = ledger.spent(jobId);
    if (!hold) {
      if (spent > 0) v.push(`hold.missing: ${jobId} spent ${spent} without a hold`);
      continue;
    }
    if (spent > hold.authorized) v.push(`hold.exceeded: ${jobId} spent ${spent} > authorized ${hold.authorized}`);
    if (hold.status === "captured" && hold.captured !== floorToCent(spent)) {
      v.push(`capture.mismatch: ${jobId} captured ${hold.captured}, spent ${spent}`);
    }
    if (hold.status === "cancelled" && floorToCent(spent) > 0) v.push(`capture.missed: ${jobId} cancelled but spent ${spent}`);

    let authorized = 0;
    let paid = 0;
    for (const e of ledger.events(jobId)) {
      if (e.type === "hold.authorized") authorized = Number(e.data.authorized);
      if (e.type === "hold.incremented") authorized = Number(e.data.to);
      if (e.type === "payment.paid") {
        paid += Number(e.data.amount);
        if (paid > authorized) {
          v.push(`hold.raced: ${jobId} paid ${paid} while only ${authorized} was authorized`);
          break;
        }
      }
    }
  }

  // 4. No payment is left pending.
  for (const p of ledger.payments()) if (p.status === "pending") v.push(`payment.pending: ${p.key}`);

  // 5. The rail and the ledger agree exactly: no double payments, no phantom payments.
  const paidRows = new Map(ledger.payments().filter((p) => p.status === "paid").map((p) => [p.key, p]));
  for (const s of metal.settlements.values()) {
    const row = paidRows.get(s.key);
    if (!row) v.push(`payment.unrecorded: settlement ${s.key} (${s.amount}) not in ledger as paid — double or phantom payment`);
    else if (row.amount !== s.amount) v.push(`payment.amount_mismatch: ${s.key}`);
  }
  for (const key of paidRows.keys()) if (!metal.settlements.has(key)) v.push(`payment.missing_on_rail: ${key}`);

  // 6. No provider was ever paid above list price or to an address other than its registered one.
  for (const s of metal.settlements.values()) {
    const q = quoted.get(s.key.split("#")[0]!);
    if (!q) {
      v.push(`payment.unquoted: ${s.key}`);
      continue;
    }
    const spec = providerById(q.providerId);
    if (s.payTo !== spec.payTo) v.push(`payment.wrong_payee: ${s.key} paid to ${s.payTo}`);
    if (s.amount > spec.pricePerUnit * q.units) v.push(`payment.overpaid: ${s.key} paid ${s.amount} > list ${spec.pricePerUnit * q.units}`);
  }

  // 7. Float is conserved and fully withdrawn.
  if (metal.deposited !== metal.withdrawn + metal.totalSettled()) {
    v.push(`float.leak: deposited ${metal.deposited} != withdrawn ${metal.withdrawn} + settled ${metal.totalSettled()}`);
  }

  if (clearing) v.push(...checkClearing(ledger, clearing, jobIds));
  return v;
}

/** Clearing invariants (SIMULATED layer): it must agree with the ledger to the micro, and finalize before capture. */
function checkClearing(ledger: Ledger, clearing: ClearingEmulator, jobIds: Set<string>): string[] {
  const v: string[] = [];

  // 8. Nobody tried to break a clearing rule (lower total, totals over deposit, early withdrawal, ...).
  for (const msg of clearing.violations) v.push(`clearing.rule_broken: ${msg}`);

  // 9. No running total was redeemed twice, and each payee's redemptions only ever go up.
  const seen = new Set<string>();
  const lastRedeemed = new Map<string, Micros>();
  for (const r of clearing.redemptions) {
    const id = `${r.jobKey}|${r.payee}|${r.cumulative}`;
    if (seen.has(id)) v.push(`clearing.double_redeem: ${id}`);
    seen.add(id);
    const pair = `${r.jobKey}|${r.payee}`;
    if (r.amount <= 0 || r.cumulative - (lastRedeemed.get(pair) ?? 0) !== r.amount) v.push(`clearing.double_redeem: ${id} amount ${r.amount}`);
    lastRedeemed.set(pair, r.cumulative);
  }

  for (const jobId of new Set([...jobIds, ...clearing.jobKeys()])) {
    const cs = clearing.status(jobId);
    const spent = ledger.spent(jobId);
    if (!cs) {
      if (spent > 0) v.push(`clearing.missing: ${jobId} paid ${spent} with no clearing deposit`);
      continue;
    }
    // 10. Sum of redeemed totals = ledger paid, per job.
    if (cs.redeemed !== spent) v.push(`clearing.mismatch: ${jobId} redeemed ${cs.redeemed}, ledger paid ${spent}`);
    // 11. Deposit minus redeemed = withdrawn, and every deposit was returned.
    if (!cs.final) v.push(`clearing.not_withdrawn: ${jobId}`);
    else if (cs.deposited - cs.redeemed !== cs.withdrawn) {
      v.push(`clearing.leak: ${jobId} deposited ${cs.deposited} - redeemed ${cs.redeemed} != withdrawn ${cs.withdrawn}`);
    }
    // 12. Finality gate: the card hold was settled only after this job's clearing was withdrawn.
    const events = ledger.events(jobId);
    const settledAt = events.find((e) => e.type === "hold.captured" || e.type === "hold.cancelled")?.seq;
    const finalAt = events.find((e) => e.type === "clearing.withdrawn")?.seq;
    if (settledAt !== undefined && (finalAt === undefined || finalAt > settledAt)) {
      v.push(`clearing.captured_before_final: ${jobId}`);
    }
  }
  return v;
}
