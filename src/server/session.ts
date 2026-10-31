/**
 * One dashboard demo run: the scripted three-job scenario in the fully mocked world, with a
 * human answering hold increases (PendingApprovals) and demo buttons injecting faults.
 *
 * Everything the dashboard shows comes from here: ledger events as they happen, and at the end
 * receipts and the reconciliation computed from the mock rails themselves (not from the feed),
 * plus the invariant check the simulation uses.
 */
import { Ledger, MemoryStore, type LedgerEvent } from "../ledger/ledger.ts";
import { CATALOG, ROGUE_PROVIDER_ID, providerById } from "../policy/catalog.ts";
import { DEFAULT_POLICY } from "../policy/types.ts";
import type { Micros } from "../money.ts";
import { MockAirwallex } from "../payments/mock-airwallex.ts";
import { MockMetal } from "../payments/mock-metal.ts";
import { InProcessProviders } from "../providers/in-process.ts";
import type { ProviderMode } from "../providers/logic.ts";
import { Orchestrator, type JobResult } from "../engine/orchestrator.ts";
import { PendingApprovals, TagJudge, type ProviderPort, type QualityJudge } from "../engine/ports.ts";
import { ClearingEmulator } from "../clearing/emulator.ts";
import { EMULATOR_TEST_KEY, Eip712Signer } from "../clearing/signer.ts";
import { describe, policyReason } from "../agent/describe.ts";
import { Explainer } from "../agent/explainer.ts";
import type { GuardedLlm } from "../agent/guard.ts";
import { LlmJudge } from "../agent/judge.ts";
import { ReportWritingProviders, type ReportSection } from "../agent/report-providers.ts";
import { checkInvariants, RecordingProviders } from "../sim/harness.ts";
import { seeded } from "../sim/rng.ts";
import { DEMO_FLOAT, DEMO_JOBS, DEMO_RESERVE, DEMO_TOPICS } from "../sim/scenario.ts";

export type ControlAction = "overrun_b" | "slow_lite" | "rogue_overquote" | "rogue_wrong_payee" | "rogue_junk" | "rogue_honest" | "mandate_test";

export interface ReceiptRow {
  stepId: string;
  providerId: string;
  status: "paid" | "refused";
  listPrice: Micros;
  quoted: Micros;
  paid: Micros;
  txHash?: string;
  txSource: "simulated";
  clearingTotal?: Micros;
  why: string | null;
}

export interface JobSummary {
  jobId: string;
  customer: string;
  topic: string;
  status: JobResult["status"];
  holdInitial: Micros;
  holdFinal: Micros;
  ledgerPaid: Micros;
  railSettled: Micros;
  clearingRedeemed: Micros;
  captured: Micros;
  released: Micros;
  holdOutcome: JobResult["holdOutcome"];
  premiumOnly: Micros;
  dropped: string[];
  receipt: ReceiptRow[];
  report: ReportSection[];
}

export interface RunSummary {
  jobs: JobSummary[];
  totals: { ledgerPaid: Micros; railSettled: Micros; clearingRedeemed: Micros; captured: Micros; premiumOnly: Micros; floatDeposited: Micros; floatWithdrawn: Micros };
  reconciled: boolean;
  violations: string[];
  llm: { calls: number; failures: number; tripped: string | null } | null;
}

