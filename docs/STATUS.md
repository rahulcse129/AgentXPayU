# Margin: status

Last updated: 2026-11-01. Submission deadline: 13 November 2026.

## Live vs simulated, today

| Rail / component | Mode `mock` (default) | Mode `live` | State |
|---|---|---|---|
| Card holds (Airwallex) | `MockAirwallex` | `AirwallexHoldGateway`, sandbox | **Not yet run against the sandbox.** Client written, `VERIFY` fields open. |
| Provider payments (Metal x402) | `MockMetal` | `MetalFloatGateway`, testnet | **Not wired.** Stub with documented contract and SDK surface. |
| Mandates (Metal) | — | planned, §5.3 | **Not started.** |
| Clearing (Metal) | `ClearingEmulator` | none | **SIMULATED in every mode.** Not available to builders on testnet. |
| LLM judge / explainer / report text | `TagJudge`, template lines | `LlmJudge`, `Explainer`, `ReportWritingProviders` on Gemini (`gemini-3.5-flash-lite`) or Claude (`claude-opus-5-5`) | **LIVE on Gemini** (2026-11-01 run below). Claude path tested with fakes only. |
| Dashboard | Next.js 16 app + engine server, all rails mocked | same UI; rails switch badges to LIVE when wired | **Built.** Driven end to end in a browser (2026-11-01). |

The only LIVE component is the LLM, on Gemini. Every money number on screen and in reports comes from the mocks or the emulator.

## What is done

- **Baseline kept green.** `npm run check` = typecheck + unit tests + 10,000-run sim + sabotage.
- **Pinned packages.** `@metalntwx/metal-agent@0.3.3` (`npx metal-agent --version` prints `0.3.3`) and `@metalntwx/metal-pay@0.3.4`, both exact, plus `viem`.
- **Unit tests (`test/`, 112 tests).** Every exported policy function with boundaries (exact headroom, one micro short, zero float, all providers slow, price tie broken by latency), `verifyQuote` (overquote by one micro, underquote allowed, wrong payee, wrong asset, fractional/negative), ledger idempotency conflicts, hold lifecycle, `SqliteStore` ↔ `MemoryStore` parity, and the database-level `captured <= authorized` check.
- **Adapter contract tests.** The same suites run against `MockMetal`/`MetalFloatGateway` and `MockAirwallex`/`AirwallexHoldGateway`. The live runs are skipped unless `METAL_PRIVATE_KEY`+`METAL_RPC_URL` or `AIRWALLEX_CLIENT_ID`+`AIRWALLEX_API_KEY`+`AIRWALLEX_TEST_PAYMENT_METHOD` are set.
- **Clearing (§5.4) behind `ClearingPort`, emulated.** See below.
- **Fix:** `npm run providers` never started on Windows, because the entry-point check compared a `file://` URL to a Windows path. It now uses `pathToFileURL`.

## Dashboard (§5.6)

`apps/dashboard` (Next.js 16.4.2, App Router, production build) talks to the engine server in `src/server/` (port 4100) over Server-Sent Events.

- **Engine server** (`src/server/session.ts`, `main.ts`) runs the scripted scenario from `src/sim/scenario.ts` in the mocked world. Hold increases go to a human (`PendingApprovals`, 30 s timeout counts as a decline). Deliveries are paced to a watchable speed. One run at a time, and a reloaded page gets the run replayed.
- **What's on screen:** a header with the mode and a badge per rail (SIMULATED / NOT BUILT / LIVE / OFF, with details on hover); three job cards (hold with increment history, spent, current step and provider, step progress, a status chip); the reasoning feed (fact plus the policy's verbatim reason, upgraded to LLM phrasing at the end of a run when a key is set); the approval modal with countdown; demo controls; and the proof badge with sabotage results.
- **Reconciliation and receipts** are computed by the engine from the mock rails themselves, not from the feed: ledger paid = rail settled = clearing redeemed = captured, per job and in total, plus the same invariant check as the sim. Receipts list step, provider, list price, paid (or "refused (asked $X)"), tx hash, clearing running total and policy reason, ending with hold, captured, released and savings against a premium-only full plan.
- **Honesty:** mock tx hashes are shown but not linked to the testnet explorer, because they are not on any chain. The **mandate-test button is labelled "not built"** and the engine answers it with 501, because §5.3 doesn't exist yet. The scripted run also overruns job C at round 3, so a second customer can decline (beat 5).
- **Verified in the built-in browser:** a scripted run through the real buttons, B approved in the modal and C declined. All six beats appeared. "✓ Every dollar accounted for" reconciled $1.39 four ways, with 0 violations. Layout checked at 1280 px (three cards, 7/5 split, no overflow) and 375 px (single column; only tables scroll). `test/server.test.ts` drives the same run over HTTP and SSE in CI.
- **Not checked yet:** how it looks in screenshots (the pane was hidden during testing, so verification used page text and DOM measurements), dark mode, and an engine run with the LLM on (about 17 calls on your Gemini quota).
- **Fix found while testing:** the rogue refusal read "quoted 420000 micros" on screen. `verifyQuote` now says "quoted $0.42, list price $0.14 (420000 vs 140000 micros)".

