# Project prompt: Margin (Airwallex Agentic Banking Hackathon, Kit 12)

> Paste this whole file into your coding agent (Claude Code, Cursor, etc.) from the root of the `margin/` repo.
> It is written so the agent can build the project end to end without further context.

---

## 1. Your role and the goal

You are the lead engineer finishing **Margin**, an inference sourcing agent for the Airwallex Agentic Banking Hackathon (HackerEarth, Starter Kit 12 "Inference Sourcing Agent"). **Submission deadline: 13 November 2026.** Two-person team:

- **Rahul Pal** (Payments & Backend): Airwallex holds and captures, Metal payments and clearing, ledger, policy guardrails.
- **Kavisha Sharma** (Agent & Product): provider routing agent, LLM judge and explanations, mock providers, live dashboard, demo.

**What Margin does.** It runs AI research jobs and buys every paid step (model calls, web search, data lookups) from whichever provider best fits what is left of that job's budget. Each customer approves a spending cap up front as an Airwallex card pre-authorization. Margin pays providers per request in USDZ on Metal testnet, adapts when prices or latency change, and captures only what the job actually spent. **It never charges a customer past their hold without asking**, and it **never pays a provider more than its published price**.

**What wins.** Judges should believe this system is safe to hand real money to. Every claim on screen must be backed by code, tests or a transaction hash. Keep LIVE and SIMULATED clearly separated, and never blur them.

---

## 2. Facts from the official track channel (treat as constraints)

These come from the hackathon's Slack track channel and override anything older in the starter kit:

1. **Pinned package versions (Kits 11 and 12):** `@metalntwx/metal-agent@0.3.3` and `@metalntwx/metal-pay@0.3.4`. Pin these exact versions. `metal-agent --version` must print `0.3.3`.
2. **Accounts created with an older metal-agent must be recreated.** Run `metal-agent account create` again on 0.3.3 and use the new account. On 0.3.1, `mandate bind` reverted with "Execution reverted for an unknown reason". Since 0.3.3, mandates (spending limits) work live on testnet.
3. **Live on testnet:** key creation, funding, account creation, x402 payments, mandates (create, bind, caps, refusal, revoke).
4. **Metal clearing is NOT available on testnet for builders.** This is the per-job deposit, signed running totals, epochs and withdrawal after epoch close that Kit 12 describes. metal-agent has no clearing commands, and the docs don't name a clearing endpoint or facilitator. Another Kit 12 team asked Metal whether an emulator is acceptable, and that question is still open. **Our approach:** clearing runs behind an interface. The default implementation is a local emulator that follows Metal's documented clearing rules, and it is labelled SIMULATED everywhere. If Metal ships testnet clearing before the deadline, we swap in a live adapter without touching engine code.
5. **Testnet RPC credit:** the billing setup page at the Metal testnet console has hung on "Processing…" and returned "Card capture failed" for other teams. Don't block on it. Use a working RPC endpoint (your own or the kit default) and make it configurable via `METAL_RPC_URL`.
6. **There is a Metal Award.** Prize-relevant Metal usage includes mandates (caps, refusal, revoke), x402 payments and clearing. Use Metal features deeply where they add real safety (see §5.3), not as decoration.
7. When something fails on Metal, include `metal-agent --version` output and the exact failing command in any question to the channel.

**Never invent SDK APIs.** For `@metalntwx/metal-pay` and `@metalntwx/metal-agent`, read the installed package's README, `.d.ts` types and the Kit 12 / Kit 11 starter examples before writing calls. If a capability isn't there, say so in a code comment and in `docs/STATUS.md`, and fall back to the emulator.

---

## 3. What already exists (build on it, don't rewrite it)

The repo is a TypeScript (Node ≥ 22.13, ESM) scaffold whose money core is tested by simulation:

