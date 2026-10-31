/**
 * Runs several jobs at once over a shared float. Every money decision is delegated to the
 * policy module; this file only sequences calls and records them in the ledger.
 *
 * Guarantees (checked by the 10,000-run simulation):
 *  - nothing is paid past a job's current hold; a hold is raised before spending past it
 *  - every 402 is checked against the price list before paying
 *  - retries reuse the same idempotency key, so nothing is paid twice
 *  - every hold ends captured (exactly what was spent) or cancelled, even for failed jobs
 *  - unused float is withdrawn
 *  - with clearing on: every payment is also a signed running total, and a hold is captured
 *    only after that job's clearing has finalized (epoch closed, settled, deposit withdrawn)
 */
import { floorToCent, type Micros } from "../money.ts";
import type { Ledger } from "../ledger/ledger.ts";
import {
  allocateReserve,
  chooseProvider,
  degradePlan,
  estimateRemaining,
  freshHealth,
  headroom,
  planHoldIncrease,
  recordLatency,
  recordQuality,
  recordQuoteViolation,
  shouldEscalate,
  splitFloat,
  verifyQuote,
} from "../policy/policy.ts";
import type { JobBudget, PolicyConfig, ProviderHealth, ProviderSpec, Step } from "../policy/types.ts";
import { InsufficientFloat, TransientError, type FloatGateway, type HoldGateway } from "../payments/types.ts";
import type { ClearingPort } from "../clearing/port.ts";
import type { CustomerPort, ProviderPort, QualityJudge } from "./ports.ts";

export interface JobSpec {
  id: string;
  customer: string;
  hold: Micros;
  steps: Step[];
}

export type JobStatus = "completed" | "budget_limited" | "failed";

export interface JobResult {
  jobId: string;
  status: JobStatus;
  holdFinal: Micros;
  spent: Micros;
  captured: Micros;
  holdOutcome: "captured" | "cancelled" | "none";
  stepsDone: number;
  stepsTotal: number;
  dropped: string[];
  outputs: string[];
  /** What premium-only sourcing would have cost for the same steps. */
  premiumOnlyCost: Micros;
  error?: string;
}

/**
 * Deliberately broken behaviours, used ONLY to prove the simulation's checks catch real bugs.
 * Never enable outside `npm run sim:sabotage`.
 */
export interface Sabotage {
  /** Pay whatever the 402 asks. */
  skipQuoteCheck?: boolean;
  /** Use a new idempotency key on each retry. */
  freshKeyOnRetry?: boolean;
  /** Ignore the hold when choosing providers. */
  ignoreHold?: boolean;
  /** Capture the full hold instead of what was spent. */
  captureFullHold?: boolean;
  /** Capture holds before the job's clearing epoch has closed and settled. */
  captureBeforeFinality?: boolean;
}

export interface EngineDeps {
  ledger: Ledger;
  holds: HoldGateway;
  float: FloatGateway;
  providers: ProviderPort;
  judge: QualityJudge;
  customers: CustomerPort;
  /** Optional clearing layer (emulated until Metal opens clearing on testnet). */
  clearing?: ClearingPort;
  catalog: ProviderSpec[];
  policy: PolicyConfig;
  /** Seeded in the simulation so every run is reproducible. */
  rng: () => number;
  sabotage?: Sabotage;
}

export interface RunOptions {
  float: Micros;
  reserve: Micros;
  maxPayRetries?: number;
  /** Called at the start of each round: the place to inject overruns and slowdowns. */
  onRound?: (round: number, engine: Orchestrator) => void | Promise<void>;
  /** With clearing on, close and settle an epoch every this many rounds (default 3). */
  clearingEpochRounds?: number;
}

interface JobState {
  spec: JobSpec;
  holdId?: string;
  remaining: Step[];
  total: number;
  done: number;
  floatAllowance: Micros;
  floatSpent: Micros;
  increaseAsked: boolean;
  limited: boolean;
  dropped: string[];
  outputs: string[];
  premiumOnlyCost: Micros;
  finished: boolean;
  /** stepId -> providers that already failed that step. */
  failedProviders: Map<string, Set<string>>;
  error?: string;
}

