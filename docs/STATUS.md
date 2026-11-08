# Margin: status

Last updated: 2026-11-01. Submission deadline: 13 November 2026.

## Live vs simulated, today

| Rail / component | Mode `mock` (default) | Mode `live` | State |
|---|---|---|---|
| Card holds (Airwallex) | `MockAirwallex` | `AirwallexHoldGateway`, sandbox | **Unblocked for intents** (new sandbox in a supported region, 2026-11-08): login and PaymentIntent creation work. Confirming needs Airwallex Drop-in/Elements in the browser (below); not built yet. |
| Provider payments (Metal x402) | `MockMetal` | `MetalFloatGateway`, testnet | **LIVE on testnet** (2026-11-01). The engine pays through Metal's x402 facilitator, and providers verify each payment on chain. `npm run live:x402`; passes the adapter contract tests live. **On the dashboard via `npm run engine:live`.** The terminal demo still uses `MockMetal`. |
| Mandates (Metal) | `MockMandateGateway`: same rules in memory, in front of every payment | `MetalMandateGateway`: real `metal-agent` mandate commands, `engine:live-mandate` | **LIVE on testnet** (2026-11-06): bind, pay, refusals recorded on chain, raise, revoke, and a full dashboard run through the mandate. Offline runs use the SIMULATED mandate. |
| Clearing (Metal) | `ClearingEmulator` | none | **SIMULATED in every mode.** Not available to builders on testnet. |
| LLM judge / explainer / report text | `TagJudge`, template lines | `LlmJudge`, `Explainer`, `ReportWritingProviders` on Gemini (`gemini-3.5-flash-lite`) or Claude (`claude-opus-5-5`) | **LIVE on Gemini** (2026-11-01 run below). Claude path tested with fakes only. |
| Dashboard | Next.js 16 app + engine server, all rails mocked (`engine:offline`) | `engine:live`: Metal x402 LIVE, header MODE: MIXED, per-rail badges | **Built; live Metal rail verified in a browser** (2026-11-01, run below). |

LIVE today: provider payments on Metal testnet (`npm run live:x402`, and the dashboard via `npm run engine:live`) and the LLM on Gemini. Card holds and clearing are SIMULATED (Airwallex region block; clearing not on testnet). The terminal demo is fully mocked.

## Metal x402 payments, live (§5.2)

- **`MetalFloatGateway`** (`src/payments/metal.ts`) sends x402 v2 `exact` payments in USDZ on `eip155:63825`, settled by Metal's facilitator (`HTTPFacilitatorClient` from `@x402/core`).
  - The payload is the same EIP-3009 `TransferWithAuthorization` that `@x402/evm`'s `ExactEvmScheme` builds, with `extra` matching `metal-pay`'s `metalUsd`.
  - The one difference: **the ERC-3009 nonce is `keccak256("margin:" + idempotencyKey)`**, not random. The USDZ contract accepts each (payer, nonce) once, so no retry, restart or duplicate call can pay twice, whatever the process remembers.
  - `lookup()` answers from chain, via `authorizationState` and the `AuthorizationUsed` event.
  - A facilitator timeout is a `TransientError`, and the engine's retry reuses the nonce.
  - Before the first payment, `preflight()` refuses a non-testnet RPC or a clock more than 30 s off the chain.
  - Float is accounting against the agent wallet, capped by its on-chain balance. Micros → base units is exactly ×10¹².
- **Providers verify before delivering** (`src/providers/verify.ts`, `ChainPaymentVerifier`). The server reads the transaction and requires all of:
  - the transaction succeeded
  - an `AuthorizationUsed` event, so it's an x402 settlement
  - a USDZ transfer to this provider's registered address of at least the price it quoted for that purchase key
  - the transaction not already used to buy work (replay protection)

  The demo keeps `TrustingVerifier`, labelled SIMULATED. Run `VERIFY_PAYMENTS=chain npm run providers` for live.