| Path | What it is |
|---|---|
| `src/money.ts` | Integer micro-dollars everywhere. No floats for money. |
| `src/policy/` | **The policy module.** Pure functions: `chooseProvider`, `verifyQuote` (rogue 402 defence), `planHoldIncrease`, `degradePlan`, `allocateReserve`, `splitFloat`, `shouldEscalate`, provider health and reputation. `catalog.ts` is the published price list (1¢/2¢/5¢ per paragraph models, 2¢ search, 3¢ data, plus `model-bargain`, the rogue provider). |
| `src/ledger/` | Ledger with the idempotency rule (payment written `pending` before money moves; one key per purchase; retries reuse the key). `MemoryStore` plus `SqliteStore` on built-in `node:sqlite`. |
| `src/payments/` | `HoldGateway` / `FloatGateway` interfaces; `MockAirwallex`, `MockMetal` (enforce the rules and record violations); `airwallex.ts` (real sandbox client, fields marked `VERIFY`); `metal.ts` (stub to wire). |
| `src/providers/` | Mock provider behaviour with rogue modes (`overquote`, `wrong_payee`, `junk`, `crash_after_pay`); in-process version and an HTTP x402-style server with a `/control` endpoint for demo buttons. |
| `src/engine/orchestrator.ts` | Runs N jobs over a shared float: hold → choose → verify quote → idempotent pay with retries and lookup → deliver → judge → premium check → reserve → hold increase or degrade → capture or cancel → withdraw float. |
| `src/sim/` | `npm run sim` runs 10,000 seeded random scenarios and checks 7 invariant families; currently **0 violations**. `npm run sim:sabotage` proves the checks catch 4 deliberately broken engines. `npm run demo` runs the scripted 3-job scenario and prints a reconciliation. |

Before changing anything, run `npm run typecheck && npm run sim && npm run sim:sabotage && npm run demo`. All four must stay green after every change you make.

---

## 4. Non-negotiable invariants (enforced in code, never in prompts)

1. **Capture ≤ hold, always.** Capture is exactly the job's spend, floored to the cent. A job that spent nothing gets its hold **cancelled**.
2. **Raise the hold before spending past it.** The order is: the customer approves, `increment_authorization` succeeds, and only then can the next payment go over the old hold. If the customer declines, doesn't answer within 30 s, or the issuer declines, the job degrades to the best answer within the current hold and is labelled `budget_limited`.
3. **Every hold ends captured or cancelled**, including for failed and crashed jobs (`finally` block plus a startup sweeper for holds left `authorized` in SQLite).
4. **Nothing is paid twice.** The ledger row is written before money moves, the idempotency key is unique per purchase, a retry resends the identical payload, and an ambiguous failure is resolved with `lookup()` before any new attempt.
5. **Never pay above list price or to an unregistered address.** Every 402 goes through `verifyQuote` against `catalog.ts`. On a violation: refuse, record the refusal, block the provider and reroute.
6. **The LLM never moves money.** Its tools are only `scoreAnswer(step, output) → 0..1` and `explainDecision(event) → string`. Prices, budgets, reserve, holds and provider choice belong to the policy module.
7. **The ledger reconciles exactly**: ledger paid = rail settled = Airwallex captured, per job and in total.

If any change makes `npm run sim` report a violation, the change is wrong. Fix the code, never the checker.

---

## 5. Build plan, in order, with acceptance criteria

### 5.1 Airwallex live in sandbox (Rahul): days 1–2
- Wire `AirwallexHoldGateway` (`src/payments/airwallex.ts`) against `https://api-demo.airwallex.com`: login, then create a PaymentIntent with `payment_method_options.card.authorization_type: "pre_auth"`, then confirm with `auto_capture: false`, then `increment_authorization`, `capture` and `cancel`.
- Resolve every `VERIFY` comment against the API reference and a real sandbox call. Key checks: does `increment_authorization.amount` take the **new total or the delta**, which card brands support it (Visa and Mastercard), the minimum capture amount, and the cancel body field names.
- Use deterministic `request_id`s so a retried call is deduped by Airwallex.
- Card entry on the dashboard uses **Airwallex Drop-in or Elements** with the intent's `client_secret`. No raw card data touches our server.
- **Done when:** `scripts/airwallex-smoke.ts` creates a hold, raises it, captures part of it and cancels a second hold, printing every intent id and status. Record the output in `docs/STATUS.md`.

### 5.2 Metal live on testnet: x402 payments (Rahul): days 1–3
- Pin `@metalntwx/metal-pay@0.3.4` and `@metalntwx/metal-agent@0.3.3`, and add `viem`.
- Implement `MetalFloatGateway` (`src/payments/metal.ts`): `deposit`, `pay`, `lookup`, `withdraw`, `balance`. Keep the contract documented in that file. `pay()` must be idempotent on the key (use the key as, or inside, the x402 nonce). Throw `TransientError` when you can't tell whether a payment settled. `lookup()` answers from chain or SDK state.
- Make the provider server (`src/providers/server.ts`) verify payment with the metal-pay x402 verifier or facilitator before delivering, instead of trusting the `X-PAYMENT` header.
- **Done when:** one job runs end to end with a live Airwallex hold, live x402 payments on Metal testnet (tx hashes shown) and a live capture.