type StepOutcome = "progress" | "waiting";

export class Orchestrator {
  readonly health = new Map<string, ProviderHealth>();
  private jobs = new Map<string, JobState>();
  private reserveLeft: Micros = 0;

  constructor(private readonly d: EngineDeps) {
    for (const p of d.catalog) this.health.set(p.id, freshHealth(p));
  }

  // ------------------------------------------------------------ fault injection hooks

  /** Change a not-yet-run step, e.g. a prompt that grows to 4x its token budget. */
  mutateStep(jobId: string, stepId: string, fn: (s: Step) => Step): boolean {
    const s = this.jobs.get(jobId);
    if (!s) return false;
    const i = s.remaining.findIndex((x) => x.id === stepId);
    if (i < 0) return false;
    s.remaining[i] = fn(s.remaining[i]!);
    this.d.ledger.log(jobId, "fault.step_changed", { stepId, units: s.remaining[i]!.units });
    return true;
  }

  jobIds(): string[] {
    return [...this.jobs.keys()];
  }

  remainingSteps(jobId: string): Step[] {
    return [...(this.jobs.get(jobId)?.remaining ?? [])];
  }

  // ------------------------------------------------------------ main loop

  async run(specs: JobSpec[], opts: RunOptions): Promise<JobResult[]> {
    const { ledger, holds, float } = this.d;
    await float.deposit(opts.float);
    ledger.log(null, "float.deposited", { amount: opts.float, reserve: opts.reserve });

    for (const spec of specs) {
      const premiumOnlyCost = this.premiumOnly(spec.steps);
      const s: JobState = {
        spec,
        remaining: spec.steps.map((x) => ({ ...x })),
        total: spec.steps.length,
        done: 0,
        floatAllowance: 0,
        floatSpent: 0,
        increaseAsked: false,
        limited: false,
        dropped: [],
        outputs: [],
        premiumOnlyCost,
        finished: false,
        failedProviders: new Map(),
      };
      this.jobs.set(spec.id, s);
      try {
        const { holdId } = await holds.authorize({ jobId: spec.id, amount: spec.hold });
        s.holdId = holdId;
        ledger.recordHold(spec.id, holdId, spec.hold);
        if (this.d.clearing) {
          // The clearing deposit mirrors the hold: what providers can redeem never exceeds what the customer approved.
          const { depositId } = await this.d.clearing.openDeposit(spec.id, spec.hold);
          ledger.log(spec.id, "clearing.deposit_opened", { depositId, amount: spec.hold, source: this.d.clearing.source });
        }
      } catch (e) {
        s.error = `hold not authorized: ${String(e)}`;
        s.finished = true;
        ledger.log(spec.id, "job.failed", { error: s.error });
      }
    }

    const live = [...this.jobs.values()].filter((s) => s.holdId);
    const shares = splitFloat(
      live.map((s) => ({ jobId: s.spec.id, hold: s.spec.hold })),
      opts.float,
      opts.reserve,
    );
    for (const s of live) s.floatAllowance = shares.get(s.spec.id) ?? 0;
    this.reserveLeft = opts.float - [...shares.values()].reduce((a, b) => a + b, 0);

    try {
      for (let round = 1; ; round++) {
        const active = [...this.jobs.values()].filter((s) => !s.finished);
        if (active.length === 0) break;
        if (round > 500) throw new Error("orchestrator did not converge");
        await opts.onRound?.(round, this);
        this.grantReserve(active);

        let progressed = false;
        for (const s of this.shuffle(active)) {
          if (s.finished) continue;
          let out: StepOutcome = "progress";
          try {
            out = await this.advance(s, opts);
          } catch (e) {
            s.error = String(e);
            s.finished = true;
            ledger.log(s.spec.id, "job.failed", { error: s.error });
          }
          if (out === "progress") progressed = true;
          if (!s.finished && s.remaining.length === 0) this.finish(s);
        }
        // Everyone is waiting for float that nobody will free: shrink plans to fit what each has.
        if (!progressed) {
          for (const s of active.filter((x) => !x.finished)) {
            const before = JSON.stringify(s.remaining);
            this.degrade(s, Math.min(headroom(this.budget(s)), this.floatLeft(s)), "float exhausted");
            // A plan that "fits" on paper but still cannot be bought must not spin: drop the stuck step.
            if (s.remaining.length > 0 && JSON.stringify(s.remaining) === before) {
              this.drop(s, s.remaining[0]!, "no provider still available fits what is left");
            }
            if (s.remaining.length === 0) this.finish(s);
          }
        }
        if (this.d.clearing && round % (opts.clearingEpochRounds ?? 3) === 0) await this.closeAndSettleEpoch();
      }
    } finally {
      for (const s of this.jobs.values()) await this.resolvePending(s);
      // Finality gate: clearing closes, settles and returns unused deposits BEFORE any card capture.
      if (!this.d.sabotage?.captureBeforeFinality) await this.finalizeClearing();
      // Every hold is captured or cancelled, whatever happened above.
      for (const s of this.jobs.values()) await this.settleHold(s, opts);
      if (this.d.sabotage?.captureBeforeFinality) await this.finalizeClearing();
      const left = await float.balance();
      if (left > 0) {
        await float.withdraw(left);
        ledger.log(null, "float.withdrawn", { amount: left });
      }
    }
    return [...this.jobs.values()].map((s) => this.result(s));
  }

