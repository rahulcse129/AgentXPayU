/**
 * Folds the engine's message stream into what the screen shows. Job cards are a live view of
 * ledger events; the reconciliation and receipts come from the engine's own end-of-run summary.
 */
import type { JobPlan, LedgerEvent, Micros, RunSummary, SessionMessage } from "./protocol";

export type JobStatus = "queued" | "running" | "waiting" | "budget_limited" | "done" | "failed";

export interface JobView {
  id: string;
  customer: string;
  topic: string;
  holdInitial: Micros;
  hold: Micros;
  increments: { from: Micros; to: Micros }[];
  spent: Micros;
  currentStep: string | null;
  currentProvider: string | null;
  stepsTotal: number;
  stepsDone: number;
  dropped: string[];
  limited: boolean;
  finished: boolean;
  failed: boolean;
  captured: Micros | null;
  released: Micros | null;
}

export type Tone = "decision" | "refusal" | "hold" | "reserve" | "fault" | "money" | "clearing" | "info";

export interface FeedItem {
  seq: number;
  jobId: string | null;
  type: string;
  fact: string;
  policy: string | null;
  phrased: string | null;
  tone: Tone;
}

export interface Approval {
  jobId: string;
  customer: string;
  current: Micros;
  newTotal: Micros;
  reason: string;
  deadline: number;
}

export interface DashState {
  runId: number | null;
  running: boolean;
  scripted: boolean;
  float: Micros;
  reserve: Micros;
  reserveLeft: Micros;
  order: string[];
  jobs: Record<string, JobView>;
  feed: FeedItem[];
  approval: Approval | null;
  summary: RunSummary | null;
  error: string | null;
}

export const EMPTY: DashState = {
  runId: null,
  running: false,
  scripted: true,
  float: 0,
  reserve: 0,
  reserveLeft: 0,
  order: [],
  jobs: {},
  feed: [],
  approval: null,
  summary: null,
  error: null,
};

const TONES: Record<string, Tone> = {
  "agent.decision": "decision",
  "agent.premium_check": "decision",
  "payment.refused": "refusal",
  "provider.blocked": "refusal",
  "answer.junk": "refusal",
  "provider.no_delivery": "refusal",
  "hold.increase_requested": "hold",
  "hold.increase_answer": "hold",
  "hold.incremented": "hold",
  "job.degraded": "hold",
  "step.dropped": "hold",
  "reserve.granted": "reserve",
  "fault.step_changed": "fault",
  "fault.provider_slowed": "fault",
  "fault.rogue_mode": "fault",
  "hold.authorized": "money",
  "hold.captured": "money",
  "hold.cancelled": "money",
  "float.deposited": "money",
  "float.withdrawn": "money",
};

const planJob = (p: JobPlan): JobView => ({
  id: p.id,
  customer: p.customer,
  topic: p.topic,
  holdInitial: p.hold,
  hold: 0,
  increments: [],
  spent: 0,
  currentStep: null,
  currentProvider: null,
  stepsTotal: p.steps.length,
  stepsDone: 0,
  dropped: [],
  limited: false,
  finished: false,
  failed: false,
  captured: null,
  released: null,
});

function applyEvent(s: DashState, e: LedgerEvent): DashState {
  const d = e.data;
  if (e.type === "float.deposited") return { ...s, reserveLeft: Number(d.reserve) };
  if (e.type === "reserve.granted") s = { ...s, reserveLeft: Number(d.reserveLeft) };
  if (e.type === "hold.increase_answer" && s.approval?.jobId === e.jobId) s = { ...s, approval: null };
  const j = e.jobId ? s.jobs[e.jobId] : undefined;
  if (!j) return s;
  const n: JobView = { ...j };
  switch (e.type) {
    case "hold.authorized": n.hold = Number(d.authorized); break;
    case "hold.incremented": n.hold = Number(d.to); n.increments = [...j.increments, { from: Number(d.from), to: Number(d.to) }]; break;
    case "payment.paid": n.spent = j.spent + Number(d.amount); break;
    case "agent.decision": n.currentStep = String(d.stepId); n.currentProvider = String(d.providerId); break;
    case "step.done": n.stepsDone = j.stepsDone + 1; n.currentStep = null; n.currentProvider = null; break;
    case "step.dropped": n.dropped = [...j.dropped, String(d.stepId)]; break;
    case "job.degraded": n.limited = true; n.dropped = [...j.dropped, ...((d.dropped as string[]) ?? [])]; break;
    case "job.finished": n.finished = true; n.limited = Boolean(d.limited); n.currentStep = null; n.currentProvider = null; break;
    case "job.failed": n.failed = true; n.finished = true; break;
    case "hold.captured": n.captured = Number(d.captured); n.released = Number(d.released); break;
    case "hold.cancelled": n.captured = 0; n.released = Number(d.released); break;
    default: return s;
  }
  return { ...s, jobs: { ...s.jobs, [n.id]: n } };
}

export function reduce(s: DashState, m: SessionMessage): DashState {
  if (m.kind === "run.started") {
    return {
      ...EMPTY,
      runId: m.runId,
      running: true,
      scripted: m.scripted,
      float: m.float,
      reserve: m.reserve,
      reserveLeft: m.reserve,
      order: m.jobs.map((j) => j.id),
      jobs: Object.fromEntries(m.jobs.map((j) => [j.id, planJob(j)])),
    };
  }
  if (s.runId !== null && m.runId !== s.runId) return s;
  switch (m.kind) {
    case "event": {
      let next = applyEvent(s, m.event);
      if (m.fact) {
        next = {
          ...next,
          feed: [...next.feed, { seq: m.event.seq, jobId: m.event.jobId, type: m.event.type, fact: m.fact, policy: m.policy, phrased: null, tone: TONES[m.event.type] ?? "info" }],
        };
      }
      return next;
    }
    case "approval.requested":
      return { ...s, approval: { jobId: m.jobId, customer: m.customer, current: m.current, newTotal: m.newTotal, reason: m.reason, deadline: m.deadline } };
    case "feed.phrased":
      return { ...s, feed: s.feed.map((f) => (m.lines[f.seq] ? { ...f, phrased: m.lines[f.seq]! } : f)) };
    case "run.finished":
      return { ...s, running: false, approval: null, summary: m.summary };
    case "run.failed":
      return { ...s, running: false, approval: null, error: m.error };
  }
}

export function statusOf(j: JobView, approval: Approval | null, running: boolean): JobStatus {
  if (j.failed) return "failed";
  if (approval?.jobId === j.id) return "waiting";
  if (j.finished) return j.limited ? "budget_limited" : "done";
  if (j.limited) return "budget_limited";
  return running ? "running" : "queued";
}

export const fmt = (m: Micros): string => `$${(m / 1_000_000).toFixed(2)}`;
