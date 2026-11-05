/**
 * One dashboard demo run: the scripted three-job scenario, with a human answering hold
 * increases (PendingApprovals) and demo buttons injecting faults.
 *
 * Two rails for provider payments:
 *  - simulated (default): MockMetal and in-process mock providers.
 *  - live (`live` option): MetalFloatGateway paying real x402 on Metal testnet, and HTTP
 *    providers that deliver only after reading each payment on chain (ChainPaymentVerifier).
 * Card holds (MockAirwallex) and clearing (ClearingEmulator) are SIMULATED either way.
 *
 * Everything the dashboard shows comes from here: ledger events as they happen, and at the end
 * receipts and the reconciliation computed from the rails themselves (on the live rail, every
 * payment is re-read from chain), plus the invariant check the simulation uses.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, MemoryStore, type LedgerEvent } from "../ledger/ledger.ts";
import { CATALOG, ROGUE_PROVIDER_ID, providerById } from "../policy/catalog.ts";
import { DEFAULT_POLICY } from "../policy/types.ts";
import type { Micros } from "../money.ts";
import { MockAirwallex } from "../payments/mock-airwallex.ts";
import { MockMetal } from "../payments/mock-metal.ts";
import type { FloatGateway } from "../payments/types.ts";
import type { MetalFloatGateway } from "../payments/metal.ts";
import { auditPaymentsOnChain, METAL_EXPLORER_TX } from "../payments/metal-audit.ts";
import { MockMandateGateway } from "../payments/mandate.ts";
import { MandateManager } from "../payments/mandate-manager.ts";
import { InProcessProviders } from "../providers/in-process.ts";
import { HttpProviders } from "../providers/http-client.ts";
import { createProviderServer } from "../providers/server.ts";
import { ChainPaymentVerifier } from "../providers/verify.ts";
import type { ProviderControl, ProviderMode } from "../providers/logic.ts";
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
  txSource: "live" | "simulated";
  /** Explorer page for a live transaction. Absent for mock hashes, which are on no chain. */
  txUrl?: string;
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
  /** Where "rail settled" came from: the mock rail, or each transaction re-read from Metal testnet. */
  rail: { source: "live" | "simulated"; payer?: string; network?: string };
}

/** The live Metal rail for dashboard runs. */
export interface LiveMetal {
  rpcUrl: string;
  /** A fresh gateway per run, so float accounting starts at zero. */
  makeFloat: () => MetalFloatGateway;
}

/** Providers the engine buys from, plus the demo-control hooks on them. */
interface ProviderBackend {
  port: ProviderPort;
  control(id: string, patch: Partial<ProviderControl>): Promise<void>;
  modeOf(id: string): ProviderMode;
  close(): void;
}

function mockBackend(rng: () => number): ProviderBackend {
  const mock = new InProcessProviders(CATALOG, rng);
  return {
    port: mock,
    control: async (id, patch) => mock.control(id, patch),
    modeOf: (id) => mock.get(id).mode,
    close: () => {},
  };
}

