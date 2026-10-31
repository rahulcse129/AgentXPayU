/**
 * Real report content behind mock-priced providers.
 *
 * Wraps a ProviderPort. Quotes pass through untouched, so prices still come only from
 * catalog.ts and the rogue modes still misbehave. On delivery, an honest model step's
 * placeholder is replaced by real prose from the LLM, written in the provider's tier style;
 * junk and crash modes keep their bad behaviour so the defences still have something to catch.
 *
 * Search and data steps stay SIMULATED placeholders (no real web search or data feed is wired),
 * and the model prompt says so, so the report never cites sources that do not exist.
 */
import { providerById } from "../policy/catalog.ts";
import type { PaymentRequirement, Step, Tier } from "../policy/types.ts";
import type { ProviderPort } from "../engine/ports.ts";
import type { ProviderMode } from "../providers/logic.ts";
import type { LlmClient } from "./llm.ts";

const STYLE: Record<Tier, string> = {
  1: "Write plainly and briefly, like a quick first draft.",
  2: "Write like a careful analyst: specific, organised, no filler.",
  3: "Write like a senior expert: precise, nuanced, noting trade-offs and uncertainty.",
};

const SYSTEM = [
  "You write one section of a short research report. Another section may come before or after yours.",
  "There are no real sources available: do not cite studies, URLs, statistics or quotes. Write from general knowledge and say when something is uncertain.",
  "Write exactly the requested number of paragraphs, each one to three sentences. Plain text, no headings, no lists, no preamble.",
].join("\n");

export interface ReportSection {
  stepId: string;
  providerId: string;
  text: string;
  source: "llm" | "placeholder";
}

export class ReportWritingProviders implements ProviderPort {
  /** Sections delivered per job, in delivery order (a premium redo replaces the earlier section). */
  readonly sections = new Map<string, ReportSection[]>();
  failures = 0;

  constructor(
    private readonly inner: ProviderPort,
    private readonly llm: LlmClient,
    /** jobId -> what the report is about. */
    private readonly topics: ReadonlyMap<string, string>,
    /** How the inner provider is currently behaving; only honest model answers are rewritten. */
    private readonly modeOf: (providerId: string) => ProviderMode,
  ) {}

  requestQuote(providerId: string, step: Step, key: string): Promise<PaymentRequirement> {
    return this.inner.requestQuote(providerId, step, key);
  }

  async deliver(providerId: string, step: Step, key: string, txHash: string) {
    const out = await this.inner.deliver(providerId, step, key, txHash);
    // Payment keys are `${jobId}:${stepId}:${providerId}:${n}` (orchestrator.buy).
    const jobId = key.split(":")[0]!;
    const topic = this.topics.get(jobId);
    if (step.kind !== "model" || !topic || this.modeOf(providerId) !== "honest") return out;

    const spec = providerById(providerId);
    const earlier = (this.sections.get(jobId) ?? []).filter((s) => s.stepId !== step.id && s.source === "llm");
    let text: string;
    try {
      text = await this.llm.text({
        system: SYSTEM,
        user: [
          `Report topic: ${topic}`,
          `This section: "${step.id}". Paragraphs: ${step.units}.`,
          STYLE[spec.tier],
          earlier.length ? `Sections already written (do not repeat them):\n${earlier.map((s) => `[${s.stepId}] ${s.text.slice(0, 600)}`).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        maxTokens: 200 + 160 * step.units,
      });
    } catch {
      // Keep the paid-for placeholder; the judge will grade it like any other answer.
      this.failures++;
      this.record(jobId, { stepId: step.id, providerId, text: out.output, source: "placeholder" });
      return out;
    }
    this.record(jobId, { stepId: step.id, providerId, text: text.trim(), source: "llm" });
    return { ...out, output: text.trim() };
  }

  /** The job's report: one section per delivered step, in step order of first delivery. */
  report(jobId: string): ReportSection[] {
    return this.sections.get(jobId) ?? [];
  }

  private record(jobId: string, s: ReportSection) {
    const list = this.sections.get(jobId) ?? [];
    const i = list.findIndex((x) => x.stepId === s.stepId);
    if (i >= 0) list[i] = s;
    else list.push(s);
    this.sections.set(jobId, list);
  }
}
