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
import { Ledger, MemoryStore, type LedgerEvent, type LedgerStore } from "../ledger/ledger.ts";
import { openRunLedger, RUN_RAILS_EVENT, type PaymentRail } from "./recover.ts";
import { CATALOG, ROGUE_PROVIDER_ID, providerById } from "../policy/catalog.ts";
import { DEFAULT_POLICY } from "../policy/types.ts";
import type { Micros } from "../money.ts";
import { MockAirwallex } from "../payments/mock-airwallex.ts";
import type { AirwallexHoldGateway } from "../payments/airwallex.ts";
import { BrowserConfirmedHolds, holdStatusOf } from "../payments/airwallex-browser.ts";
import type { HoldsView } from "../sim/harness.ts";
import { MockMetal } from "../payments/mock-metal.ts";
import type { FloatGateway } from "../payments/types.ts";
import type { MetalFloatGateway } from "../payments/metal.ts";
import { auditPaymentsOnChain, METAL_EXPLORER_TX } from "../payments/metal-audit.ts";
import { MockMandateGateway, type MetalMandateGateway } from "../payments/mandate.ts";
import { MandateManager } from "../payments/mandate-manager.ts";
import { freshHealth } from "../policy/policy.ts";
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
  /** The card hold's id: an Airwallex PaymentIntent (int_…) when live. */
  holdId?: string;
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
  /** The Metal mandate the batch paid through, if any (the second lock). */
  mandate: { source: "live" | "simulated"; mandateId: string; bindTx: string; revokeTx: string | null; budget: Micros; perPaymentCap: Micros; payees: number } | null;
  /** Card holds: MockAirwallex, or Airwallex PaymentIntents read back from Airwallex after the run. */
  holds: { source: "live" | "simulated" };
}

/** The live Metal rail for dashboard runs: x402 straight from the agent wallet, no mandate. */
export interface LiveMetal {
  rpcUrl: string;
  /** A fresh gateway per run, so float accounting starts at zero. */
  makeFloat: () => MetalFloatGateway;
}

/** The live Metal rail through a mandate: payments are `mandate pull`s from the owner's account. */
export interface LiveMandate {
  rpcUrl: string;
  makeGateway: () => MetalMandateGateway;
}

/** Live Airwallex card holds: the customer confirms each PaymentIntent in Drop-in on the dashboard. */
export interface LiveAirwallex {
  /** A client whose request_ids are unique to this run (job ids A, B, C repeat across runs). */
  makeApi: (runTag: string) => AirwallexHoldGateway;
  /** How long to wait for a customer to enter their card (default 5 minutes). */
  cardTimeoutMs?: number;
  /**
   * Where each run's ledger is kept (`<dir>/<runTag>.db`). Real holds outlive the process, so the
   * ledger must too: the engine sweeps these files on startup (src/server/recover.ts).
   */
  ledgerDir?: string;
}

