/**
 * The one place Margin talks to an LLM. Two calls only: a JSON answer against a schema
 * (scoring) and a short text (explanations and report paragraphs).
 *
 * The LLM never sees prices, budgets, holds, caps or provider choice, and nothing it returns
 * reaches the policy module except a 0..1 quality score, which the judge clamps.
 *
 * Notes on the current Claude API (claude-opus-5-5), since the project prompt predates them:
 *  - `temperature` is rejected (400). We use `output_config.effort: "low"` for short,
 *    consistent answers instead.
 *  - Forced `tool_choice` is rejected (400). The judge's "one typed call" is structured
 *    output (`output_config.format` with a JSON schema) instead of a forced tool.
 *  - `fallbacks: "default"` re-runs a request a safety classifier declined on Anthropic's
 *    recommended fallback model, server side. A refusal that still comes back is an error here,
 *    and every caller has a non-LLM fallback.
 */
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_LLM_MODEL = "claude-opus-5-5";

export interface LlmClient {
  readonly model: string;
  json(req: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<unknown>;
  text(req: { system: string; user: string; maxTokens?: number }): Promise<string>;
}

export class LlmError extends Error {}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    opts: { apiKey?: string; timeoutMs?: number } = {},
    readonly model = DEFAULT_LLM_MODEL,
  ) {
    // No apiKey: the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile.
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 30_000, maxRetries: 1 });
  }

  /** LLM_API_KEY (or the SDK's own credential lookup) and optional LLM_MODEL. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicLlm {
    return new AnthropicLlm({ apiKey: env.LLM_API_KEY || undefined }, env.LLM_MODEL || DEFAULT_LLM_MODEL);
  }

  private async call(system: string, user: string, maxTokens: number, format?: Record<string, unknown>): Promise<string> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", ...(format ? { format: { type: "json_schema", schema: format } } : {}) },
    });
    if (res.stop_reason === "refusal") throw new LlmError("model declined the request");
    if (res.stop_reason === "max_tokens") throw new LlmError("answer cut off at max_tokens");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    if (!text.trim()) throw new LlmError("empty answer");
    return text;
  }

  async json(req: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<unknown> {
    const text = await this.call(req.system, req.user, req.maxTokens ?? 1024, req.schema);
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError("answer was not valid JSON");
    }
  }

  text(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    return this.call(req.system, req.user, req.maxTokens ?? 1024);
  }
}
