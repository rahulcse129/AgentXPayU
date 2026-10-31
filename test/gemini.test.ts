import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiLlm, DEFAULT_GEMINI_MODEL, type InteractionsApi } from "../src/agent/gemini.ts";
import { AnthropicLlm, LlmError } from "../src/agent/llm.ts";
import { llmFromEnv, llmProviderFromEnv } from "../src/agent/llm-config.ts";
import { LlmJudge, NEUTRAL_SCORE } from "../src/agent/judge.ts";
import { GuardedLlm } from "../src/agent/guard.ts";
import type { Step } from "../src/policy/types.ts";

/** Stands in for client.interactions; records the params of every call. */
const fakeInteractions = (reply: { status?: string; output_text?: string } | Error) => {
  const calls: Record<string, unknown>[] = [];
  const api: InteractionsApi = {
    async create(params) {
      calls.push(params);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { api, calls };
};

const model: Step = { id: "body", kind: "model", units: 2, minTier: 1, maxLatencyMs: 1000 };

test("json() sends a structured-output interaction that Google does not store", async () => {
  const { api, calls } = fakeInteractions({ status: "completed", output_text: '{"score":0.8,"reason":"ok"}' });
  const llm = new GeminiLlm({ interactions: api });
  const schema = { type: "object", properties: { score: { type: "number" } } };
  assert.deepEqual(await llm.json({ system: "sys", user: "hello", schema }), { score: 0.8, reason: "ok" });
  const p = calls[0]!;
  assert.equal(p.model, DEFAULT_GEMINI_MODEL);
  assert.equal(p.input, "hello");
  assert.equal(p.system_instruction, "sys");
  assert.equal(p.store, false);
  assert.deepEqual(p.response_format, { type: "text", mime_type: "application/json", schema });
  const gc = p.generation_config as Record<string, unknown>;
  assert.equal(gc.thinking_level, "low");
  assert.ok(Number(gc.max_output_tokens) >= 2048, "room for thinking tokens");
  assert.equal("temperature" in gc, false);
});

test("text() sends no response_format and returns the output text", async () => {
  const { api, calls } = fakeInteractions({ status: "completed", output_text: "A plain sentence." });
  assert.equal(await new GeminiLlm({ interactions: api }, "gemini-3.5-flash-lite").text({ system: "s", user: "u" }), "A plain sentence.");
  assert.equal(calls[0]!.model, "gemini-3.5-flash-lite");
  assert.equal("response_format" in calls[0]!, false);
});

test("anything but a completed, non-empty answer is an LlmError", async () => {
  for (const reply of [
    { status: "incomplete", output_text: "cut" },
    { status: "failed" },
    {},
    { status: "completed", output_text: "  " },
  ]) {
    await assert.rejects(new GeminiLlm({ interactions: fakeInteractions(reply).api }).text({ system: "s", user: "u" }), LlmError);
  }
  await assert.rejects(
    new GeminiLlm({ interactions: fakeInteractions({ status: "completed", output_text: "not json" }).api }).json({ system: "s", user: "u", schema: {} }),
    /not valid JSON/,
  );
});

test("the judge works over Gemini and falls back to neutral when Gemini fails", async () => {
  const good = new LlmJudge(new GeminiLlm({ interactions: fakeInteractions({ status: "completed", output_text: '{"score":0.91,"reason":"clear"}' }).api }));
  assert.deepEqual(await good.verdict(model, "Two paragraphs."), { score: 0.91, reason: "clear", source: "llm" });
  const down = new LlmJudge(new GeminiLlm({ interactions: fakeInteractions(new Error("503 unavailable")).api }));
  assert.equal(await down.score(model, "Two paragraphs."), NEUTRAL_SCORE);
});

// ---------------------------------------------------------------- choosing the provider

test("provider is inferred from which key is set, Gemini first", () => {
  assert.equal(llmProviderFromEnv({}), undefined);
  assert.equal(llmProviderFromEnv({ GEMINI_API_KEY: "g" }), "gemini");
  assert.equal(llmProviderFromEnv({ GOOGLE_API_KEY: "g" }), "gemini");
  assert.equal(llmProviderFromEnv({ LLM_API_KEY: "a" }), "anthropic");
  assert.equal(llmProviderFromEnv({ GEMINI_API_KEY: "g", LLM_API_KEY: "a" }), "gemini");
});

test("LLM_PROVIDER overrides the inference and rejects unknown names", () => {
  assert.equal(llmProviderFromEnv({ LLM_PROVIDER: "anthropic", GEMINI_API_KEY: "g" }), "anthropic");
  assert.equal(llmProviderFromEnv({ LLM_PROVIDER: "Gemini", LLM_API_KEY: "k" }), "gemini");
  assert.throws(() => llmProviderFromEnv({ LLM_PROVIDER: "openai" }), /unknown LLM_PROVIDER/);
});

test("llmFromEnv builds the right guarded client and model", () => {
  assert.equal(llmFromEnv({}), undefined);
  const g = llmFromEnv({ GEMINI_API_KEY: "g" })!;
  assert.ok(g instanceof GuardedLlm);
  assert.ok((g as unknown as { inner: unknown }).inner instanceof GeminiLlm);
  assert.equal(g.model, DEFAULT_GEMINI_MODEL);
  assert.equal(llmFromEnv({ LLM_PROVIDER: "gemini", LLM_API_KEY: "k", LLM_MODEL: "gemini-4-argon" })!.model, "gemini-4-argon");
  assert.ok((llmFromEnv({ LLM_API_KEY: "a" }) as unknown as { inner: unknown }).inner instanceof AnthropicLlm);
  assert.throws(() => llmFromEnv({ LLM_PROVIDER: "gemini" }), /needs GEMINI_API_KEY/);
  assert.throws(() => llmFromEnv({ GEMINI_API_KEY: "g", LLM_MAX_CALLS: "lots" }), /LLM_MAX_CALLS/);
});