- **Live engine run 2026-11-01** ([log](live-runs/20261031224714-engine-x402-run.md)): one job, 3/3 steps, three live payments: search $0.02 ([tx](https://testnet.metalntwx.com/tx/0xcc74e6dc41dc541c42aeaf9a61fee543d511b9f44c802f20c44e2c3dc60f863b)), brief $0.04 ([tx](https://testnet.metalntwx.com/tx/0x884c44e68a9af36cf6aed25a59b4129e08d03b55700da4434471297602f34d5e)), lookup $0.03 ([tx](https://testnet.metalntwx.com/tx/0xad281cb4013fc3ae2c74564819663bd761adafdd9417b16da98b7572c8b12b26)).
  - The rogue `model-bargain` quoted $0.06 against a $0.02 list price. It was refused and blocked **before any payment**, and the step was bought from `model-std`.
  - Every payment was re-read from chain independently of the gateway: the transfer matches the ledger and the nonce is used. **Ledger $0.09 = on-chain $0.09 = captured $0.09** (hold SIMULATED). Reconciled.
- **Live contract tests** (`npm run test:live`): `MetalFloatGateway` passes the same FloatGateway contract as `MockMetal` on testnet, including the idempotency and replay-refusal cases. Wallet accounting adds up: 99.99 − 0.09 (run) − 0.03 (contract tests) = 99.87 USDZ, read on chain.
- **Offline tests** (`test/metal.test.ts`, 13) use a fake chain and facilitator:
  - the signature recovers to our address under USDZ's EIP-712 domain
  - a repeated key asks the facilitator nothing
  - a restarted process finds the earlier payment on chain and doesn't pay again
  - timeouts before and after settlement are handled
  - refusals map to `PaymentRefused` / `InsufficientFloat`
  - the clock and chain guards hold
- **On the dashboard (`npm run engine:live`).** The engine server pays through a fresh `MetalFloatGateway` per run and buys from HTTP providers that verify each payment on chain. The demo buttons drive those providers over their `/control` endpoint.
  - The header reads **MODE: MIXED** and the Metal rail badge **LIVE**, with the agent address on hover. Airwallex and clearing stay SIMULATED.
  - Receipts link every Metal tx to the testnet explorer. Mock hashes are never linked.
  - Reconciliation's "Settled on chain" column re-reads each payment from chain after the run (`src/payments/metal-audit.ts`, independent of the gateway). The invariant check runs against those on-chain settlements in place of MockMetal's.
  - Each run starts with `preflight()` (chain and clock); if it fails, the run stops with a message before anything is paid.
- **Live dashboard run, 2026-11-01** ([record](live-runs/2026-11-01-dashboard-live-metal-run.md)), started from the "Run scripted demo" button:
  - **13 live x402 payments**, all linked; the rogue's $0.42 quote against a $0.14 list price was refused and blocked before any payment.
  - B's hold increase was approved. C's timed out and counted as a decline, so this run also exercised the timeout path live.
  - **Ledger $1.39 = settled on chain $1.39 = captured $1.39**, 0 violations, "✓ Every dollar accounted for".
  - The wallet went from 99.87 to **98.48 USDZ**, exactly the $1.39 spent.
  - A scripted dashboard run costs about 1.4 testnet USDZ; the faucet tops up.
- Fixed during the run: the header briefly said "MODE: MOCK" before the engine's metadata arrived. It now shows "MODE: …" until the engine says which rails are live.
## Metal mandates (§5.3) and the startup sweeper

First version by Kavisha (`dbe6432`, Nov 6): mandate interface, simulated gateway, lifecycle manager with ledger events, amount formatter, startup sweeper. Reviewed and reworked the same day. The original typechecked and passed tests, but the live gateway called commands `metal-agent` 0.3.3 doesn't have (`mandate create --payees`, `raise`, `--json`), the mandate wasn't connected to any run or payment, the 5¢ per-payment cap would have blocked almost every real step (24–30¢), and the sweeper read a ledger the engine never writes and closed holds on a fresh in-memory mock.

**How mandates work now**
- **Payments go through the mandate.** `MandateManager` *is* the engine's float. `deposit(float)` opens the mandate (credential + bind) with budget = the batch's float and a payee allowlist = the catalog's registered addresses. Every `pay()` is a pull under the mandate, which checks payee, per-payment cap and budget before anything moves. After an Airwallex increment succeeds, the engine's new `onHoldIncremented` hook raises the budget by the increment. When the batch ends, `close()` revokes it. Each step is in the ledger and the feed (`mandate.opened`, `raised`, `revoked`, `refused`).
- **The cap is the largest single payment the policy can ever make:** one job's maximum hold ($3.00). The mandate's real teeth are the **payee allowlist** and the **total budget**; the cap is a backstop.
- **A refusal is handled, not a crash.** `PaymentRefused` (in `payments/types.ts`) means nothing moved. The engine records the refusal on the receipt, blocks the provider and buys elsewhere; it doesn't retry. The x402 gateway's facilitator refusals use the same class.
- **Live gateway** (`MetalMandateGateway`) runs the commands exactly as `metal-agent --help` documents them, through Node:
  - `mandate credential create`, then `mandate bind`
  - `mandate replace` with a wider credential under the same mandate key (spend carries over)
  - `mandate revoke`
  - `mandate pull --payment-id <idempotency key>`, which "pays at most once" per id. Exit codes: 0 paid, 1 refused/error, 3 pending (→ `TransientError`), 4 held.

  Output is parsed from its `key value` lines; the format was confirmed from a real offline `credential create` with a throwaway key. Amounts are to the cent, and anything finer is refused, not rounded. Credentials and the mandate key live outside the repo (`METAL_MANDATE_DIR`, default `~/.metal-agent/margin-mandates`).
- **Offline, every dashboard run pays through the simulated mandate**, labelled SIMULATED, so both locks are always on. `engine:live` (agent-wallet x402) runs without one, and its badge says so. `engine:live-mandate` uses the real one.
- **The "Disable our quote check (mandate test)" button works.** It turns our own `verifyQuote` off (logged on every skipped check), points the rogue at an unregistered address and gives it another chance. The mandate refuses the payment. Our check switches back on by itself after the refusal, or at the end of the run. `test/server.test.ts` drives this end to end: the rogue's quote is skipped by us, refused by the mandate, blocked, no money reaches the bad address, and the run reconciles.

**Sweeper** (`src/ledger/sweeper.ts`)
- It finds holds still `authorized` in a persistent ledger.
- It resolves each payment the crash left pending from the rail: settled → paid, not → failed.
- If the rail can't answer, it leaves the hold open and reports it. It never captures a guess.
- Then it captures what was spent (floored to the cent), or cancels, retrying transient errors. Events go through `Ledger`, the same as the engine's.
- `test/sweeper.test.ts` simulates crashes with SQLite plus surviving holds and rail: capture/cancel, settled vs unsettled pending payments, unresolved-pending skip, idempotent re-sweep, transient vs permanent capture errors.
- **Not wired into the dashboard on purpose:** its card holds are `MockAirwallex` in memory, so nothing survives a crash to sweep. The engine prints that at startup. It runs where holds are real Airwallex intents.

### Live on testnet, 2026-11-06

**Setup:** owner MetalAccount `0x9819C6c7c14D03fF90e0069873d16CA4BF1386EB`, controlled by owner key `0x5D26…71Be`. The key file is outside the repo at `~/.metal-agent/owner-key.json`. The account was funded with 100 USDZ from the faucet ([tx](https://testnet.metalntwx.com/tx/0xcb070f7b2a65900fcd5a09252d18b458bed9c1fa478add466ebf45a2da64df76)).

**Lifecycle (`npm run live:mandate`, [record](live-runs/20261106042111-mandate-lifecycle.md))**, every step re-read from chain:

| Step | Result |
|---|---|
| Bind (6 payees, 3¢ cap, $0.20 budget) | [tx](https://testnet.metalntwx.com/tx/0x1b0ca3597aa56105f7b0c37ab6988d7ac6cd5dcb04b29200233a994b4d7e276c) |
| Pay 1¢ to model-lite | [tx](https://testnet.metalntwx.com/tx/0xcfcbc09ddb4ce976bf4db7760296058e349b2ac6ea4dbdfa7283c2dc73625ce4): 0.01 USDZ from the account, with an `AuthorizationUsed` event |
| Same payment id again | reports the same tx; pays once |
| Unregistered payee | refused, `mandate_payee_not_listed`, **recorded on chain** [tx](https://testnet.metalntwx.com/tx/0x2a869170066fc6e1a23922c7f85c1b6188f36b038326550303821055758c4cd3) |
| Over the cap | refused, `mandate_cap_exceeded`, recorded [tx](https://testnet.metalntwx.com/tx/0xf81a9c9a4a3897e0a7b68e3469abf7ce67d3fad91ddfd8e08023724061e4a8d5) |
| Raise budget to $0.25 (replace) | [tx](https://testnet.metalntwx.com/tx/0x76ce76ff55aa517a8e7cb81ed017c258605e47079855f830a01d24387074efd2) |
| Revoke | [tx](https://testnet.metalntwx.com/tx/0x51130f8fbeb0b51659b39a8b18e7e1eeb35e99da2471bb327dc0e580912d11d1); any later pull is refused `mandate_revoked` |

The account moved by exactly the 1¢ paid. Steps take about 7–23 s each.

**Dashboard run through the live mandate (`npm run engine:live-mandate`, [record](live-runs/2026-11-06-dashboard-live-mandate-run.md))**, started from "Run scripted demo":
- 169 s end to end, **12 live payments** as mandate pulls, each linked to the explorer.
- Mandate bound [tx](https://testnet.metalntwx.com/tx/0xa9a7150cba3edfbd86ea0c59a87f5b5de0ad7f0435d2058e78d64b98722cbfe3) and revoked [tx](https://testnet.metalntwx.com/tx/0x395fd61fd8f4f6367d80f701270d7885145ddec1f5c340511fa43051490931b3).
- **The defence-in-depth moment, live:**
  1. Our check refused the rogue's 3× quote and blocked it.
  2. The mandate test turned our check off. The log shows our check "would have refused" a payment to `0xdead…`.
  3. **The live mandate refused it**, `mandate_payee_not_listed`, recorded on chain [tx](https://testnet.metalntwx.com/tx/0x81e8bd6eefeedfa866588532e926481a3244de87a3d7ee089953c637efcb2803).
  4. Our check came back on, and the rogue was blocked.
- **Ledger $1.47 = settled on chain $1.47 = captured $1.47**, re-read from the owner account's transfers. 0 violations.
- The dashboard shows "✓ Policy check · ✓ Metal mandate LIVE" with the bind and revoke links.
- C declined its hold increase. B didn't need one in this run: the test detour changed its purchases, and it spent $0.60 of $0.75. So the **budget raise** is proven live by the lifecycle script's replace tx, and its ordering (only after the Airwallex increment) by `test/server.test.ts`.

**Changes from running it live:**
- Refusals carry Metal's own reason code (`mandate_payee_not_listed`, `mandate_cap_exceeded`, `mandate_revoked`) instead of "refused on chain". The CLI's own word is "not sent", unless the refusal is recorded.
- Refusals are recorded on chain by default (`--record-refusal`, gas from the owner key; `METAL_RECORD_REFUSALS=0` turns it off).
- The tx parser now accepts only a whole 64-hex hash; after a revoke the CLI printed a bare `0x`.

## What is done

- **Baseline kept green.** `npm run check` = typecheck + unit tests + 10,000-run sim + sabotage.
- **Pinned packages.** `@metalntwx/metal-agent@0.3.3` (`npx metal-agent --version` prints `0.3.3`) and `@metalntwx/metal-pay@0.3.4`, both exact, plus `viem`.
- **Unit tests (`test/`, 146 tests).** Every exported policy function with boundaries (exact headroom, one micro short, zero float, all providers slow, price tie broken by latency), `verifyQuote` (overquote by one micro, underquote allowed, wrong payee, wrong asset, fractional/negative), ledger idempotency conflicts, hold lifecycle, `SqliteStore` ↔ `MemoryStore` parity, and the database-level `captured <= authorized` check.
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

1. **Airwallex sandbox:** keys **in place and verified 2026-11-01.** A scoped key with only Payment Acceptance read/write and no IP whitelist logs in through our client (`/api/v1/authentication/login` returns 201 with a token valid for about 30 minutes). Still to do: resolve the `VERIFY` comments in `src/payments/airwallex.ts` (is `increment_authorization.amount` the new total or the delta, which card brands support it, the minimum capture amount, the cancel body field names), then write and run `scripts/airwallex-smoke.ts`. A bare `curl -X POST` with no body gets `411 Length Required`; send an empty body.
   - **Blocked (2026-11-01): creating any PaymentIntent fails** with `400 configuration_error: "Invalid request against merchant configuration. Please contact your account manager."` (trace `614b422ec73243a1b1027372eb050483`). It fails the same way in USD, HKD, SGD, AUD, EUR, GBP, INR and CNY, and on both `api.sandbox.airwallex.com` (the documented host, now the default) and `api-demo.airwallex.com`. **Root cause, from the sandbox dashboard's Payments page: "Payments isn't available in your region yet. Payments isn't available yet for any of the legal entities in your organisation."** Card acceptance is off for this organisation because of where its legal entity is registered, and no key, header or code change can fix that. Next: ask the organisers or the track channel for a sandbox in a supported region, or create one for an entity in a supported country (see "Payments Coverage" in the dashboard). Until then card holds stay on `MockAirwallex`, labelled SIMULATED. (`AIRWALLEX_LOGIN_AS` stays supported but isn't the fix here; the business-account UUID in dashboard URLs is rejected as an invalid account ID format.)
   - **Airwallex confirmed the cause** on Slack: the account was registered in India, where Payment Acceptance isn't supported. Their advice was a new sandbox with a supported business country.
   - **New sandbox, 2026-11-08: the region block is gone.** Login returns 201, and `payment_intents/create` returns 201 (`int_sgpvtdh4nhnz80dy0hz`, `REQUIRES_PAYMENT_METHOD`, $1 USD).
   - **Next wall, expected: confirming with raw card data is refused.** `confirm` with a card number from our server returns `400 validation_error: "This account is not enabled for native API access…"` (trace `9a38cd23a1fa48d58017d5dbfecf1f56`). Only merchants approved to handle raw card data may do that; everyone else collects the card in Airwallex Drop-in/Elements in the browser, using the intent's `client_secret`. That is what the project prompt requires anyway ("No raw card data touches our server"). The smoke script's server-side confirm path only works for approved accounts.
   - **To do:** create the intent server-side, let the customer confirm it in Drop-in on the dashboard (pre-auth, manual capture), have the engine wait until the intent reaches `REQUIRES_CAPTURE`, then increment, capture and cancel server-side.
   - Fixed from the docs: `authorization_type: "pre_auth"` and `auto_capture` apply "only when `payment_method` is provided", so they now go on **confirm**. They were on create, where they'd be ignored, and increments would have failed.
   - `npm run smoke:airwallex` is ready. It refuses non-sandbox hosts, uses Airwallex's published always-succeed Visa test card, and reads each intent back so the increment semantics (new total vs delta) come from the sandbox's own behaviour.
2. **Metal testnet:** RPC endpoint and agent key **in place and verified 2026-11-01.**
   - The console endpoint (network `alta-testnet`) answers chain ID **63825**, the `eip155:63825` that `metal-pay` names for testnet.
   - Agent address: `0xbf3C4a9e8E907Ae6e2c6Ac80A3b51B94D740f696`. **Funded from the testnet faucet: 100 USDZ** (checked 2026-11-01 at block 11,258,522; native and token balances are the same number).
   - **First `metal-agent pay` to the demo payee (2026-11-01): two blockers found, nothing paid either time.**
     1. *Crash after signing:* `this.client.handlePaymentResponse is not a function`. `metal-agent@0.3.3` pins `@x402/core@2.28.0`, but npm resolved `@x402/fetch@2.29.0`, which calls a method that only exists in core 2.29. **Fix:** root `package.json` `overrides` pin `@x402/core`, `@x402/evm` and `@x402/fetch` to **2.28.0**, the version metal-agent pins and metal-pay 0.3.4 was developed against. The Metal packages themselves stay at 0.3.3/0.3.4. Before retrying, the on-chain ERC-3009 `authorizationState` for the signed nonce was checked: unused, so nothing settled and no double payment was possible.
     2. *Refused:* `payment refused: authorization_window … nothing was paid`. This machine's clock was **106 s behind** the chain and the facilitator, and Windows time was unsynchronized. Authorizations are signed with a short validity window from the local clock. **Every machine that pays (dev laptops, the demo laptop) needs its clock synced.** The live adapter should also check the gap between the local clock and the latest block time at start-up and refuse to pay if it's large. On Windows, `w32tm /resync` failed with "no time data was available" because no time server was configured; `w32tm /config /manualpeerlist:"time.windows.com,0x9 pool.ntp.org,0x9" /syncfromflags:manual /update`, a restart of `w32time`, and `w32tm /resync /force` fixed it, leaving the clock within about 1 s of the chain.
     3. **Third attempt: paid (LIVE).** `npx metal-agent pay https://x402-demo-testnet.metalntwx.com/quote --network testnet` returned status 200 and paid **0.01 USDZ**. Transaction [`0x6bb69259a229ce79c97561ea6528ced702e1012163a84a6c1a569e906e321132`](https://testnet.metalntwx.com/tx/0x6bb69259a229ce79c97561ea6528ced702e1012163a84a6c1a569e906e321132), block 11,268,895. Checked on chain, not just from the CLI's output: receipt success; one USDZ `Transfer` of exactly 0.01 from `0xbf3C…f696` to the payee `0xA1EA…8F88`; ERC-3009 nonce `0xb747…4d97` marked used; balance 100 → **99.99**. The payee side submitted the transaction and paid its gas, so we paid only the price.
   - **USDZ** is at `0x…B5d5`, has **18 decimals**, and is also the gas token, so the native balance and the USDZ balance are the same thing. Our ledger counts in micros (6 decimals): the live adapter must convert by exactly ×10¹² and never round.
   - Still to do: the owner account for mandates (`metal-agent account create`, needs the RPC), then the adapter itself.
3. **Design decision for mandates (§5.3):** with a mandate, the agent pays *from the owner's MetalAccount* (`createMandatePaymentClient`), not from a float wallet it holds. So `FloatGateway.deposit` becomes "fund the owner account and bind the mandate", and `withdraw` becomes "revoke and leave the rest in the owner account". Rahul should confirm this before `MetalFloatGateway` is written.
4. The mock provider server still trusts `X-PAYMENT`. Real verification goes through Metal's facilitator: `https://x402-testnet.metalntwx.com/x402/facilitator` with `registerMetalScheme` on an `x402ResourceServer`. That needs `@x402/core` and a middleware package (`@x402/hono` or `@x402/express`), which are not installed yet.

## Known limitations

- One clearing deposit per job is sized to the hold, not to the job's share of the float. In the emulator that is harmless. With live clearing, it would lock the full hold per job until the epoch closes.
- Epochs advance by engine rounds, not wall-clock time.
- A hold whose capture was deferred by the finality gate is left for the startup sweeper (`src/ledger/sweeper.ts`). That only applies where holds outlive the process (real Airwallex); dashboard holds are in-memory mocks.