## Agent intelligence (§5.5)

Code in `src/agent/`. Turned on in the demo by a key in the environment or in `.env`, which `npm run demo` reads itself. Without one, `npm run demo` stays offline and deterministic.

**Two providers behind one `LlmClient` seam**, chosen by `llm-config.ts`:

| Key set | Provider | Default model | Client |
|---|---|---|---|
| `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Gemini, preferred when set | `gemini-3.5-flash-lite` | `GeminiLlm`, `@google/genai@2.32.0` Interactions API |
| `LLM_API_KEY` / `ANTHROPIC_API_KEY` | Claude | `claude-opus-5-5` | `AnthropicLlm`, `@anthropic-ai/sdk` |

`LLM_PROVIDER=gemini|anthropic` forces one, and `LLM_MODEL` overrides the model. Gemini notes, from Google's docs and the SDK types (2026-11-01):
- Google's docs now use the Interactions API (`client.interactions.create`) in every example, so that is what we call.
- Structured output is `response_format: { type: "text", mime_type: "application/json", schema }`.
- `temperature` is deprecated and ignored on Gemini 3.6+, so steadiness comes from `thinking_level: "low"`.
- Thinking tokens count toward `max_output_tokens`, so budgets are at least 2048.
- Every request sends `store: false`, so Google keeps no prompts or provider outputs.
- Any status other than `completed`, or an empty answer, is an error, and the caller falls back without the LLM.

- **`GuardedLlm`** (`guard.ts`) wraps every client. On a 429, rate limit or quota error, after 3 failures in a row, or once `LLM_MAX_CALLS` is spent, it turns the LLM off for the rest of the run, so later calls fall back at once instead of waiting. The Gemini client also disables the SDK's default 5-attempt, up-to-60-s backoff on 429.
- **`LlmJudge`** returns `{ score, reason }` for an answer. Rubrics per step kind, cached by a SHA-256 of the output. Scores must be in 0..1; anything else counts as malformed, because live flash-lite once answered `3`, and clamping would have turned that into a perfect 1.0. On any LLM failure (error, refusal, cut-off, malformed JSON) it returns the neutral score 0.7 and does not cache it. The provider's output is fenced as untrusted data. In the demo it grades model steps only, because search and data are still placeholders; those keep `TagJudge`.
- **`Explainer`** gives one feed line per ledger event. The facts come from deterministic templates (`describe.ts`), and the policy's own `why` is kept verbatim beside the line. The LLM may only rephrase decision events. The demo batches them, about 21 lines in one call, with each line checked on its own. `faithful()` rejects any rephrasing that adds a number, amount or provider id not in the source, or runs to several lines. A rejected or failed rephrasing falls back to the template.
- **`ReportWritingProviders`** wraps the provider port. Quotes pass through untouched, so prices still come only from `catalog.ts`. An honest model step's delivered text becomes real prose in the provider's tier style. Junk and crash modes keep misbehaving. Search and data stay SIMULATED, and the prompt forbids citing sources. The demo writes `demo-report.md`.
- **Deviations from the project prompt, forced by the current API:** on `claude-opus-5-5`, `temperature` and forced `tool_choice` both return 400. So the judge's "one typed tool call" is structured output (`output_config.format`, JSON schema), and "low temperature" is `effort: "low"`. Requests opt into `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`), so a classifier refusal is retried server-side on Anthropic's recommended fallback model.
- **Proof the LLM cannot move money:** `test/agent.test.ts` runs 300 sim scenarios with hostile judges (always 0, always 1, random, out of range, unavailable, garbage) and requires zero invariant violations. Neither the judge prompt nor the writer prompt contains prices, budgets, holds or addresses; tests check this.
- **Bug found by that test, and fixed:** with every answer judged junk, the engine looped until its 500-round guard tripped. `degradePlan` priced a step at a provider that had already failed that step, so the "fitting" plan could never be bought. The fix: `estimateRemaining` and `degradePlan` take per-step exclusions, and a no-progress round that leaves a plan unchanged drops the stuck step. Money was always settled correctly by the `finally` block. The same fix removed 14 "did not converge" crashes from the idempotency sabotage run, which is still caught.

### Live run, 2026-11-01 (Gemini, `gemini-3.5-flash-lite`)

`npm run demo` with `GEMINI_API_KEY` in `.env`. Saved in [live-runs/2026-11-01-gemini-demo-report.md](live-runs/2026-11-01-gemini-demo-report.md) and [live-runs/2026-11-01-gemini-demo-feed.txt](live-runs/2026-11-01-gemini-demo-feed.txt).

- 70 s end to end, 17 LLM calls, 0 failed. 8 answers graded, 21 feed lines phrased (0 rejected as unfaithful), 8 report sections written, 0 fallbacks.
- All invariants hold. Reconciliation is identical to the offline run: $1.50 ledger = rail = clearing [SIMULATED] = captured. The LLM changed no money outcome.
- The reports are coherent and on topic, with the requested paragraph counts, no invented citations and no placeholder tags.

What the first attempt taught us (now fixed):
- The key is on the free tier, and `gemini-3.8-flash` allows **20 requests a day**. The first attempt used up that quota. The SDK then retried every 429 with long backoff, so calls took 4+ minutes each and the demo stalled. The fixes: `GuardedLlm`, no SDK retry on 429, the batched explainer (about 60 calls down to about 17), and `gemini-3.5-flash-lite` as the default.
- The key was first pasted into `.env.example`, which is committed. It was moved to the git-ignored `.env` before any commit; it is not in git history.

Known issues:
- **The judge is too lenient on flash-lite.** All 8 live answers scored exactly 1.0, tier-1 and tier-2 alike, so the premium redo never triggers in the live demo. It is no money risk, but the rubric needs calibration anchors (for example "competent = 0.75; reserve 0.9+ for exceptional") and a few live runs to check, within the free-tier quota.
- Free-tier Gemini terms may let Google use prompts and outputs to improve its products. The demo sends only made-up report topics and generated text, no customer or payment data.
- Some phrased lines are clunky ("Reserved $0.16 leaving $0.14 left"), and the rogue-quote reason shows raw micros ("quoted 420000 micros"), because that is how `verifyQuote` words it.

## Clearing: why it is emulated

From the hackathon track channel: Metal clearing (per-job deposit, signed running totals, epochs, withdrawal after epoch close) **is not available on testnet for builders**. `metal-agent` 0.3.3 has no clearing commands. Another Kit 12 team has asked Metal whether an emulator is acceptable, and that question is still open.

What the installed SDK shows (read 2026-11-01): `metal-pay@0.3.4` *does* ship a clearing client: `createClearingClient`, `depositToClearing`, `clearingSpendable`, `clearingBalance`, `withdrawFromClearing`, `ClearingRefusal` (`between_epochs`, `insufficient_deposit`, `answer_lost`, `payment_held`), and `openClearingWallet` from `/node`. It signs cumulative payments with **P-256**, needs a Clearing deployment that the facilitator lists in `/supported`, and calls the offer scheme `bajillion`. So a live adapter has a concrete target once Metal opens a testnet deployment to builders.

How we built it:

- `src/clearing/port.ts`: `ClearingPort` with `openDeposit`, `signRunningTotal`, `closeEpoch`, `settle`, `withdraw`, plus `raiseDeposit` (a hold increase must raise the deposit too; Metal's `depositToClearing` can fund an account again) and `status`.
- `src/clearing/emulator.ts`: `ClearingEmulator` enforces Kit 12's rules. It allows one deposit per job, running totals never go down, a job's totals never exceed its deposit, payees redeem only above what they already redeemed, a signature must verify before redemption, and the unused deposit can be withdrawn only after every epoch the job signed in has settled. Any attempt to break a rule is refused and recorded.
- Signatures: EIP-712 typed data via viem (`Eip712Signer`, domain chain id 63825 = Metal testnet). Real Metal clearing uses P-256, so these signatures only show the protocol shape and are not interchangeable with Metal's.
- Engine: the deposit mirrors the card hold. It is raised **after** Airwallex's increment succeeds, and the ledger's hold is raised last. Every paid x402 payment is also signed as the job's cumulative total to that payee. Epochs settle every N rounds. **Finality gate:** a hold is captured or cancelled only after that job's clearing is closed, settled and withdrawn; otherwise the capture is deferred and logged.
- Labelling: every clearing ledger event carries `source: "simulated"`, the demo prints `[SIMULATED]`, and `sim-report.json` has a separate `clearing` block with `source: "simulated"`.
- Config: `CLEARING_MODE=emulator` (default) | `off` | `live`, read by `clearingFromEnv()`. `live` refuses to start with an explanation rather than silently falling back. The demo, dashboard and sim don't read it yet: they always build the emulator, the only implementation. Wire them to `clearingFromEnv()` when a live adapter exists.
- Sim: 5 new invariant families (no rule broken; no total redeemed twice; redeemed = ledger paid per job; deposit − redeemed = withdrawn; captured only after final). Every 500th seed (20 runs) uses real EIP-712. The rest use a keyed-hash signer with the same accept/reject behaviour, because EIP-712 recovery costs about 14 ms per check (benchmarked) and the full sweep checks 144k totals.

Result of `npm run sim` (10,000 runs): **0 violations**. 143,996 running totals signed, matching the 143,996 provider payments one for one; 123,312 redemptions over 41,499 epochs. All pre-existing statistics are unchanged from the baseline, so the engine's money behaviour did not change. `npm run sim:sabotage`: all **5** broken engines caught, including the new `finality` sabotage (captures before epoch close), caught in 1,987 of 2,000 runs.

## What blocks live mode (needs the team)

1. **Airwallex sandbox keys** (`AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`) to resolve the `VERIFY` comments in `src/payments/airwallex.ts`: is `increment_authorization.amount` the new total or the delta, which card brands support it, the minimum capture amount, and the cancel body field names. Then run `scripts/airwallex-smoke.ts` (not written yet).
2. **Metal testnet:** an account created on 0.3.3 (`metal-agent account create`), a funded key, and an RPC endpoint from the console. The console's billing page has hung for other teams, so use any working endpoint via `METAL_RPC_URL`.
3. **Design decision for mandates (§5.3):** with a mandate, the agent pays *from the owner's MetalAccount* (`createMandatePaymentClient`), not from a float wallet it holds. So `FloatGateway.deposit` becomes "fund the owner account and bind the mandate", and `withdraw` becomes "revoke and leave the rest in the owner account". Rahul should confirm this before `MetalFloatGateway` is written.
4. The mock provider server still trusts `X-PAYMENT`. Real verification goes through Metal's facilitator: `https://x402-testnet.metalntwx.com/x402/facilitator` with `registerMetalScheme` on an `x402ResourceServer`. That needs `@x402/core` and a middleware package (`@x402/hono` or `@x402/express`), which are not installed yet.

## Known limitations

- One clearing deposit per job is sized to the hold, not to the job's share of the float. In the emulator that is harmless. With live clearing, it would lock the full hold per job until the epoch closes.
- Epochs advance by engine rounds, not wall-clock time.
- A hold whose capture was deferred by the finality gate is meant to be retried by a startup sweeper, which is not written yet (§5.7, days 7–8).
