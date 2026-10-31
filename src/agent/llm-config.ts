/**
 * Picks the LLM from the environment. No key at all means no LLM: the demo stays offline.
 *
 *   LLM_PROVIDER=gemini|anthropic   optional; otherwise inferred from which key is set
 *   GEMINI_API_KEY (or GOOGLE_API_KEY)   → Gemini
 *   LLM_API_KEY / ANTHROPIC_API_KEY      → Claude (LLM_API_KEY goes to Gemini when LLM_PROVIDER=gemini)
 *   LLM_MODEL                        optional model override for whichever provider is used
 */
import { AnthropicLlm, DEFAULT_LLM_MODEL, type LlmClient } from "./llm.ts";
import { DEFAULT_GEMINI_MODEL, GeminiLlm } from "./gemini.ts";

export type LlmProvider = "gemini" | "anthropic";

export function llmProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider | undefined {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === "gemini" || explicit === "google") return "gemini";
  if (explicit === "anthropic" || explicit === "claude") return "anthropic";
  if (explicit) throw new Error(`unknown LLM_PROVIDER ${env.LLM_PROVIDER}; use gemini or anthropic`);
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return "gemini";
  if (env.LLM_API_KEY || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "anthropic";
  return undefined;
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | undefined {
  const provider = llmProviderFromEnv(env);
  const model = env.LLM_MODEL?.trim() || undefined;
  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || env.LLM_API_KEY;
    if (!apiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY (or GOOGLE_API_KEY / LLM_API_KEY)");
    return new GeminiLlm({ apiKey }, model ?? DEFAULT_GEMINI_MODEL);
  }
  if (provider === "anthropic") {
    return new AnthropicLlm({ apiKey: env.LLM_API_KEY || undefined }, model ?? DEFAULT_LLM_MODEL);
  }
  return undefined;
}
