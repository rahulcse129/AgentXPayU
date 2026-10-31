/**
 * The scripted demo scenario from the submission, narrated in the terminal.
 * Three jobs, holds $1.00 / $0.75 / $0.75, only 1.50 USDZ of float.
 * Midway: job B's prompt runs 4x over and the 1¢ model slows down. The rogue provider overquotes.
 *
 *   npm run demo        (also writes demo-events.json for the dashboard)
 */
import { writeFileSync } from "node:fs";
import { cents, fmt, usd } from "../money.ts";
import { Ledger, MemoryStore, type LedgerEvent } from "../ledger/ledger.ts";
import { CATALOG, ROGUE_PROVIDER_ID } from "../policy/catalog.ts";
import { DEFAULT_POLICY, type Step } from "../policy/types.ts";
import { MockAirwallex } from "../payments/mock-airwallex.ts";
import { MockMetal } from "../payments/mock-metal.ts";
import { InProcessProviders } from "../providers/in-process.ts";
import { Orchestrator, type JobSpec } from "../engine/orchestrator.ts";
import { ScriptedCustomers, TagJudge } from "../engine/ports.ts";
import { checkInvariants, RecordingProviders } from "./harness.ts";
import { seeded } from "./rng.ts";

const m = (id: string, units: number, minTier: 1 | 2, extra: Partial<Step> = {}): Step => ({
  id, kind: "model", units, minTier, maxLatencyMs: 1000, ...extra,
});
const search = (id: string): Step => ({ id, kind: "search", units: 1, minTier: 2, maxLatencyMs: 1000 });
const data = (id: string): Step => ({ id, kind: "data", units: 1, minTier: 2, maxLatencyMs: 1000, optional: true });

export const DEMO_JOBS: JobSpec[] = [
  { id: "A", customer: "Acme Research", hold: usd(1.0), steps: [search("search"), data("lookup"), m("outline", 12, 2), m("body", 15, 1), m("summary", 10, 2, { premiumEligible: true })] },
  { id: "B", customer: "Birch Capital", hold: usd(0.75), steps: [search("search"), m("draft", 10, 1), m("analysis", 12, 2), m("wrapup", 8, 1), data("lookup")] },
  { id: "C", customer: "Cobalt Labs", hold: usd(0.75), steps: [search("search"), m("scan", 14, 1), m("compare", 10, 2), data("lookup"), m("brief", 6, 1)] },
];

const describe = (e: LedgerEvent): string | null => {
  const d = e.data;
  const j = e.jobId ? `[${e.jobId}]` : "[*]";
  switch (e.type) {
    case "float.deposited": return `${j} deposit ${fmt(Number(d.amount))} USDZ float, ${fmt(Number(d.reserve))} kept as shared reserve`;
    case "hold.authorized": return `${j} card hold authorized ${fmt(Number(d.authorized))}`;
    case "fault.step_changed": return `${j} ⚠ step ${d.stepId} grew to ${d.units} paragraphs (prompt overrun)`;
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
    default: return null;
  }
};

async function main() {
  const rng = seeded(42);
  let clock = 0;
  const events: LedgerEvent[] = [];
  const ledger = new Ledger(new MemoryStore(), () => ++clock, (e) => {
    events.push(e);
    const line = describe(e);
    if (line) console.log(line);
  });
  const airwallex = new MockAirwallex();
  const metal = new MockMetal();
  const providers = new InProcessProviders(CATALOG, rng);
  providers.control(ROGUE_PROVIDER_ID, { mode: "overquote", overquoteFactor: 3 });
  const customers = new ScriptedCustomers((req) => (req.jobId === "B" ? "approved" : "declined"));

  const recorder = new RecordingProviders(providers);
  const engine = new Orchestrator({
    ledger, holds: airwallex, float: metal, providers: recorder, judge: new TagJudge(), customers,
    catalog: CATALOG, policy: DEFAULT_POLICY, rng,
  });

  const results = await engine.run(DEMO_JOBS, {
    float: usd(1.5),
    reserve: cents(30),
    onRound: (round, eng) => {
      if (round === 2) {
        eng.mutateStep("B", "analysis", (s) => ({ ...s, units: s.units * 4 }));
        providers.control("model-lite", { latencyMs: 2500 });
        console.log("[*] ⚠ model-lite slows to ~2.5s under load");
      }
    },
  });

  console.log("\nJob  Customer        Hold    Spent   Captured  Premium-only  Status");
  for (const r of results) {
    const spec = DEMO_JOBS.find((j) => j.id === r.jobId)!;
    console.log(
      `${r.jobId.padEnd(4)} ${spec.customer.padEnd(15)} ${fmt(r.holdFinal).padEnd(7)} ${fmt(r.spent).padEnd(7)} ${fmt(r.captured).padEnd(9)} ${fmt(r.premiumOnlyCost).padEnd(13)} ${r.status}`,
    );
  }
  const v = checkInvariants({ ledger, airwallex, metal, quoted: recorder.quoted });
  const spent = results.reduce((s, r) => s + r.spent, 0);
  const captured = results.reduce((s, r) => s + r.captured, 0);
  console.log(`\nReconciliation: ledger paid ${fmt(spent)} = rail settled ${fmt(metal.totalSettled())} = Airwallex captured ${fmt(captured)}`);
  console.log(v.length ? `VIOLATIONS:\n  ${v.join("\n  ")}` : "All invariants hold: no customer charged past their hold.");
  writeFileSync("demo-events.json", JSON.stringify({ jobs: DEMO_JOBS, results, events }, null, 2));
}

main();