export type SessionMessage =
  | { kind: "run.started"; runId: number; scripted: boolean; float: Micros; reserve: Micros; jobs: { id: string; customer: string; topic: string; hold: Micros; steps: { id: string; kind: string; units: number }[] }[] }
  | { kind: "event"; runId: number; event: LedgerEvent; fact: string | null; policy: string | null }
  | { kind: "approval.requested"; runId: number; jobId: string; customer: string; current: Micros; newTotal: Micros; reason: string; deadline: number }
  | { kind: "feed.phrased"; runId: number; lines: Record<number, string> }
  | { kind: "run.finished"; runId: number; summary: RunSummary }
  | { kind: "run.failed"; runId: number; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Slows deliveries down to a watchable pace: a fraction of each provider's reported latency. */
class PacedProviders implements ProviderPort {
  constructor(
    private readonly inner: ProviderPort,
    private readonly scale: number,
  ) {}
  requestQuote(...a: Parameters<ProviderPort["requestQuote"]>) {
    return this.inner.requestQuote(...a);
  }
  async deliver(...a: Parameters<ProviderPort["deliver"]>) {
    const out = await this.inner.deliver(...a);
    if (this.scale > 0) await sleep(Math.round(out.latencyMs * this.scale));
    return out;
  }
}

export class DemoSession {
  private runId = 0;
  private running = false;
  /** Messages of the current run, replayed to late subscribers (a reloaded page). */
  private history: SessionMessage[] = [];
  private readonly listeners = new Set<(m: SessionMessage) => void>();
  private approvals: PendingApprovals | null = null;
  private providers: InProcessProviders | null = null;
  private ledger: Ledger | null = null;
  private pendingOverrun = false;

  constructor(
    private readonly opts: { llm?: GuardedLlm; paceScale?: number; approvalTimeoutMs?: number } = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  subscribe(fn: (m: SessionMessage) => void): () => void {
    for (const m of this.history) fn(m);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(m: SessionMessage) {
    this.history.push(m);
    for (const fn of this.listeners) fn(m);
  }

  approve(jobId: string): boolean {
    if (!this.approvals?.list().some((r) => r.jobId === jobId)) return false;
    this.approvals.approve(jobId);
    return true;
  }

  decline(jobId: string): boolean {
    if (!this.approvals?.list().some((r) => r.jobId === jobId)) return false;
    this.approvals.decline(jobId);
    return true;
  }

  /** Demo buttons. Returns what happened, for the button's toast. */
  control(action: ControlAction): { ok: boolean; message: string } {
    if (action === "mandate_test") {
      return { ok: false, message: "Needs Metal mandates (§5.3), not built yet. Nothing was changed." };
    }
    if (!this.running || !this.providers || !this.ledger) return { ok: false, message: "Start a run first." };
    if (action === "overrun_b") {
      if (!this.pendingOverrun) this.pendingOverrun = true;
      return { ok: true, message: "Job B's analysis step will grow ×4 at the next round." };
    }
    if (action === "slow_lite") {
      this.providers.control("model-lite", { latencyMs: 2500 });
      this.ledger.log(null, "fault.provider_slowed", { providerId: "model-lite", latencyMs: 2500 });
      return { ok: true, message: "model-lite now answers in ~2.5 s." };
    }
    const mode = action.replace("rogue_", "") as ProviderMode;
    this.providers.control(ROGUE_PROVIDER_ID, { mode, overquoteFactor: 3 });
    this.ledger.log(null, "fault.rogue_mode", { providerId: ROGUE_PROVIDER_ID, mode });
    return { ok: true, message: `${ROGUE_PROVIDER_ID} now behaves "${mode}".` };
  }

  /**
   * Start a run. `scripted` injects the submission's faults on cue (B's overrun and the 1¢
   * model slowdown at round 2, C's overrun at round 3, the rogue provider overquoting), so the
   * demo hits every beat; the presenter still answers every hold increase.
   */
  start(opts: { scripted: boolean }): { ok: boolean; runId?: number; message?: string } {
    if (this.running) return { ok: false, message: "A run is already in progress." };
    this.running = true;
    const runId = ++this.runId;
    this.history = [];
    this.pendingOverrun = false;
    void this.run(runId, opts.scripted).finally(() => {
      this.running = false;
      this.approvals = null;
    });
    return { ok: true, runId };
  }

  private async run(runId: number, scripted: boolean) {
    const rng = seeded(42);
    const ledger = new Ledger(new MemoryStore(), Date.now, (event) =>
      this.emit({ kind: "event", runId, event, fact: describe(event), policy: policyReason(event) }),
    );
    const airwallex = new MockAirwallex();
    const metal = new MockMetal();
    const mock = new InProcessProviders(CATALOG, rng);
    if (scripted) mock.control(ROGUE_PROVIDER_ID, { mode: "overquote", overquoteFactor: 3 });
    const llm = this.opts.llm;
    const writer = llm ? new ReportWritingProviders(mock, llm, DEMO_TOPICS, (id) => mock.get(id).mode) : undefined;
    const recorder = new RecordingProviders(new PacedProviders(writer ?? mock, this.opts.paceScale ?? 0.6));
    const judge: QualityJudge = llm ? new LlmJudge(llm, { kinds: ["model"], other: new TagJudge() }) : new TagJudge();
    const clearing = new ClearingEmulator(new Eip712Signer(EMULATOR_TEST_KEY));
    const approvals = new PendingApprovals(this.opts.approvalTimeoutMs ?? 30_000, (req) =>
      this.emit({ kind: "approval.requested", runId, ...req, deadline: Date.now() + (this.opts.approvalTimeoutMs ?? 30_000) }),
    );
    this.approvals = approvals;
    this.providers = mock;
    this.ledger = ledger;

    this.emit({
      kind: "run.started",
      runId,
      scripted,
      float: DEMO_FLOAT,
      reserve: DEMO_RESERVE,
      jobs: DEMO_JOBS.map((j) => ({
        id: j.id,
        customer: j.customer,
        topic: DEMO_TOPICS.get(j.id) ?? "",
        hold: j.hold,
        steps: j.steps.map((s) => ({ id: s.id, kind: s.kind, units: s.units })),
      })),
    });

    try {
      const engine = new Orchestrator({
        ledger, holds: airwallex, float: metal, providers: recorder, judge, customers: approvals, clearing,
        catalog: CATALOG, policy: DEFAULT_POLICY, rng,
      });
      const results = await engine.run(DEMO_JOBS, {
        float: DEMO_FLOAT,
        reserve: DEMO_RESERVE,
        onRound: (round, eng) => {
          if (this.pendingOverrun || (scripted && round === 2)) {
            this.pendingOverrun = false;
            eng.mutateStep("B", "analysis", (s) => ({ ...s, units: s.units * 4 }));
          }
          if (scripted && round === 2) this.control("slow_lite");
          if (scripted && round === 3) eng.mutateStep("C", "compare", (s) => ({ ...s, units: s.units * 3 }));
        },
      });

      const summary = this.summarize(results, ledger, airwallex, metal, clearing, recorder, writer);
      this.emit({ kind: "run.finished", runId, summary });

      // Phrase the feed once at the end (one batched LLM call), then upgrade the lines in place.
      if (llm) {
        const explained = await new Explainer(llm).explainAll(ledger.events());
        const lines: Record<number, string> = {};
        for (const x of explained) if (x.lineSource === "llm") lines[x.seq] = x.line;
        if (Object.keys(lines).length) this.emit({ kind: "feed.phrased", runId, lines });
      }
    } catch (e) {
      this.emit({ kind: "run.failed", runId, error: String(e) });
    }
  }

  private summarize(
    results: JobResult[],
    ledger: Ledger,
    airwallex: MockAirwallex,
    metal: MockMetal,
    clearing: ClearingEmulator,
    recorder: RecordingProviders,
    writer?: ReportWritingProviders,
  ): RunSummary {
    const events = ledger.events();
    const jobs = results.map((r): JobSummary => {
      const spec = DEMO_JOBS.find((j) => j.id === r.jobId)!;
      const hold = [...airwallex.holds.values()].find((h) => h.jobId === r.jobId);
      const settled = [...metal.settlements.values()].filter((s) => s.key.startsWith(`${r.jobId}:`)).reduce((a, s) => a + s.amount, 0);
      const captured = hold?.status === "captured" ? hold.captured : 0;
      return {
        jobId: r.jobId,
        customer: spec.customer,
        topic: DEMO_TOPICS.get(r.jobId) ?? "",
        status: r.status,
        holdInitial: spec.hold,
        holdFinal: r.holdFinal,
        ledgerPaid: r.spent,
        railSettled: settled,
        clearingRedeemed: clearing.status(r.jobId)?.redeemed ?? 0,
        captured,
        released: (hold?.authorized ?? 0) - captured,
        holdOutcome: r.holdOutcome,
        premiumOnly: r.premiumOnlyCost,
        dropped: r.dropped,
        receipt: receiptFor(r.jobId, ledger, events, recorder),
        report: writer?.report(r.jobId) ?? [],
      };
    });
    const sum = (f: (j: JobSummary) => Micros) => jobs.reduce((a, j) => a + f(j), 0);
    const totals = {
      ledgerPaid: sum((j) => j.ledgerPaid),
      railSettled: metal.totalSettled(),
      clearingRedeemed: clearing.redemptions.reduce((a, x) => a + x.amount, 0),
      captured: sum((j) => j.captured),
      premiumOnly: sum((j) => j.premiumOnly),
      floatDeposited: metal.deposited,
      floatWithdrawn: metal.withdrawn,
    };
    const violations = checkInvariants({ ledger, airwallex, metal, quoted: recorder.quoted, clearing });
    const perJobOk = jobs.every((j) => j.ledgerPaid === j.railSettled && j.railSettled === j.clearingRedeemed && j.clearingRedeemed === j.captured);
    const totalOk = totals.ledgerPaid === totals.railSettled && totals.railSettled === totals.clearingRedeemed && totals.clearingRedeemed === totals.captured;
    const llm = this.opts.llm;
    return {
      jobs,
      totals,
      reconciled: perJobOk && totalOk && violations.length === 0,
      violations,
      llm: llm ? { calls: llm.calls, failures: llm.failures, tripped: llm.tripped } : null,
    };
  }
}

function receiptFor(jobId: string, ledger: Ledger, events: LedgerEvent[], recorder: RecordingProviders): ReceiptRow[] {
  const jobEvents = events.filter((e) => e.jobId === jobId);
  return ledger
    .payments(jobId)
    .filter((p) => p.status === "paid" || p.status === "refused")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => {
      const quoted = recorder.quoted.get(p.key.endsWith(":refused") ? "" : p.key);
      const units = quoted?.units ?? 1;
      const listPrice = providerById(p.providerId).pricePerUnit * units;
      const paidAt = jobEvents.find((e) => e.type === "payment.paid" && e.data.key === p.key)?.seq ?? Infinity;
      const total = jobEvents.find((e) => e.type === "clearing.total_signed" && e.seq > paidAt && e.data.payee === p.payTo.toLowerCase());
      const decision = [...jobEvents]
        .reverse()
        .find((e) => e.type === "agent.decision" && e.data.stepId === p.stepId && e.data.providerId === p.providerId && (paidAt === Infinity || e.seq < paidAt));
      return {
        stepId: p.stepId,
        providerId: p.providerId,
        status: p.status as "paid" | "refused",
        listPrice: p.status === "refused" ? (decision ? Number(decision.data.cost) : listPrice) : listPrice,
        quoted: p.amount,
        paid: p.status === "paid" ? p.amount : 0,
        txHash: p.txHash,
        txSource: "simulated",
        clearingTotal: total ? Number(total.data.cumulative) : undefined,
        why: p.status === "refused" ? (p.reason ?? null) : decision ? String(decision.data.why) : null,
      };
    });
}
