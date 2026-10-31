/**
 * The scripted demo scenario from the submission, narrated in the terminal.
 * Three jobs, holds $1.00 / $0.75 / $0.75, only 1.50 USDZ of float.
 * Midway: job B's prompt runs 4x over and the 1¢ model slows down. The rogue provider overquotes.
 *
 *   npm run demo        offline and deterministic (TagJudge, template feed lines)
 *   LLM_API_KEY=… npm run demo
 *                       adds the LLM: a judge that grades model answers, an explainer that phrases
 *                       each decision, and real report text behind the mock-priced providers.
 *                       Also writes demo-report.md.
 *
 * Always writes demo-events.json (events, results, feed) for the dashboard.
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
import { ScriptedCustomers, TagJudge, type ProviderPort, type QualityJudge } from "../engine/ports.ts";
import { ClearingEmulator } from "../clearing/emulator.ts";
import { EMULATOR_TEST_KEY, Eip712Signer } from "../clearing/signer.ts";
import { AnthropicLlm } from "../agent/llm.ts";
import { LlmJudge } from "../agent/judge.ts";
import { Explainer, type Explanation } from "../agent/explainer.ts";
import { ReportWritingProviders } from "../agent/report-providers.ts";
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

export const DEMO_TOPICS = new Map([
  ["A", "How small online retailers can cut card-payment costs"],
  ["B", "Risks of letting AI agents make purchases on a company card"],
  ["C", "Choosing between open-weight and hosted language models for a startup"],
]);

const useLlm = Boolean(process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

async function main() {
  const rng = seeded(42);
  let clock = 0;
  const events: LedgerEvent[] = [];
  const ledger = new Ledger(new MemoryStore(), () => ++clock, (e) => events.push(e));
  const airwallex = new MockAirwallex();
  const metal = new MockMetal();
  const mockProviders = new InProcessProviders(CATALOG, rng);
  mockProviders.control(ROGUE_PROVIDER_ID, { mode: "overquote", overquoteFactor: 3 });
  const customers = new ScriptedCustomers((req) => (req.jobId === "B" ? "approved" : "declined"));

  const llm = useLlm ? AnthropicLlm.fromEnv() : undefined;
  const writer = llm ? new ReportWritingProviders(mockProviders, llm, DEMO_TOPICS, (id) => mockProviders.get(id).mode) : undefined;
  const providers: ProviderPort = writer ?? mockProviders;
  // Search and data are still placeholders, so the LLM grades model answers only.
  const judge: QualityJudge = llm ? new LlmJudge(llm, { kinds: ["model"], other: new TagJudge() }) : new TagJudge();
  const explainer = new Explainer(llm);
  console.log(llm ? `LLM: ${llm.model} (judge, explainer, report text)\n` : "LLM: off (set LLM_API_KEY for the judge, explainer and report text)\n");

  const recorder = new RecordingProviders(providers);
  const clearing = new ClearingEmulator(new Eip712Signer(EMULATOR_TEST_KEY));
  const engine = new Orchestrator({
    ledger, holds: airwallex, float: metal, providers: recorder, judge, customers, clearing,
    catalog: CATALOG, policy: DEFAULT_POLICY, rng,
  });

  const results = await engine.run(DEMO_JOBS, {
    float: usd(1.5),
    reserve: cents(30),
    onRound: (round, eng) => {
      if (round === 2) {
        eng.mutateStep("B", "analysis", (s) => ({ ...s, units: s.units * 4 }));
        mockProviders.control("model-lite", { latencyMs: 2500 });
        ledger.log(null, "fault.provider_slowed", { providerId: "model-lite", latencyMs: 2500 });
      }
    },
  });

  // The feed: the fact, the LLM's phrasing when it passed the faithfulness check, and the policy's own reason.
  const feed: Explanation[] = [];
  for (const e of events) {
    const x = e.type === "fault.provider_slowed" ? slowdown(e) : await explainer.explain(e);
    if (!x) continue;
    feed.push(x);
    console.log(x.lineSource === "llm" ? `${tag(x)} ${x.line}` : x.line);
    if (x.lineSource === "llm" || (x.policy && !x.line.includes(x.policy))) console.log(`      policy: ${x.policy ?? "—"}`);
  }

  console.log("\nJob  Customer        Hold    Spent   Captured  Premium-only  Status");
  for (const r of results) {
    const spec = DEMO_JOBS.find((j) => j.id === r.jobId)!;
    console.log(
      `${r.jobId.padEnd(4)} ${spec.customer.padEnd(15)} ${fmt(r.holdFinal).padEnd(7)} ${fmt(r.spent).padEnd(7)} ${fmt(r.captured).padEnd(9)} ${fmt(r.premiumOnlyCost).padEnd(13)} ${r.status}`,
    );
  }
  const v = checkInvariants({ ledger, airwallex, metal, quoted: recorder.quoted, clearing });
  const spent = results.reduce((s, r) => s + r.spent, 0);
  const captured = results.reduce((s, r) => s + r.captured, 0);
  const redeemed = clearing.redemptions.reduce((s, r) => s + r.amount, 0);
  console.log(
    `\nReconciliation: ledger paid ${fmt(spent)} = rail settled ${fmt(metal.totalSettled())} = clearing redeemed ${fmt(redeemed)} [SIMULATED] = Airwallex captured ${fmt(captured)}`,
  );
  console.log(v.length ? `VIOLATIONS:\n  ${v.join("\n  ")}` : "All invariants hold: no customer charged past their hold.");

  if (llm && writer && judge instanceof LlmJudge) {
    console.log(
      `\nLLM: judge ${judge.calls} calls (${judge.failures} fell back to neutral) · explainer ${feed.filter((x) => x.lineSource === "llm").length} lines (${explainer.rejected} rejected as unfaithful, ${explainer.failures} failed) · report ${writer.failures} sections fell back`,
    );
    writeFileSync("demo-report.md", reportMarkdown(writer, results.map((r) => ({ jobId: r.jobId, status: r.status, spent: r.spent, dropped: r.dropped }))));
    console.log("Reports: demo-report.md");
  }
  writeFileSync("demo-events.json", JSON.stringify({ jobs: DEMO_JOBS, results, events, feed }, null, 2));
}

const tag = (x: Explanation) => (x.jobId ? `[${x.jobId}]` : "[*]");

function slowdown(e: LedgerEvent): Explanation {
  const line = `[*] ⚠ ${e.data.providerId} slows to ~${(Number(e.data.latencyMs) / 1000).toFixed(1)}s under load`;
  return { seq: e.seq, jobId: null, type: e.type, fact: line, policy: null, line, lineSource: "template" };
}

function reportMarkdown(
  writer: ReportWritingProviders,
  results: { jobId: string; status: string; spent: number; dropped: string[] }[],
): string {
  const out = ["# Margin demo reports", "", "Model sections written by an LLM behind mock-priced providers. Search and data steps are SIMULATED; no sources are cited.", ""];
  for (const r of results) {
    const spec = DEMO_JOBS.find((j) => j.id === r.jobId)!;
    out.push(`## ${spec.customer}: ${DEMO_TOPICS.get(r.jobId)}`, "", `Job ${r.jobId} · ${r.status} · spent ${fmt(r.spent)}${r.dropped.length ? ` · dropped: ${r.dropped.join(", ")}` : ""}`, "");
    for (const s of writer.report(r.jobId)) {
      out.push(`### ${s.stepId} (${s.providerId}${s.source === "placeholder" ? ", placeholder" : ""})`, "", s.text, "");
    }
  }
  return out.join("\n");
}

main();