### 5.3 Metal mandates as a second, on-chain lock (Rahul): days 3–4. This is our Metal Award angle.
Mirror every customer's hold on-chain so a bug in our code still can't overspend:
- When float is deposited for a job batch, create and bind a **mandate** on the agent account with:
  - **payee allowlist** = the registered `payTo` addresses from `catalog.ts`, so the rogue provider's `wrong_payee` 402 is refused by Metal too, not just by us
  - **per-payment cap** = the largest single step the policy allows
  - **budget** = the float allocated to the batch
- When a hold increase is approved, **replace** the mandate with the raised budget *after* Airwallex's increment succeeds.
- At job end, **revoke** the mandate.
- Show both locks on the dashboard: "Policy check ✓ · Metal mandate ✓".
- Add one demo moment where we disable our own `verifyQuote` with a demo-only flag and Metal's mandate still refuses the payment. Label it clearly as a deliberate test.
- **Done when:** the mandate's create, bind, replace and revoke tx hashes appear in the job receipt, and the defence-in-depth demo works live.

### 5.4 Clearing behind an interface, emulated and labelled (Rahul): days 4–5
- Define `ClearingPort`: `openDeposit(jobKey, amount)`, `signRunningTotal(jobKey, provider, cumulative)`, `closeEpoch()`, `settle(epoch)`, `withdraw(jobKey)`.
- Implement `ClearingEmulator` from Metal's documented rules: one deposit per job key; each payment is a **signed cumulative total** per (job, provider) using EIP-712 signatures with viem, where a later total supersedes an earlier one; providers redeem the latest total at epoch close; unused deposit is withdrawable only after the epoch closes.
- Note in the code why running totals fit our idempotency rule: resending the same signed total can't pay twice.
- Capture on Airwallex only after that job's clearing epoch has closed (a finality gate).
- Every emulated value carries `source: "simulated"` in the ledger and gets a SIMULATED badge in the UI. The engine selects `ClearingEmulator` or a future `MetalClearing` through config (`CLEARING_MODE=emulator|live`).
- Add the emulator to the simulation harness and add invariants: sum of redeemed totals = ledger paid; no total redeemed twice; deposit minus redeemed = withdrawn.
- **Done when:** `npm run sim` covers clearing and stays at 0 violations.

### 5.5 Agent intelligence (Kavisha): days 3–5
- `LlmJudge implements QualityJudge`: one typed tool call returning `{ score: number, reason: string }`, with low temperature and a small rubric per step kind. Cache by output hash. If the LLM errors, fall back to a neutral score of 0.7 so the money path never blocks on the LLM.
- `Explainer`: turns ledger events into one plain-English line for the dashboard feed. It only rephrases the `why` the policy module already wrote and never adds new claims.
- Real report content: model steps call a real LLM behind the mock-priced provider so the final report is readable, while pricing stays in `catalog.ts`.
- **Done when:** a job produces a coherent short research report, and every routing decision in the feed has a policy reason plus an LLM-phrased line.

### 5.6 Dashboard (Kavisha): days 5–8
Next.js (App Router) in `apps/dashboard`. The engine streams ledger events over Server-Sent Events. **Do not run a dev server inside a demo recording; use a production build.**
- **Three job cards:** customer, hold (with increment history), spent so far, current provider, step progress, status chip (`running`, `waiting for approval`, `budget-limited`, `done`), and LIVE / SIMULATED badges per rail.
- **Reasoning feed:** a time-ordered stream of decisions, refusals, blocks, reserve grants and premium checks.
- **Approval modal:** "Raise hold from $0.75 to $1.24?" with Approve / Decline and a 30 s countdown that resolves as timeout. Wire it to `PendingApprovals` in `src/engine/ports.ts`.
- **Demo control panel:** buttons for *Trigger overrun (job B ×4)*, *Slow down 1¢ model*, *Rogue provider: overquote / wrong payee / junk*, *Disable our quote check (mandate test)*. These call `/control` on the provider server and engine fault hooks.
- **Receipt per job:** every step with provider, list price, price paid, Metal tx hash (linked to the testnet explorer), clearing running total and policy reason. End with: captured, released, and savings versus premium-only.
- **Reconciliation panel:** ledger paid = rail settled = Airwallex captured, per job and in total, with a green check.
- **Proof badge:** read `sim-report.json` and display "10,000 simulated runs · 0 overcharges · 0 double payments · 0 orphaned holds · 0 rogue overpayments", plus a link to the sabotage results.
- Make it work at 1280 px and look clean on a projector: large numbers, few colours.

