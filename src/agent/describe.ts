/**
 * Deterministic one-line descriptions of ledger events, and the policy's own reason for each
 * decision. These are the facts; the Explainer may only rephrase them.
 */
import { fmt } from "../money.ts";
import type { LedgerEvent } from "../ledger/ledger.ts";

const sim = (d: Record<string, unknown>) => (d.source === "simulated" ? "[SIMULATED] " : "");

export function describe(e: LedgerEvent): string | null {
  const d = e.data;
  const j = e.jobId ? `[${e.jobId}]` : "[*]";
  switch (e.type) {
    case "float.deposited": return `${j} deposit ${fmt(Number(d.amount))} USDZ float, ${fmt(Number(d.reserve))} kept as shared reserve`;
    case "hold.authorized": return `${j} card hold authorized ${fmt(Number(d.authorized))}`;
    case "fault.step_changed": return `${j} ⚠ step ${d.stepId} grew to ${d.units} paragraphs (prompt overrun)`;
    case "fault.provider_slowed": return `${j} ⚠ ${d.providerId} slows to ~${(Number(d.latencyMs) / 1000).toFixed(1)}s under load`;
    case "fault.rogue_mode": return `${j} ⚠ demo control: ${d.providerId} now behaves "${d.mode}"`;
    case "fault.mandate_test": return `${j} ⚠ deliberate test: our quote check is OFF; ${d.providerId} will ask to be paid at an unregistered address`;
    case "demo.quote_check_skipped": return `${j} ⚠ quote check skipped for ${d.providerId} (test): ${d.why}`;
    case "demo.quote_check_restored": return `${j} ✓ our quote check is back on`;
    case "mandate.opened": return `${j} ${sim(d)}🔒 Metal mandate bound: ${d.payees} registered payees, ${fmt(Number(d.perPaymentCap))} per payment, ${fmt(Number(d.budget))} budget`;
    case "mandate.raised": return `${j} ${sim(d)}🔒 mandate budget raised ${fmt(Number(d.from))} → ${fmt(Number(d.to))} (${d.why})`;
    case "mandate.revoked": return `${j} ${sim(d)}🔒 mandate revoked: nothing more can be paid under it`;
    case "mandate.refused": return `${j} ${sim(d)}🔒 Metal mandate refused ${fmt(Number(d.amount))} to ${d.payTo}: ${d.why}`;
    case "agent.decision": return `${j} ${d.stepId}: buy from ${d.providerId} for ${fmt(Number(d.cost))} — ${d.why}`;
    case "payment.refused": return `${j} ✋ refused ${d.providerId}: ${d.reason}`;
    case "provider.blocked": return `${j} ⛔ ${d.providerId} blocked (${d.why})`;
    case "answer.junk": return `${j} ✋ ${d.providerId} returned junk (score ${d.score}); buying elsewhere`;
    case "provider.no_delivery": return `${j} ✋ ${d.providerId} took payment but did not deliver`;
    case "agent.premium_check": return d.escalate ? `${j} ★ premium redo: ${d.why}` : null;
    case "reserve.granted": return `${j} reserve +${fmt(Number(d.amount))} (${d.why}); ${fmt(Number(d.reserveLeft))} left`;
    case "hold.increase_requested": return `${j} ask customer: raise hold ${fmt(Number(d.from))} → ${fmt(Number(d.to))}`;
    case "hold.increase_answer": return `${j} customer ${d.answer}`;
    case "hold.incremented": return `${j} Airwallex incremental auth OK: hold now ${fmt(Number(d.to))}`;
    case "job.degraded": return `${j} budget-limited plan (${d.why}): ${d.note}${(d.dropped as string[]).length ? `; dropped ${(d.dropped as string[]).join(", ")}` : ""}`;
    case "step.dropped": return `${j} dropped ${d.stepId} (${d.why})`;
    case "job.finished": return `${j} finished${d.limited ? " (budget-limited)" : ""}${Number(d.returnedToPool) ? `; ${fmt(Number(d.returnedToPool))} float back to pool` : ""}`;
    case "hold.captured": return `${j} captured ${fmt(Number(d.captured))}, released ${fmt(Number(d.released))}`;
    case "hold.cancelled": return `${j} hold cancelled, released ${fmt(Number(d.released))}`;
    case "float.withdrawn": return `${j} withdrew unused float ${fmt(Number(d.amount))} USDZ`;
    case "clearing.deposit_opened": return `${j} [SIMULATED] clearing deposit ${fmt(Number(d.amount))}`;
    case "clearing.deposit_raised": return `${j} [SIMULATED] clearing deposit raised to ${fmt(Number(d.amount))}`;
    case "clearing.epoch_settled": return Number(d.redemptions) ? `${j} [SIMULATED] clearing epoch ${d.epoch} closed: ${d.redemptions} running totals redeemed` : null;
    case "clearing.withdrawn": return `${j} [SIMULATED] clearing final: redeemed ${fmt(Number(d.redeemed))}, unused deposit ${fmt(Number(d.amount))} withdrawn`;
    default: return null;
  }
}

/** The reason the policy module (or the judge, for scores) wrote into the event, verbatim. */
export function policyReason(e: LedgerEvent): string | null {
  const d = e.data;
  const r = d.why ?? d.reason ?? d.note;
  return typeof r === "string" && r ? r : null;
}

/** Decisions worth an LLM-phrased line in the feed. Bookkeeping events keep their template. */
export const DECISION_EVENTS: ReadonlySet<string> = new Set([
  "agent.decision",
  "payment.refused",
  "provider.blocked",
  "answer.junk",
  "provider.no_delivery",
  "agent.premium_check",
  "reserve.granted",
  "hold.increase_requested",
  "job.degraded",
  "step.dropped",
  "mandate.refused",
]);
