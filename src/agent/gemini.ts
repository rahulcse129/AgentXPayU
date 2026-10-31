/**
 * Gemini behind the same LlmClient as Claude, via Google's official SDK (@google/genai) and the
 * Interactions API, which Google's docs now use for every REST and SDK example.
 *
 * Read from @google/genai@2.32.0 types and the Gemini docs (2026-11-01):
 *  - `client.interactions.create({ model, input, system_instruction, generation_config,
 *    response_format, store })` returns an Interaction with `status` and `output_text`.
 *  - Structured output: `response_format: { type: "text", mime_type: "application/json", schema }`.
 *  - `generation_config.temperature` is deprecated (Gemini 3.6+ ignores it), so short, steady
 *    answers come from `thinking_level: "low"`. Thinking tokens count toward `max_output_tokens`,
 *    so budgets here are generous.
 *  - `store: false`: Google does not keep our prompts or provider outputs.
 * Anything other than `status: "completed"` with non-empty text is an LlmError, and every
 * caller already falls back without the LLM.
 */
import { GoogleGenAI } from "@google/genai";
import { LlmError, type LlmClient } from "./llm.ts";

/**
 * Google's "fastest and most cost-effective" current model. A demo run makes about 20 calls;
 * gemini-3.8-flash allows 20 requests a day on the free tier. Override with LLM_MODEL.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

/** The slice of the SDK we use, so tests can stand in for it. */
export interface InteractionsApi {
  create(params: Record<string, unknown>): Promise<{ status?: string; output_text?: string }>;
}

export class GeminiLlm implements LlmClient {
  private readonly interactions: InteractionsApi;

  constructor(
    opts: { apiKey?: string; timeoutMs?: number; interactions?: InteractionsApi } = {},
    readonly model = DEFAULT_GEMINI_MODEL,
  ) {
    // The SDK's default is 5 attempts with up to 60 s backoff, including on 429. A quota 429 on the
    // free tier ("retry in 10h") then stalls each call for minutes. Retry only brief server
    // errors, once; GuardedLlm turns the LLM off for the run on a 429.
    const retryOptions = { attempts: 2, initialDelay: 1, maxDelay: 2, httpStatusCodes: [500, 502, 503, 504] };
    this.interactions =
      opts.interactions ??
      (new GoogleGenAI({ apiKey: opts.apiKey, httpOptions: { timeout: opts.timeoutMs ?? 30_000, retryOptions } })
        .interactions as unknown as InteractionsApi);
  }

  private async call(system: string, user: string, maxTokens: number, schema?: Record<string, unknown>): Promise<string> {
    const res = await this.interactions.create({
      model: this.model,
      input: user,
      system_instruction: system,
      generation_config: { max_output_tokens: maxTokens, thinking_level: "low" },
      ...(schema ? { response_format: { type: "text", mime_type: "application/json", schema } } : {}),
      store: false,
    });
    if (res.status !== "completed") throw new LlmError(`interaction ${res.status ?? "returned no status"}`);
    const text = res.output_text ?? "";
    if (!text.trim()) throw new LlmError("empty answer");
    return text;
  }

  async json(req: { system: string; user: string; schema: Record<string, unknown>; maxTokens?: number }): Promise<unknown> {
    const text = await this.call(req.system, req.user, Math.max(2048, req.maxTokens ?? 0), req.schema);
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError("answer was not valid JSON");
    }
  }

  text(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
    return this.call(req.system, req.user, Math.max(2048, (req.maxTokens ?? 1024) * 2));
  }
}