  // ------------------------------------------------------------ one step of one job

  private async advance(s: JobState, opts: RunOptions): Promise<StepOutcome> {
    const { ledger, policy, catalog } = this.d;
    const jobId = s.spec.id;

    // 1. Will the rest of the plan fit the hold? If not, ask once; otherwise degrade.
    if (!s.limited && !this.d.sabotage?.ignoreHold) {
      const plan = planHoldIncrease(this.budget(s), estimateRemaining(s.remaining, catalog, this.health), policy);
      if (plan) {
        if (!s.increaseAsked) {
          s.increaseAsked = true;
          await this.askForMore(s, plan.newTotal, plan.reason);
        } else {
          this.degrade(s, headroom(this.budget(s)), "hold increase already used");
        }
        if (s.remaining.length === 0) return "progress";
      }
    }

    const step = s.remaining[0]!;
    // Never pay the same provider twice for a step it already failed (refused, junk, no delivery).
    const exclude = new Set<string>(s.failedProviders.get(step.id) ?? []);

    for (let attempt = 0; attempt < 6; attempt++) {
      const choice = chooseProvider({
        step,
        budget: this.choiceBudget(s),
        floatAvailable: this.floatLeft(s),
        providers: catalog,
        health: this.health,
        exclude,
      });
      if (!choice.ok) {
        if (choice.reason === "over_float") return "waiting";
        if (choice.reason === "over_hold" && !s.limited) {
          this.degrade(s, headroom(this.budget(s)), `step ${step.id} no longer fits the hold`);
          return "progress";
        }
        this.drop(s, step, choice.reason);
        return "progress";
      }
      ledger.log(jobId, "agent.decision", { stepId: step.id, providerId: choice.provider.id, cost: choice.cost, why: choice.reason });

      const bought = await this.buy(s, step, choice.provider, opts);
      if (bought.kind !== "ok") {
        exclude.add(choice.provider.id);
        if (bought.kind !== "unpaid") {
          const failed = s.failedProviders.get(step.id) ?? new Set<string>();
          failed.add(choice.provider.id);
          s.failedProviders.set(step.id, failed);
        }
        continue;
      }

      // Premium redo only if the policy says the weak answer is worth it and it fits.
      let output = bought.output;
      if (step.premiumEligible && choice.provider.tier < 3) {
        const premium = chooseProvider({
          step,
          budget: this.choiceBudget(s),
          floatAvailable: this.floatLeft(s),
          providers: catalog,
          health: this.health,
          minTierOverride: 3,
        });
        if (premium.ok) {
          const verdict = shouldEscalate({
            score: bought.score,
            premiumCost: premium.cost,
            budget: this.budget(s),
            floatAvailable: this.floatLeft(s),
            reservedForRemaining: estimateRemaining(s.remaining.slice(1), catalog, this.health),
            cfg: policy,
          });
          ledger.log(jobId, "agent.premium_check", { stepId: step.id, escalate: verdict.escalate, why: verdict.reason });
          if (verdict.escalate) {
            const redo = await this.buy(s, step, premium.provider, opts);
            if (redo.kind === "ok") output = redo.output;
          }
        }
      }

      s.outputs.push(output);
      s.remaining.shift();
      s.done++;
      ledger.log(jobId, "step.done", { stepId: step.id, spent: ledger.spent(jobId) });
      return "progress";
    }
    this.drop(s, step, "no provider delivered");
    return "progress";
  }

