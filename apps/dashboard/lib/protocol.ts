/**
 * Wire types from the engine server. Mirrors src/server/session.ts and src/server/main.ts in the
 * engine; keep in step with them (the engine's test/server.test.ts exercises the real shapes).
 */
export type Micros = number;

export interface LedgerEvent {
  seq: number;
  at: number;
  jobId: string | null;
  type: string;
  data: Record<string, unknown>;
}

export interface ReportSection {
  stepId: string;
  providerId: string;
  text: string;
  source: "llm" | "placeholder";
}

export interface ReceiptRow {
  stepId: string;
  providerId: string;
  status: "paid" | "refused";
  listPrice: Micros;
  quoted: Micros;
  paid: Micros;
  txHash?: string;
  txSource: "live" | "simulated";
  /** Explorer page for a live transaction; absent for mock hashes, which are on no chain. */
  txUrl?: string;
  clearingTotal?: Micros;
  why: string | null;
}

export interface JobSummary {
  jobId: string;
  customer: string;
  topic: string;
  status: "completed" | "budget_limited" | "failed";
  holdInitial: Micros;
  holdFinal: Micros;
  ledgerPaid: Micros;
  railSettled: Micros;
  clearingRedeemed: Micros;
  captured: Micros;
  released: Micros;
  holdOutcome: "captured" | "cancelled" | "none";
  /** The card hold id: an Airwallex PaymentIntent (int_…) when live. */
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
  rail: { source: "live" | "simulated"; payer?: string; network?: string };
  /** Card holds: simulated, or Airwallex PaymentIntents read back from Airwallex. */
  holds: { source: "live" | "simulated" };
  /** The Metal mandate the batch paid through (the second lock), if any. */
  mandate: { source: "live" | "simulated"; mandateId: string; bindTx: string; revokeTx: string | null; budget: Micros; perPaymentCap: Micros; payees: number } | null;
}

export interface JobPlan {
  id: string;
  customer: string;
  topic: string;
  hold: Micros;
  steps: { id: string; kind: string; units: number }[];
}

export type SessionMessage =
  | { kind: "run.started"; runId: number; scripted: boolean; float: Micros; reserve: Micros; jobs: JobPlan[] }
  | { kind: "event"; runId: number; event: LedgerEvent; fact: string | null; policy: string | null }
  | { kind: "card.required"; runId: number; jobId: string; customer: string; amount: Micros; currency: string; holdId: string; clientSecret: string; deadline: number }
  | { kind: "approval.requested"; runId: number; jobId: string; customer: string; current: Micros; newTotal: Micros; reason: string; deadline: number }
  | { kind: "feed.phrased"; runId: number; lines: Record<number, string> }
  | { kind: "run.finished"; runId: number; summary: RunSummary }
  | { kind: "run.failed"; runId: number; error: string };

export interface RailStatus {
  rail: string;
  source: "live" | "simulated" | "off" | "not built";
  detail: string;
}

export interface Meta {
  mode: "mock" | "mixed" | "live";
  rails: RailStatus[];
  proof: { badge: string; runs: number; passed: boolean; generatedAt: string; clearingBadge?: string } | null;
  sabotage: { generatedAt: string; results: { name: string; caught: boolean; flagged: number; runs: number }[] } | null;
  running: boolean;
}

export type ControlAction = "overrun_b" | "slow_lite" | "rogue_overquote" | "rogue_wrong_payee" | "rogue_junk" | "rogue_honest" | "mandate_test";

/**
 * Where the dashboard finds the engine. "same-origin": the engine is served under /api on this page's own
 * host (the AWS deployment routes /api/* to the engine), so requests use relative URLs.
 */
const configuredEngineUrl = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://localhost:4100";
export const ENGINE_URL = configuredEngineUrl === "same-origin" ? "" : configuredEngineUrl;