/** Airwallex amounts are decimal major units; holds are whole cents. */
const majorToMicros = (major: number): Micros => Math.round(major * 100) * 10_000;

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
  /** The customer must place the card hold in Airwallex Drop-in. The client_secret is meant for the browser. */
  | { kind: "card.required"; runId: number; jobId: string; customer: string; amount: Micros; currency: string; holdId: string; clientSecret: string; deadline: number }
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
  private ledgerStore: { close(): void } | null = null;
  private pendingOverrun = false;
  private mandateManager: MandateManager | null = null;
  private engine: Orchestrator | null = null;
  /** The dashboard's "mandate test" switch, read by the engine on every purchase. */
  private readonly demo = { bypassQuoteCheck: false };

  constructor(
    private readonly opts: {
      llm?: GuardedLlm;
      paceScale?: number;
      approvalTimeoutMs?: number;
      /** Live x402 from the agent wallet (no mandate). */
      live?: LiveMetal;
      /** Live payments through a Metal mandate on the owner's account. */
      liveMandate?: LiveMandate;
      /** Live card holds: Airwallex PaymentIntents confirmed by the customer in Drop-in. */
      liveAirwallex?: LiveAirwallex;
    } = {},
  ) {}

  get holdsSource(): "live" | "simulated" {
    return this.opts.liveAirwallex ? "live" : "simulated";
  }

  get railSource(): "live" | "simulated" {
    return this.opts.live || this.opts.liveMandate ? "live" : "simulated";
  }

  /** Whether runs pay through a mandate, and whether that mandate is on chain. */
  get mandateSource(): "live" | "simulated" | "none" {
    return this.opts.liveMandate ? "live" : this.opts.live ? "none" : "simulated";
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
    if (!this.running || !this.providers || !this.ledger) return { ok: false, message: "Start a run first." };
    if (action === "mandate_test") {
      if (!this.mandateManager?.active) {
        return { ok: false, message: "This run pays straight from the agent wallet, with no mandate. Use engine:offline or engine:live-mandate." };
      }
      // Deliberate test: turn OUR quote check off, point the rogue at an unregistered address and
      // give it another chance. Only the Metal mandate is left to stop the payment.
      this.demo.bypassQuoteCheck = true;
      await this.providers.control(ROGUE_PROVIDER_ID, { mode: "wrong_payee" });
      const rogue = providerById(ROGUE_PROVIDER_ID);
      this.engine?.health.set(rogue.id, freshHealth(rogue));
      this.ledger.log(null, "fault.mandate_test", {
        providerId: rogue.id,
        why: "deliberate test: our quote check is off and the rogue asks to be paid at an unregistered address; only the Metal mandate can stop it",
        mandate: this.mandateManager.source,
      });
      return { ok: true, message: `Our quote check is OFF. ${rogue.id} will ask to be paid at an unregistered address; watch the ${this.mandateManager.source} Metal mandate refuse it.` };
    }
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
    this.demo.bypassQuoteCheck = false;
    const liveCards = this.opts.liveAirwallex;
    const runTag = `r${Date.now().toString(36)}`;
    this.ledgerStore?.close();
    this.ledgerStore = null;
    let store: LedgerStore = new MemoryStore();
    if (liveCards?.ledgerDir) {
      const sqlite = openRunLedger(liveCards.ledgerDir, runTag);
      this.ledgerStore = sqlite;
      store = sqlite;
    }
    const ledger: Ledger = new Ledger(store, Date.now, (event) => {
      this.emit({ kind: "event", runId, event, fact: describe(event), policy: policyReason(event) });
      // The mandate test is over once the mandate has refused a payment: our own check comes back on.
      if (event.type === "mandate.refused" && this.demo.bypassQuoteCheck) {
        this.demo.bypassQuoteCheck = false;
        queueMicrotask(() => ledger.log(null, "demo.quote_check_restored", { why: "the Metal mandate refused the payment; our own quote check is back on" }));
      }
    });
    // Card holds: simulated, or real PaymentIntents the customer confirms in Drop-in on the dashboard.
    const airwallex: MockAirwallex | BrowserConfirmedHolds = liveCards
      ? new BrowserConfirmedHolds(
          liveCards.makeApi(runTag),
          (req) =>
            this.emit({
              kind: "card.required",
              runId,
              ...req,
              customer: DEMO_JOBS.find((j) => j.id === req.jobId)?.customer ?? req.jobId,
              deadline: Date.now() + (liveCards.cardTimeoutMs ?? 5 * 60_000),
            }),
          { timeoutMs: liveCards.cardTimeoutMs ?? 5 * 60_000 },
        )
      : new MockAirwallex();
    const live = this.opts.live;
    const liveMandate = this.opts.liveMandate;
    const rpcUrl = live?.rpcUrl ?? liveMandate?.rpcUrl;
    let float: FloatGateway;
    let backend: ProviderBackend;
    let manager: MandateManager | null = null;
    try {
      if (live) {
        const gw = live.makeFloat();
        // Refuse before anything moves if the RPC is wrong or the clock is off chain time.
        await gw.preflight();
        float = gw;
        backend = await liveBackend(live.rpcUrl);
      } else if (liveMandate) {
        manager = new MandateManager(liveMandate.makeGateway(), CATALOG, DEFAULT_POLICY.maxHold);
        float = manager;
        backend = await liveBackend(liveMandate.rpcUrl);
      } else {
        // Offline the mandate is simulated, but it still stands between the engine and the rail.
        manager = new MandateManager(new MockMandateGateway(), CATALOG, DEFAULT_POLICY.maxHold);
        float = manager;
        backend = mockBackend(rng);
      }
    } catch (e) {
      this.emit({ kind: "run.failed", runId, error: `live rail not ready: ${String(e).replace(rpcUrl ?? "\u0000", "<rpc>")}` });
      return;
    }
    // First record: which rail pays, so a sweep after a crash knows how to resolve pending payments.
    const paymentRail: PaymentRail = live ? "x402" : liveMandate ? "mandate" : "simulated";
    ledger.log(null, RUN_RAILS_EVENT, { runTag, holds: liveCards ? "airwallex" : "simulated", payments: paymentRail });
    manager?.attach(ledger);
    this.mandateManager = manager;
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
        demo: this.demo,
        onHoldIncremented: manager ? (jobId, from, to) => manager!.onHoldIncreased(jobId, from, to) : undefined,
      });
      this.engine = engine;
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
      this.demo.bypassQuoteCheck = false;
      // Batch over: revoke the mandate so nothing more can be paid under it.
      await manager?.close();

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
      this.demo.bypassQuoteCheck = false;
      await manager?.close().catch((err) => ledger.log(null, "mandate.revoke_failed", { error: String(err) }));
      this.emit({ kind: "run.failed", runId, error: String(e).replace(rpcUrl ?? "\u0000", "<rpc>") });
    }
  }

  private async summarize(
    results: JobResult[],
    ledger: Ledger,
    airwallex: MockAirwallex | BrowserConfirmedHolds,
    float: FloatGateway,
    clearing: ClearingEmulator,
    recorder: RecordingProviders,
    writer?: ReportWritingProviders,
  ): Promise<RunSummary> {
    const events = ledger.events();
    const live = this.opts.live;
    const manager = float instanceof MandateManager ? float : undefined;
    const metal =
      float instanceof MockMetal ? float : manager?.gateway instanceof MockMandateGateway ? manager.gateway.metal : undefined;
    const rpcUrl = live?.rpcUrl ?? this.opts.liveMandate?.rpcUrl;
    // On chain, payments come from the agent wallet (x402) or the owner's account (mandate).
    const payer = live ? (float as MetalFloatGateway).address : this.opts.liveMandate ? manager?.gateway.payer : undefined;
    const isLive = Boolean(rpcUrl);
    // What the rail actually settled, per payment key: the mock's own record, or each tx re-read from chain.
    const settled: { key: string; payTo: string; amount: Micros }[] = [];
    const chainProblems: string[] = [];
    if (metal) {
      for (const s of metal.settlements.values()) settled.push(s);
    } else if (rpcUrl && payer) {
      const paid = ledger.payments().filter((p) => p.status === "paid");
      const audited = await auditPaymentsOnChain(rpcUrl, payer, paid);
      for (const a of audited) {
        if (!a.succeeded) chainProblems.push(`chain.not_settled: ${a.key} tx ${a.txHash || "(none)"}`);
        settled.push({ key: a.key, payTo: a.payTo, amount: a.amount });
      }
    }
    const settledFor = (jobId: string) => settled.filter((s) => s.key.startsWith(`${jobId}:`)).reduce((a, s) => a + s.amount, 0);

    // Card holds as the card side reports them: MockAirwallex's own records, or each
    // PaymentIntent read back from Airwallex after the run (not what our ledger believes).
    const heldBy = new Map<string, { holdId: string; jobId: string; status: string; authorized: Micros; captured: Micros }>();
    const holdProblems: string[] = [];
    if (airwallex instanceof MockAirwallex) {
      for (const h of airwallex.holds.values()) heldBy.set(h.holdId, h);
    } else {
      for (const r of results) {
        const row = ledger.hold(r.jobId);
        if (!row) continue;
        let intent;
        try {
          intent = await airwallex.api.retrieve(row.holdId);
        } catch (e) {
          // Cannot see what the card side holds, so it cannot reconcile: say so instead of failing the run.
          holdProblems.push(`airwallex.unreadable: ${row.holdId} could not be read back (${String(e)})`);
          continue;
        }
        const status = holdStatusOf(intent);
        const capturedMajor = intent.captured_amount ?? intent.latest_payment_attempt?.captured_amount;
        if (status === "captured" && capturedMajor === undefined) holdProblems.push(`airwallex.captured_unknown: ${row.holdId} reports no captured amount`);
        heldBy.set(row.holdId, {
          holdId: row.holdId,
          jobId: r.jobId,
          status,
          authorized: majorToMicros(intent.amount),
          captured: status === "captured" ? majorToMicros(capturedMajor ?? 0) : 0,
        });
      }
    }
    const holdsView: HoldsView = { violations: airwallex instanceof MockAirwallex ? airwallex.violations : [], holds: heldBy };
    const jobs = results.map((r): JobSummary => {
      const spec = DEMO_JOBS.find((j) => j.id === r.jobId)!;
      const hold = [...heldBy.values()].find((h) => h.jobId === r.jobId);
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
        holdId: hold?.holdId,
        premiumOnly: r.premiumOnlyCost,
        dropped: r.dropped,
        receipt: receiptFor(r.jobId, ledger, events, recorder, isLive ? "live" : "simulated"),
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
      ...checkInvariants({ ledger, airwallex: holdsView, metal, railSettlements: metal ? undefined : settled, quoted: recorder.quoted, clearing }),
      ...chainProblems,
      ...holdProblems,
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
      rail: isLive ? { source: "live", payer, network: "Metal testnet (eip155:63825)" } : { source: "simulated" },
      holds: { source: airwallex instanceof MockAirwallex ? "simulated" : "live" },
      mandate: manager?.active
        ? {
            source: manager.source,
            mandateId: manager.active.mandateId,
            bindTx: manager.active.bindTx,
            revokeTx: manager.active.revokeTx,
            budget: manager.active.budget,
            perPaymentCap: manager.active.perPaymentCap,
            payees: manager.active.payees.length,
          }
        : null,
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