  /** Quote -> verify -> pay (idempotent, with retries) -> deliver -> judge. */
  private async buy(
    s: JobState,
    step: Step,
    p: ProviderSpec,
    opts: RunOptions,
  ): Promise<{ kind: "ok"; output: string; score: number } | { kind: "refused" | "unpaid" | "no_delivery" | "junk" }> {
    const { ledger, providers, float, judge, policy, sabotage } = this.d;
    const jobId = s.spec.id;
    // One key per purchase. Retries of THIS purchase reuse it (see payWithRetries);
    // a later, separate purchase of the same step from the same provider gets the next number.
    const prefix = `${jobId}:${step.id}:${p.id}:`;
    const prior = ledger.payments(jobId).filter((x) => x.key.startsWith(prefix) && (x.status === "paid" || x.status === "failed"));
    const key = `${prefix}${prior.length + 1}`;

    const quote = await providers.requestQuote(p.id, step, key);
    const check = sabotage?.skipQuoteCheck ? ({ ok: true } as const) : verifyQuote(quote, p, step, policy);
    if (!check.ok) {
      ledger.recordRefusal({ jobId, stepId: step.id, providerId: p.id, quoted: quote.amount, payTo: quote.payTo, reason: check.detail });
      this.health.set(p.id, recordQuoteViolation(this.health.get(p.id)!, check.detail));
      ledger.log(jobId, "provider.blocked", { providerId: p.id, why: check.detail });
      return { kind: "refused" };
    }

    // Final guard right before money moves: this payment must fit the hold and the float.
    const amount = quote.amount;
    if (!sabotage?.ignoreHold && amount > headroom(this.budget(s))) return { kind: "unpaid" };
    if (amount > this.floatLeft(s)) return { kind: "unpaid" };

    const row = ledger.beginPayment({ key, jobId, stepId: step.id, providerId: p.id, amount, payTo: quote.payTo });
    let txHash = row.txHash;
    if (row.status !== "paid") {
      txHash = await this.payWithRetries(key, quote.payTo, amount, opts.maxPayRetries ?? 3);
      if (!txHash) return { kind: "unpaid" };
      s.floatSpent += amount;
    }
    await this.signTotal(jobId, quote.payTo);

    let delivered: { output: string; latencyMs: number };
    try {
      delivered = await providers.deliver(p.id, step, key, txHash!);
    } catch (e) {
      // Paid but nothing came back: count it against the provider and buy elsewhere.
      this.health.set(p.id, recordQuality(this.health.get(p.id)!, 0, policy));
      ledger.log(jobId, "provider.no_delivery", { providerId: p.id, error: String(e) });
      return { kind: "no_delivery" };
    }
    this.health.set(p.id, recordLatency(this.health.get(p.id)!, delivered.latencyMs, policy));
    const verdict = judge.verdict ? await judge.verdict(step, delivered.output) : { score: await judge.score(step, delivered.output) };
    const { score } = verdict;
    const judged = verdict.reason ? { reason: verdict.reason, judge: verdict.source } : {};
    const before = this.health.get(p.id)!;
    const after = recordQuality(before, score, policy);
    this.health.set(p.id, after);
    if (after.blocked && !before.blocked) ledger.log(jobId, "provider.blocked", { providerId: p.id, why: after.blockReason });
    if (score < policy.junkThreshold) {
      ledger.log(jobId, "answer.junk", { providerId: p.id, score, ...judged });
      return { kind: "junk" };
    }
    ledger.log(jobId, "answer.scored", { providerId: p.id, score, ...judged });
    return { kind: "ok", output: delivered.output, score };
  }