/** HTTP providers that only deliver after verifying the payment on Metal testnet. */
async function liveBackend(rpcUrl: string): Promise<ProviderBackend> {
  const server: Server = createProviderServer({ verifier: new ChainPaymentVerifier(rpcUrl), latencyScale: 0 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const modes = new Map<string, ProviderMode>();
  const control = async (id: string, patch: Partial<ProviderControl>) => {
    const res = await fetch(`${base}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: id, ...patch, latencyMs: "latencyMs" in patch ? (patch.latencyMs ?? null) : undefined }),
    });
    if (!res.ok) throw new Error(`provider control ${id}: ${res.status} ${await res.text()}`);
    if (patch.mode) modes.set(id, patch.mode);
  };
  // The provider server's controls outlive a run; start every run from honest, normal-speed providers.
  for (const p of CATALOG) await control(p.id, { mode: "honest", latencyMs: undefined, overquoteFactor: 2 });
  return { port: new HttpProviders(base), control, modeOf: (id) => modes.get(id) ?? "honest", close: () => server.close() };
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
  private providers: ProviderBackend | null = null;
  private ledger: Ledger | null = null;
  private pendingOverrun = false;
  private mandateManager: MandateManager | null = null;

  constructor(
    private readonly opts: { llm?: GuardedLlm; paceScale?: number; approvalTimeoutMs?: number; live?: LiveMetal } = {},
  ) {}

  get railSource(): "live" | "simulated" {
    return this.opts.live ? "live" : "simulated";
  }

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
  async control(action: ControlAction): Promise<{ ok: boolean; message: string }> {
    if (action === "mandate_test") {
      return { ok: false, message: "Needs Metal mandates (§5.3), not built yet. Nothing was changed." };
    }
    if (!this.running || !this.providers || !this.ledger) return { ok: false, message: "Start a run first." };
    if (action === "overrun_b") {
      if (!this.pendingOverrun) this.pendingOverrun = true;
      return { ok: true, message: "Job B's analysis step will grow ×4 at the next round." };
    }
    if (action === "slow_lite") {
      await this.providers.control("model-lite", { latencyMs: 2500 });
      this.ledger.log(null, "fault.provider_slowed", { providerId: "model-lite", latencyMs: 2500 });
      return { ok: true, message: "model-lite now answers in ~2.5 s." };
    }
    const mode = action.replace("rogue_", "") as ProviderMode;
    await this.providers.control(ROGUE_PROVIDER_ID, { mode, overquoteFactor: 3 });
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
    const live = this.opts.live;
    let float: FloatGateway;
    let backend: ProviderBackend;
    try {
      if (live) {
        const gw = live.makeFloat();
        // Refuse before anything moves if the RPC is wrong or the clock is off chain time.
        await gw.preflight();
        float = gw;
        backend = await liveBackend(live.rpcUrl);
      } else {
        float = new MockMetal();
        backend = mockBackend(rng);
      }
    } catch (e) {
      this.emit({ kind: "run.failed", runId, error: `live rail not ready: ${String(e).replace(live?.rpcUrl ?? "\u0000", "<rpc>")}` });
      return;
    }
    if (scripted) await backend.control(ROGUE_PROVIDER_ID, { mode: "overquote", overquoteFactor: 3 });
    const llm = this.opts.llm;
    const writer = llm ? new ReportWritingProviders(backend.port, llm, DEMO_TOPICS, (id) => backend.modeOf(id)) : undefined;
    const recorder = new RecordingProviders(new PacedProviders(writer ?? backend.port, this.opts.paceScale ?? 0.6));
    const judge: QualityJudge = llm ? new LlmJudge(llm, { kinds: ["model"], other: new TagJudge() }) : new TagJudge();
    const clearing = new ClearingEmulator(new Eip712Signer(EMULATOR_TEST_KEY));
    const approvals = new PendingApprovals(this.opts.approvalTimeoutMs ?? 30_000, (req) =>
      this.emit({ kind: "approval.requested", runId, ...req, deadline: Date.now() + (this.opts.approvalTimeoutMs ?? 30_000) }),
    );
    this.approvals = approvals;
    this.providers = backend;
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
        ledger, holds: airwallex, float, providers: recorder, judge, customers: approvals, clearing,
        catalog: CATALOG, policy: DEFAULT_POLICY, rng,
      });
      const results = await engine.run(DEMO_JOBS, {
        float: DEMO_FLOAT,
        reserve: DEMO_RESERVE,
        onRound: async (round, eng) => {
          if (this.pendingOverrun || (scripted && round === 2)) {
            this.pendingOverrun = false;
            eng.mutateStep("B", "analysis", (s) => ({ ...s, units: s.units * 4 }));
          }
          if (scripted && round === 2) await this.control("slow_lite");
          if (scripted && round === 3) eng.mutateStep("C", "compare", (s) => ({ ...s, units: s.units * 3 }));
        },
      });
      backend.close();

      const summary = await this.summarize(results, ledger, airwallex, float, clearing, recorder, writer);
      this.emit({ kind: "run.finished", runId, summary });

      // Phrase the feed once at the end (one batched LLM call), then upgrade the lines in place.
      if (llm) {
        const explained = await new Explainer(llm).explainAll(ledger.events());
        const lines: Record<number, string> = {};
        for (const x of explained) if (x.lineSource === "llm") lines[x.seq] = x.line;
        if (Object.keys(lines).length) this.emit({ kind: "feed.phrased", runId, lines });
      }
    } catch (e) {
      backend.close();
      this.emit({ kind: "run.failed", runId, error: String(e).replace(live?.rpcUrl ?? "\u0000", "<rpc>") });
    }
  }

  private async summarize(
    results: JobResult[],
    ledger: Ledger,
    airwallex: MockAirwallex,
    float: FloatGateway,
    clearing: ClearingEmulator,
    recorder: RecordingProviders,
    writer?: ReportWritingProviders,
  ): Promise<RunSummary> {
    const events = ledger.events();
    const live = this.opts.live;
    const metal = float instanceof MockMetal ? float : undefined;
    const payer = live ? (float as MetalFloatGateway).address : undefined;
    // What the rail actually settled, per payment key: the mock's own record, or each tx re-read from chain.
    const settled: { key: string; payTo: string; amount: Micros }[] = [];
    const chainProblems: string[] = [];
    if (metal) {
      for (const s of metal.settlements.values()) settled.push(s);
    } else if (live && payer) {
      const paid = ledger.payments().filter((p) => p.status === "paid");
      const audited = await auditPaymentsOnChain(live.rpcUrl, payer, paid);
      for (const a of audited) {
        if (!a.succeeded) chainProblems.push(`chain.not_settled: ${a.key} tx ${a.txHash || "(none)"}`);
        settled.push({ key: a.key, payTo: a.payTo, amount: a.amount });
      }
    }
    const settledFor = (jobId: string) => settled.filter((s) => s.key.startsWith(`${jobId}:`)).reduce((a, s) => a + s.amount, 0);
    const jobs = results.map((r): JobSummary => {
      const spec = DEMO_JOBS.find((j) => j.id === r.jobId)!;
      const hold = [...airwallex.holds.values()].find((h) => h.jobId === r.jobId);
      const captured = hold?.status === "captured" ? hold.captured : 0;
      return {
        jobId: r.jobId,
        customer: spec.customer,
        topic: DEMO_TOPICS.get(r.jobId) ?? "",
        status: r.status,
        holdInitial: spec.hold,
        holdFinal: r.holdFinal,
        ledgerPaid: r.spent,
        railSettled: settledFor(r.jobId),
        clearingRedeemed: clearing.status(r.jobId)?.redeemed ?? 0,
        captured,
        released: (hold?.authorized ?? 0) - captured,
        holdOutcome: r.holdOutcome,
        premiumOnly: r.premiumOnlyCost,
        dropped: r.dropped,
        receipt: receiptFor(r.jobId, ledger, events, recorder, live ? "live" : "simulated"),
        report: writer?.report(r.jobId) ?? [],
      };
    });
    const sum = (f: (j: JobSummary) => Micros) => jobs.reduce((a, j) => a + f(j), 0);
    const fromEvents = (type: string) => events.filter((e) => e.type === type).reduce((a, e) => a + Number(e.data.amount), 0);
    const totals = {
      ledgerPaid: sum((j) => j.ledgerPaid),
      railSettled: settled.reduce((a, s) => a + s.amount, 0),
      clearingRedeemed: clearing.redemptions.reduce((a, x) => a + x.amount, 0),
      captured: sum((j) => j.captured),
      premiumOnly: sum((j) => j.premiumOnly),
      floatDeposited: fromEvents("float.deposited"),
      floatWithdrawn: fromEvents("float.withdrawn"),
    };
    const violations = [
      ...checkInvariants({ ledger, airwallex, metal, railSettlements: metal ? undefined : settled, quoted: recorder.quoted, clearing }),
      ...chainProblems,
    ];
    const perJobOk = jobs.every((j) => j.ledgerPaid === j.railSettled && j.railSettled === j.clearingRedeemed && j.clearingRedeemed === j.captured);
    const totalOk = totals.ledgerPaid === totals.railSettled && totals.railSettled === totals.clearingRedeemed && totals.clearingRedeemed === totals.captured;
    const llm = this.opts.llm;
    return {
      jobs,
      totals,
      reconciled: perJobOk && totalOk && violations.length === 0,
      violations,
      llm: llm ? { calls: llm.calls, failures: llm.failures, tripped: llm.tripped } : null,
      rail: live ? { source: "live", payer, network: "Metal testnet (eip155:63825)" } : { source: "simulated" },
    };
  }
}

function receiptFor(jobId: string, ledger: Ledger, events: LedgerEvent[], recorder: RecordingProviders, rail: "live" | "simulated"): ReceiptRow[] {
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
        txSource: rail,
        txUrl: rail === "live" && p.status === "paid" && p.txHash ? `${METAL_EXPLORER_TX}${p.txHash}` : undefined,
        clearingTotal: total ? Number(total.data.cumulative) : undefined,
        why: p.status === "refused" ? (p.reason ?? null) : decision ? String(decision.data.why) : null,
      };
    });
}
