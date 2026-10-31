/**
 * Explainer: turns a ledger event into one plain-English line for the dashboard feed.
 *
 * It only rephrases. The input is the deterministic description of the event (describe.ts),
 * which already contains the policy's own reason. The LLM's line is accepted only if it passes
 * `faithful()`: no number, dollar amount, provider or job id that the source line does not
 * contain, one line, bounded length. Otherwise, or if the LLM fails, the feed shows the
 * deterministic line. Either way the policy's reason is shown beside it, unchanged.
 */
import { CATALOG } from "../policy/catalog.ts";
import type { LedgerEvent } from "../ledger/ledger.ts";
import { DECISION_EVENTS, describe, policyReason } from "./describe.ts";
import type { LlmClient } from "./llm.ts";

export interface Explanation {
  seq: number;
  jobId: string | null;
  type: string;
  /** Deterministic description: the facts. */
  fact: string;
  /** What the policy module (or judge) wrote as the reason, verbatim. */
  policy: string | null;
  /** The line the feed shows. */
  line: string;
  lineSource: "llm" | "template";
}

const SYSTEM = [
  "You rewrite one log line from a payment agent as one short plain-English sentence for a non-technical audience watching a live demo.",
  "Use only facts in the line. Do not add numbers, amounts, names, causes or consequences that are not in it. Keep every amount and name you mention exactly as written.",
  "Drop bracketed job tags and symbols. Reply with the sentence only.",
].join("\n");

const PROVIDER_IDS = CATALOG.map((p) => p.id);

/** True when `out` makes no claim the source line does not support (numbers, amounts, ids). */
export function faithful(source: string, out: string): boolean {
  const line = out.trim();
  if (!line || line.length > 240 || /[\r\n]/.test(line)) return false;
  const nums = (s: string) => s.match(/\d+(?:\.\d+)?/g) ?? [];
  const allowed = new Set(nums(source));
  if (!nums(line).every((n) => allowed.has(n))) return false;
  const lowerSrc = source.toLowerCase();
  const lowerOut = line.toLowerCase();
  // A provider named in the rephrasing must be named in the source.
  return PROVIDER_IDS.every((id) => !lowerOut.includes(id) || lowerSrc.includes(id));
}

export class Explainer {
  private readonly cache = new Map<string, string>();
  rejected = 0;
  failures = 0;

  /** Without an LLM, every line is the deterministic one. */
  constructor(private readonly llm?: LlmClient) {}

  async explain(e: LedgerEvent): Promise<Explanation | null> {
    const fact = describe(e);
    if (!fact) return null;
    const base = { seq: e.seq, jobId: e.jobId, type: e.type, fact, policy: policyReason(e) };
    const phrased = this.llm && DECISION_EVENTS.has(e.type) ? await this.rephrase(fact) : null;
    return phrased ? { ...base, line: phrased, lineSource: "llm" } : { ...base, line: fact, lineSource: "template" };
  }

  /**
   * Explain a whole run in a few calls: decision lines go to the LLM in batches of `batchSize`
   * as one JSON array. Each returned line is checked with faithful() against its own source;
   * a batch whose answer does not line up one-to-one falls back to templates entirely.
   */
  async explainAll(events: LedgerEvent[], batchSize = 40): Promise<Explanation[]> {
    const base = events.flatMap((e) => {
      const fact = describe(e);
      return fact ? [{ e, fact }] : [];
    });
    const wanted = [...new Set(base.filter((b) => this.llm && DECISION_EVENTS.has(b.e.type)).map((b) => b.fact))].filter(
      (f) => !this.cache.has(f),
    );
    for (let i = 0; i < wanted.length; i += batchSize) await this.rephraseBatch(wanted.slice(i, i + batchSize));
    return base.map(({ e, fact }) => {
      const phrased = DECISION_EVENTS.has(e.type) ? this.cache.get(fact) : undefined;
      const x = { seq: e.seq, jobId: e.jobId, type: e.type, fact, policy: policyReason(e) };
      return phrased ? { ...x, line: phrased, lineSource: "llm" as const } : { ...x, line: fact, lineSource: "template" as const };
    });
  }

  private async rephraseBatch(facts: string[]): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.llm!.json({
        system: `${SYSTEM.replace("one log line", "each log line").replace("Reply with the sentence only.", "")}\nReturn one sentence per input line, in the same order, as {"lines": [...]}.`,
        user: facts.map((f, i) => `${i + 1}. ${f}`).join("\n"),
        schema: {
          type: "object",
          properties: { lines: { type: "array", items: { type: "string" }, minItems: facts.length, maxItems: facts.length } },
          required: ["lines"],
          additionalProperties: false,
        },
        maxTokens: 80 * facts.length + 400,
      });
    } catch {
      this.failures++;
      return;
    }
    const lines = (raw as { lines?: unknown })?.lines;
    if (!Array.isArray(lines) || lines.length !== facts.length) {
      this.failures++;
      return;
    }
    facts.forEach((fact, i) => {
      const out = typeof lines[i] === "string" ? (lines[i] as string).trim() : "";
      if (faithful(fact, out)) this.cache.set(fact, out);
      else this.rejected++;
    });
  }

  private async rephrase(fact: string): Promise<string | null> {
    const hit = this.cache.get(fact);
    if (hit) return hit;
    let out: string;
    try {
      out = (await this.llm!.text({ system: SYSTEM, user: fact, maxTokens: 300 })).trim();
    } catch {
      this.failures++;
      return null;
    }
    if (!faithful(fact, out)) {
      this.rejected++;
      return null;
    }
    this.cache.set(fact, out);
    return out;
  }
}