  private async payWithRetries(key: string, payTo: string, amount: Micros, maxRetries: number): Promise<string | undefined> {
    const { ledger, float, policy, sabotage } = this.d;
    for (let i = 0; i <= maxRetries; i++) {
      const sendKey = sabotage?.freshKeyOnRetry && i > 0 ? `${key}#retry${i}` : key;
      try {
        const { txHash } = await float.pay({ idempotencyKey: sendKey, payTo, amount, asset: policy.asset });
        ledger.markPaid(key, txHash);
        return txHash;
      } catch (e) {
        if (e instanceof InsufficientFloat) {
          ledger.markFailed(key, String(e));
          return undefined;
        }
        if (!(e instanceof TransientError)) throw e;
        ledger.log(null, "payment.retry", { key, attempt: i + 1, error: String(e) });
      }
    }
    // Retries exhausted: ask the rail what actually happened.
    const settled = await float.lookup(key);
    if (settled) {
      ledger.markPaid(key, settled.txHash);
      return settled.txHash;
    }
    ledger.markFailed(key, "not settled after retries");
    return undefined;
  }

  // ------------------------------------------------------------ holds

  private async askForMore(s: JobState, newTotal: Micros, reason: string) {
    const { ledger, customers, holds } = this.d;
    const jobId = s.spec.id;
    const current = this.budget(s).holdAmount;
    ledger.log(jobId, "hold.increase_requested", { from: current, to: newTotal, reason });
    const answer = await customers.askHoldIncrease({ jobId, customer: s.spec.customer, current, newTotal, reason });
    ledger.log(jobId, "hold.increase_answer", { answer });
    if (answer === "approved") {
      try {
        // Raise the authorization FIRST; only a successful increment lets spending go past the old hold.
        await holds.increment(s.holdId!, newTotal);
        // Then the clearing deposit, so the ledger's hold (what the engine spends against) is raised last.
        if (this.d.clearing) {
          await this.d.clearing.raiseDeposit(jobId, newTotal);
          ledger.log(jobId, "clearing.deposit_raised", { amount: newTotal, source: this.d.clearing.source });
        }
        ledger.recordIncrement(jobId, newTotal);
        return;
      } catch (e) {
        ledger.log(jobId, "hold.increment_failed", { error: String(e) });
      }
    }
    this.degrade(s, headroom(this.budget(s)), answer === "approved" ? "increment declined by issuer" : `customer ${answer}`);
  }

  /** Resolve any payment left pending by a crash, from the rail's own record. */
  private async resolvePending(s: JobState) {
    const { ledger, float } = this.d;
    const jobId = s.spec.id;
    for (const p of ledger.payments(jobId).filter((x) => x.status === "pending")) {
      const settled = await float.lookup(p.key);
      if (settled) {
        ledger.markPaid(p.key, settled.txHash);
        await this.signTotal(jobId, p.payTo);
      } else ledger.markFailed(p.key, "unresolved at job end");
    }
  }