### 5.7 Tests (both): continuous
- `node:test` unit tests in `test/` for every exported policy function, covering boundaries (exact headroom, zero float, all providers slow, tie-breaks), `verifyQuote` (overquote, underquote allowed, wrong payee, wrong asset), the ledger idempotency conflict, and `SqliteStore` parity with `MemoryStore`.
- Adapter contract tests that run the same suite against `MockMetal` and `MetalFloatGateway`, and against `MockAirwallex` and the sandbox client, skipped unless env keys are present.
- CI script: `npm run typecheck && npm test && npm run sim && npm run sim:sabotage`.

### 5.8 Submission assets (Kavisha leads, Rahul reviews): days 9–12
- `README.md`: the one-paragraph pitch, an architecture diagram (Mermaid), how to run (mock mode needs no keys; live mode lists the env vars), a LIVE vs SIMULATED table, guardrails with links to code, and the sim proof.
- `docs/STATUS.md`: what is live, what is emulated and why (cite the track channel's guidance and the open clearing question), and known limitations.
- **3-minute demo video**, scripted:
  1. Three customers approve holds ($1.00 / $0.75 / $0.75) on a 1.50 USDZ float.
  2. Trigger the overrun and the slowdown; the agent reroutes, and the feed says why.
  3. The rogue provider overquotes: refused by the policy module, then blocked. Disable our check and the Metal mandate refuses it anyway.
  4. The reserve goes to the job closest to finishing; job B asks for a hold increase, the customer approves, the incremental auth succeeds, then spending continues.
  5. A second customer declines a hold increase and gets a budget-limited answer within the original hold.
  6. Capture, release, withdraw float; the reconciliation panel shows a green check; the proof badge appears.
- `.env.example` with every variable: `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `AIRWALLEX_BASE_URL`, `METAL_RPC_URL`, `METAL_PRIVATE_KEY`, `CLEARING_MODE`, `LLM_API_KEY`, `PROVIDERS_URL`.

---

## 6. Modes

- `MODE=mock` (default): every rail mocked, so it runs offline with no keys. This is what judges can run.
- `MODE=live`: live Airwallex sandbox, live Metal testnet x402 and mandates, clearing per `CLEARING_MODE`.
- The UI header always shows the active mode, and every rail shows its own LIVE / SIMULATED badge.

---

## 7. Don'ts

- Don't put prices, budgets, caps or provider choice in an LLM prompt.
- Don't use floating point for money, and don't round in the customer's disfavour.
- Don't present emulated clearing as live, anywhere: UI, README, video or code comments.
- Don't upgrade Metal packages past the pinned versions without re-running everything and noting it in STATUS.md.
- Don't store card data; use Airwallex Drop-in or Elements only.
- Don't commit secrets. `.env` goes in `.gitignore`.
- Don't weaken a sim invariant to make a run pass.

---

## 8. Definition of done (by 12 November, leaving one buffer day)

- [ ] `npm run typecheck && npm test && npm run sim && npm run sim:sabotage` is green.
- [ ] Mock-mode demo runs offline with one command.
- [ ] Live mode: real Airwallex sandbox holds, increments, captures and cancels; real Metal testnet x402 payments and mandate lifecycle, with tx hashes in receipts.
- [ ] Clearing emulator covered by the sim, labelled SIMULATED, and swappable via config.
- [ ] Dashboard shows all six demo beats with the reconciliation and the proof badge.
- [ ] README, STATUS.md, `.env.example` and the 3-minute video are done.

## 9. Day plan

| Days | Rahul | Kavisha |
|---|---|---|
| 1–2 (Nov 1–2) | Airwallex sandbox smoke test; Metal 0.3.3 account and funding | Unit tests for the policy module; provider server polish |
| 3–4 (Nov 3–4) | Metal x402 live, mandates live | LLM judge and explainer, real report content |
| 5–6 (Nov 5–6) | Clearing port, emulator and sim invariants | Dashboard skeleton, SSE, job cards, feed |
| 7–8 (Nov 7–8) | Startup sweeper, contract tests, live end-to-end run | Approval modal, control panel, receipts, reconciliation |
| 9–10 (Nov 9–10) | Hardening, STATUS.md | README, diagram, video script |
| 11–12 (Nov 11–12) | Full rehearsal on live mode | Record the video, final polish |
| 13 (Nov 13) | Submit early | Submit early |

Work in small commits. After each section in §5, run the full check, update `docs/STATUS.md`, and stop to summarise what changed and what is next.
