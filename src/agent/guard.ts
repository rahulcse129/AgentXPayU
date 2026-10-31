/**
 * GuardedLlm: a circuit breaker in front of any LlmClient.
 *
 * Every LLM feature already falls back when a call fails, but a failing call can still be slow.
 * Once the provider says we are rate-limited or out of quota, or several calls in a row fail,
 * or the run's call budget is spent, the guard refuses further calls at once, so the rest of the
 * run uses the offline fallbacks instead of waiting on errors.
 */
import { LlmError, type LlmClient } from "./llm.ts";

export function isRateLimit(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  if (status === 429) return true;
  return /\b429\b|rate limit|quota|too many requests|resource.?exhausted/i.test(e instanceof Error ? e.message : String(e));
}

export class GuardedLlm implements LlmClient {
  calls = 0;
  failures = 0;
  /** Why the guard stopped calling the LLM, if it did. */
  tripped: string | null = null;
  private streak = 0;

  constructor(
    private readonly inner: LlmClient,
    private readonly opts: { maxCalls?: number; maxConsecutiveFailures?: number } = {},
  ) {}

  get model(): string {
    return this.inner.model;
  }

  json(req: Parameters<LlmClient["json"]>[0]): Promise<unknown> {
    return this.guard(() => this.inner.json(req));
  }

  text(req: Parameters<LlmClient["text"]>[0]): Promise<string> {
    return this.guard(() => this.inner.text(req));
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tripped) throw new LlmError(`LLM off for this run: ${this.tripped}`);
    if (this.opts.maxCalls !== undefined && this.calls >= this.opts.maxCalls) {
      this.tripped = `call budget of ${this.opts.maxCalls} spent`;
      throw new LlmError(`LLM off for this run: ${this.tripped}`);
    }
    this.calls++;
    try {
      const out = await fn();
      this.streak = 0;
      return out;
    } catch (e) {
      this.failures++;
      this.streak++;
      if (isRateLimit(e)) this.tripped = "provider rate limit or quota reached";
      else if (this.streak >= (this.opts.maxConsecutiveFailures ?? 3)) this.tripped = `${this.streak} failures in a row`;
      throw e;
    }
  }
}