  private async settleHold(s: JobState, opts: RunOptions) {
    const { ledger, holds, clearing } = this.d;
    const jobId = s.spec.id;
    const h = ledger.hold(jobId);
    if (!h || h.status !== "authorized") return;
    const cs = clearing?.status(jobId);
    if (cs && !cs.final && !this.d.sabotage?.captureBeforeFinality) {
      // Never capture against payments clearing has not finalized. The startup sweeper retries this hold.
      ledger.log(jobId, "hold.capture_deferred", { why: "clearing not final", source: clearing!.source });
      return;
    }
    const spent = ledger.spent(jobId);
    const amount = this.d.sabotage?.captureFullHold ? h.authorized : Math.min(floorToCent(spent), h.authorized);
    for (let i = 0; i <= (opts.maxPayRetries ?? 3); i++) {
      try {
        if (amount === 0) {
          await holds.cancel(h.holdId, s.error ? "job_failed" : "nothing_spent");
          ledger.recordCancel(jobId, s.error ? "job failed, nothing spent" : "nothing spent");
        } else {
          await holds.capture(h.holdId, amount);
          ledger.recordCapture(jobId, amount);
        }
        return;
      } catch (e) {
        if (!(e instanceof TransientError)) {
          ledger.log(jobId, "hold.settle_failed", { error: String(e) });
          return;
        }
      }
    }
    ledger.log(jobId, "hold.settle_failed", { error: "retries exhausted" });
  }

  // ------------------------------------------------------------ clearing

  /** Express everything this job has paid `payTo` so far as one signed cumulative total. */
  private async signTotal(jobId: string, payTo: string) {
    const { clearing, ledger } = this.d;
    if (!clearing) return;
    const who = payTo.toLowerCase();
    const cumulative = ledger
      .payments(jobId)
      .filter((p) => p.status === "paid" && p.payTo.toLowerCase() === who)
      .reduce((sum, p) => sum + p.amount, 0);
    const t = await clearing.signRunningTotal(jobId, payTo, cumulative);
    ledger.log(jobId, "clearing.total_signed", { payee: who, cumulative: t.cumulative, epoch: t.epoch, signature: t.signature, source: clearing.source });
  }

  private async closeAndSettleEpoch() {
    const { clearing, ledger } = this.d;
    if (!clearing) return;
    const epoch = await clearing.closeEpoch();
    const redeemed = await clearing.settle(epoch);
    ledger.log(null, "clearing.epoch_settled", { epoch, redemptions: redeemed.length, source: clearing.source });
    for (const r of redeemed) {
      ledger.log(r.jobKey, "clearing.redeemed", { payee: r.payee, cumulative: r.cumulative, amount: r.amount, epoch, source: clearing.source });
    }
  }

  /** Close the last epoch, settle it, and withdraw every job's unused deposit. */
  private async finalizeClearing() {
    const { clearing, ledger } = this.d;
    if (!clearing) return;
    try {
      await this.closeAndSettleEpoch();
      for (const jobId of this.jobs.keys()) {
        const cs = clearing.status(jobId);
        if (!cs || cs.final) continue;
        const { amount } = await clearing.withdraw(jobId);
        ledger.log(jobId, "clearing.withdrawn", { amount, redeemed: cs.redeemed, source: clearing.source });
      }
    } catch (e) {
      ledger.log(null, "clearing.finalize_failed", { error: String(e), source: clearing.source });
    }
  }

  // ------------------------------------------------------------ helpers

  private budget(s: JobState): JobBudget {
    const { ledger } = this.d;
    return {
      holdAmount: ledger.hold(s.spec.id)?.authorized ?? 0,
      spent: ledger.spent(s.spec.id),
      inFlight: ledger.inFlight(s.spec.id),
    };
  }

  private choiceBudget(s: JobState): JobBudget {
    const b = this.budget(s);
    return this.d.sabotage?.ignoreHold ? { ...b, holdAmount: Number.MAX_SAFE_INTEGER } : b;
  }

  private floatLeft(s: JobState): Micros {
    return s.floatAllowance - s.floatSpent;
  }

  private grantReserve(active: JobState[]) {
    if (this.reserveLeft <= 0) return;
    const { catalog } = this.d;
    const requests = active.map((s) => ({
      jobId: s.spec.id,
      shortfall: Math.max(
        0,
        Math.min(estimateRemaining(s.remaining, catalog, this.health), headroom(this.budget(s))) - this.floatLeft(s),
      ),
      completedSteps: s.done,
      totalSteps: s.total,
    }));
    // Pass 1: fund whole remaining plans, jobs closest to finishing first.
    this.applyGrants(allocateReserve(requests, this.reserveLeft), "covers the rest of the job; closest to finishing");
    if (this.reserveLeft <= 0) return;
    // Pass 2: whatever is left keeps blocked jobs moving one step at a time, same priority order.
    const nextStep = active.map((s) => ({
      jobId: s.spec.id,
      shortfall: Math.max(
        0,
        Math.min(estimateRemaining(s.remaining.slice(0, 1), catalog, this.health), headroom(this.budget(s))) - this.floatLeft(s),
      ),
      completedSteps: s.done,
      totalSteps: s.total,
    }));
    this.applyGrants(allocateReserve(nextStep, this.reserveLeft), "covers its next step; closest to finishing");
  }

  private applyGrants(alloc: ReturnType<typeof allocateReserve>, why: string) {
    for (const jobId of alloc.order) {
      const g = alloc.grants.get(jobId)!;
      this.jobs.get(jobId)!.floatAllowance += g;
      this.reserveLeft -= g;
      this.d.ledger.log(jobId, "reserve.granted", { amount: g, why, reserveLeft: this.reserveLeft });
    }
  }

  private degrade(s: JobState, room: Micros, why: string) {
    const plan = degradePlan(s.remaining, Math.max(0, room), this.d.catalog, this.health, s.failedProviders);
    s.remaining = plan.steps;
    s.dropped.push(...plan.dropped);
    s.limited = true;
    this.d.ledger.log(s.spec.id, "job.degraded", { why, note: plan.note, dropped: plan.dropped });
  }

  private drop(s: JobState, step: Step, why: string) {
    s.remaining = s.remaining.filter((x) => x !== step);
    s.dropped.push(step.id);
    if (!step.optional) s.limited = true;
    this.d.ledger.log(s.spec.id, "step.dropped", { stepId: step.id, why });
  }

  private finish(s: JobState) {
    s.finished = true;
    const unused = this.floatLeft(s);
    if (unused > 0) {
      // Unspent allowance goes back to the shared pool for jobs still running.
      this.reserveLeft += unused;
      s.floatAllowance -= unused;
    }
    this.d.ledger.log(s.spec.id, "job.finished", { limited: s.limited, returnedToPool: unused });
  }

  private premiumOnly(steps: Step[]): Micros {
    let t = 0;
    for (const step of steps) {
      const costs = this.d.catalog.filter((p) => p.kind === step.kind).map((p) => p.pricePerUnit * step.units);
      if (costs.length) t += Math.max(...costs);
    }
    return t;
  }

  private shuffle<T>(xs: T[]): T[] {
    const a = [...xs];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.d.rng() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  private result(s: JobState): JobResult {
    const h = this.d.ledger.hold(s.spec.id);
    return {
      jobId: s.spec.id,
      status: s.error ? "failed" : s.limited ? "budget_limited" : "completed",
      holdFinal: h?.authorized ?? 0,
      spent: this.d.ledger.spent(s.spec.id),
      captured: h?.status === "captured" ? h.captured : 0,
      holdOutcome: !h ? "none" : h.status === "captured" ? "captured" : h.status === "cancelled" ? "cancelled" : "none",
      stepsDone: s.done,
      stepsTotal: s.total,
      dropped: s.dropped,
      outputs: s.outputs,
      premiumOnlyCost: s.premiumOnlyCost,
      error: s.error,
    };
  }
}
