<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="Margin: an AI agent that spends inside the customer's card hold. Airwallex holds and Metal x402 with mandate are live; Metal clearing is simulated." src="docs/assets/hero-light.svg" width="100%">
</picture>

<p align="center">
  <img alt="Airwallex holds: live, sandbox" src="https://img.shields.io/badge/Airwallex_holds-LIVE_·_sandbox-16794a?style=flat-square">
  <img alt="Metal x402 and mandate: live, testnet" src="https://img.shields.io/badge/Metal_x402_%2B_mandate-LIVE_·_testnet-16794a?style=flat-square">
  <img alt="Metal clearing: simulated" src="https://img.shields.io/badge/Metal_clearing-SIMULATED-6b4fbb?style=flat-square">
  <img alt="158 tests passing" src="https://img.shields.io/badge/tests-158_passing-5b3df5?style=flat-square">
  <img alt="10,000 simulated runs, 0 overcharges" src="https://img.shields.io/badge/simulation-10%2C000_runs_·_0_overcharges-5b3df5?style=flat-square">
  <img alt="TypeScript on Node 22" src="https://img.shields.io/badge/TypeScript-Node_22-3178c6?style=flat-square">
</p>

<p align="center">
  <a href="#for-judges"><b>For judges</b></a> ·
  <a href="#see-it"><b>Screenshots</b></a> ·
  <a href="#how-a-job-flows"><b>How it works</b></a> ·
  <a href="#architecture"><b>Architecture</b></a> ·
  <a href="docs/live-runs/2026-11-09-dashboard-all-live-run.md"><b>Live-run evidence</b></a> ·
  <b>Demo video:</b> coming soon
</p>

**Margin is an inference sourcing agent.** It runs AI research jobs for customers and buys every paid step (model calls, web search, data lookups) from whichever provider best fits what's left of that job's budget. It makes two promises it can't break:

> **It never charges a customer more than they agreed to, and it never pays a provider more than its published price.**

Airwallex Agentic Banking Hackathon, Starter Kit 12 ("Inference Sourcing Agent").

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/stats-dark.svg">
  <img alt="$1.47 matched to the cent in the all-live run; 0 violations; 10,000 simulated runs with 0 overcharges and 0 double payments; 5 of 5 sabotaged engines caught" src="docs/assets/stats-light.svg" width="100%">
</picture>

## Why this matters

Agents don't just need payment rails; they need **rails with limits**. Margin keeps every limit outside the model:

| The limit | What enforces it |
|---|---|
| The customer's budget | An **Airwallex card pre-authorization**, entered in Airwallex Drop-in. Card data never touches our server. |
| Spending more than the budget | An **incremental authorization** the customer must approve. If they decline, Margin trims the plan instead. |
| Overpaying, or paying the wrong party | **Two locks**: our policy code, then a **Metal mandate** that refuses on its own, on chain. |
| Charging for unused budget | **Capture exactly what was spent**, release the rest, and reconcile against every rail to the cent. |

The AI model scores answers and writes narration. It never chooses an amount or moves money.

## See it

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-overview-dark.png">
        <img alt="Overview: three customers, their card holds, spend and settlement" src="docs/assets/screen-overview-light.png">
      </picture>
      <p><b>Overview.</b> Three customers, three card holds, one shared float. Birch Capital's hold was raised after the customer approved.</p>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screen-settlement-dark.png">
        <img alt="Settlement: the reconciliation table matching ledger, rail, clearing and captured amounts" src="docs/assets/screen-settlement-light.png">
      </picture>
      <p><b>Settlement.</b> Ledger = rail = clearing = Airwallex captured, per job and in total, with both locks shown.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img alt="Activity: every decision and refusal with its reason, filterable" src="docs/assets/screen-activity-light.png">
      <p><b>Activity.</b> Every decision with its policy reason, filterable by kind and job, next to the fault controls.</p>
    </td>
    <td width="50%">
      <img alt="Proof: 10,000 simulated runs and five sabotaged engines, all caught" src="docs/assets/screen-proof-light.png">
      <p><b>Proof.</b> The 10,000-run simulation and five deliberately broken engines, each caught.</p>
    </td>
  </tr>
</table>

<sub>These screenshots come from the offline engine, so every rail shows SIM. With a live engine the same views show LIVE badges, explorer links and Airwallex PaymentIntent IDs: see <a href="docs/live-runs/2026-11-09-dashboard-all-live-run.md">the all-live run</a>.</sub>

## How a job flows

1. **The customer sets a budget.** Margin creates an Airwallex PaymentIntent. The customer confirms it in Drop-in as a pre-authorization: a hold, not a charge.
2. **The agent buys.** For each step it picks the cheapest provider that fits both the hold's headroom and the job's share of the float, and asks for a quote over x402.
3. **Lock 1, our policy.** The quote must match the published price list and the registered payee. A ledger row is written before any money moves.
4. **Lock 2, the Metal mandate.** The payment is pulled under a mandate with a payee allowlist, a per-payment cap and a budget. The account enforces it on chain.
5. **Asking for more.** If a job will run over, the customer approves an incremental authorization, or declines and the plan is trimmed to fit.
6. **Settling.** Each hold is captured for exactly what was spent and the rest released. The ledger is reconciled against the chain and Airwallex.

<details>
<summary><b>The same flow as a sequence diagram</b></summary>

```mermaid
sequenceDiagram
  autonumber
  actor C as Customer
  participant D as Dashboard + Drop-in
  participant E as Margin engine
  participant A as Airwallex
  participant M as Metal mandate
  participant P as Provider

  E->>A: Create PaymentIntent for the job's budget
  E-->>D: Card required
  C->>D: Enters card in Drop-in
  D->>A: Confirm as pre-auth (card data never reaches the engine)
  E->>A: Poll until REQUIRES_CAPTURE
  Note over E: Hold placed. The job may spend up to it, never more.

  loop Each step of the job
    E->>P: Ask for a quote
    P-->>E: 402 Payment Required: price and pay-to address
    E->>E: Lock 1, policy: list price, registered payee, fits the budget
    E->>E: Ledger row written before any money moves
    E->>M: Pay under the mandate
    M->>M: Lock 2: payee on the list, under the cap and budget
    M->>P: USDZ transfer on Metal testnet
    P->>P: Verify the payment on chain
    P-->>E: Result, scored by the quality judge (LLM when enabled)
  end

  opt The job needs more than the hold
    E-->>D: Ask the customer to raise the hold
    alt Customer approves
      C->>D: Approve
      E->>A: Incremental authorization
      E->>M: Raise the mandate budget by the same amount
    else Customer declines or times out
      E->>E: Trim the plan to fit the hold
    end
  end

  E->>A: Capture exactly what was spent, release the rest
  E->>E: Reconcile ledger = rail = clearing = Airwallex captured
  E-->>D: Reconciliation and receipts
```

</details>

### Two locks on every payment

| | Lock 1: our policy | Lock 2: the Metal mandate |
|---|---|---|
| **Runs in** | Margin's code, before paying | The owner's MetalAccount, on chain |
| **Refuses** | A quote above list price, a wrong payee, a wrong asset | A payee not on the allowlist, a payment over the cap, spend over the budget |
| **Proven by** | A rogue provider asking 3× its list price is refused before a cent moves | With our check switched off, the mandate still refused the rogue's unregistered address, [recorded on chain](https://testnet.metalntwx.com/tx/0x9be536d3d5d173aa2c0660fa477926c2cf0ffc7b359b3249861b1542e172adb5) |

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <img alt="Margin in four layers: customer and dashboard, the Margin engine, payment rails, providers" src="docs/assets/architecture-light.svg" width="100%">
</picture>

Four layers, top to bottom. The dashed connectors are the flows:

- **Customer &amp; dashboard.** The dashboard sends commands to the orchestrator and streams every event back. **Airwallex Drop-in** sends card data straight to Airwallex, past our engine.
- **Margin engine.** The orchestrator plans and buys; the **policy** module (pure functions) decides every payment; the **ledger** (SQLite) records each one before money moves. The **LLM judge** only scores. The **sweeper** settles holds a crash left open.
- **Payment rails.** The orchestrator places, raises and captures holds on **Airwallex**. Approved payments go through the **Metal mandate** as **USDZ over x402**. **Clearing** runs on Margin's emulator for now.
- **Providers.** They are paid per request and check each payment on chain before delivering. The **rogue** provider exists to prove the locks.

<details>
<summary><b>Where each part lives in the code</b></summary>

| Part | Code |
|---|---|
| Orchestrator: plans each job, buys steps, asks for increases, settles | [src/engine/](src/engine/) |
| Policy: quote check, budget, hold-increase planning, as pure functions | [src/policy/](src/policy/) |
| Ledger: idempotent payments and holds in SQLite; startup sweeper | [src/ledger/](src/ledger/) |
| Airwallex holds, Drop-in wait, Metal x402 payments, mandates | [src/payments/](src/payments/) |
| Providers: x402 servers that verify each payment on chain | [src/providers/](src/providers/) |
| Clearing emulator (signed running totals, finality) | [src/clearing/](src/clearing/) |
| LLM judge, feed narration, report text | [src/agent/](src/agent/) |
| Engine server and crash recovery | [src/server/](src/server/) |
| Dashboard | [apps/dashboard/](apps/dashboard/) |
| 10,000-run simulation and sabotage proof | [src/sim/](src/sim/) |

</details>

## For judges

**What's live.** Card holds run in the Airwallex sandbox, with the card entered in Airwallex Drop-in. Provider payments are x402 on Metal testnet, through a Metal mandate. All of these ran together in one dashboard run that reconciled to the cent: $1.47 matched across the ledger, the chain and Airwallex, with 0 violations. [Read the run](docs/live-runs/2026-11-09-dashboard-all-live-run.md); every transaction is linked.

**What's simulated, and labelled so on screen.** Metal clearing: Margin runs it through an emulator that follows Metal's clearing rules. Metal's live testnet clearing (the `bajillion` x402 scheme) is available, and wiring it into Margin is the next step. Without keys, every other rail falls back to a simulation with the same rules.

**Quickest look, no keys needed** (about 3 minutes, plus a 1-minute install):

```bash
npm install
npm run check     # typecheck, 158 unit tests, 10,000-run simulation, sabotage proof
npm run demo      # scripted 3-customer scenario in the terminal, with narration and reconciliation
```

**What to look for in a run:**

| Moment | What it shows |
|---|---|
| A customer approves a card hold in Drop-in | The spending cap is a real Airwallex pre-authorization; card data never touches our server |
| The agent picks the cheapest provider that fits the job's budget | Sourcing; the dashboard feed gives the policy reason for each choice |
| A rogue provider asks for 3× its list price | Our quote check refuses it before anything is paid |
| Our check is switched off, and the rogue asks to be paid at an unregistered address | The Metal mandate refuses it on its own, and the refusal is recorded on chain |
| A job runs over, and the customer is asked to raise the hold | B approves (a live Airwallex incremental authorization); C declines and the plan degrades instead |
| The run ends | Each hold is captured for exactly what was spent and the rest released. The reconciliation table checks the ledger against the chain and Airwallex |

**Evidence from live runs:** [docs/live-runs/](docs/live-runs/). Full state, with what is and isn't done: [docs/STATUS.md](docs/STATUS.md).

## Run the dashboard

Two processes, both production builds:

```bash
npm run dashboard:install && npm run dashboard:build   # once
npm run engine:offline                                  # terminal 1: engine on :4100, every rail simulated
npm run dashboard                                       # terminal 2: open http://localhost:3000
```

Press **Run scripted demo**, then approve B's hold increase and decline C's; that hits every beat.

<details>
<summary><b>Live engines, and scripts against the live rails</b></summary>

Swap `engine:offline` for a live engine (keys in `.env`, see [.env.example](.env.example)):

| Command | Live rails | Needs |
|---|---|---|
| `npm run engine:live-full` | Airwallex holds + Metal payments through a mandate | `AIRWALLEX_CLIENT_ID`, `AIRWALLEX_API_KEY`, `METAL_RPC_URL`, `METAL_OWNER_ACCOUNT`, `METAL_OWNER_KEY_FILE` |
| `npm run engine:live-cards` | Airwallex holds | the two Airwallex keys |
| `npm run engine:live-mandate` | Metal payments through a mandate | the Metal owner variables |
| `npm run engine:live` | Metal x402 from the agent wallet | `METAL_PRIVATE_KEY`, `METAL_RPC_URL` |

**Live cards:** a Drop-in form opens for each customer. Use Airwallex's sandbox test card `4035 5010 0000 0008`, any future expiry and any CVC. Every receipt links its transaction on the testnet explorer and its Airwallex PaymentIntent. A scripted run spends about 1.5 testnet USDZ. Metal needs the system clock in sync.

The **Disable our quote check (mandate test)** button turns our check off for one attempt, so you can watch the mandate refuse the rogue on its own.

`npm run engine` uses the LLM key in `.env` (Gemini or Claude) for the quality judge, the feed lines and the report text. Add `--no-llm`, or use the commands above, to leave it off.

```bash
npm run live:x402        # one job, real x402 payments, every tx re-read from chain (at most 0.25 USDZ)
npm run live:mandate     # Metal mandate lifecycle: bind, pay, refusals recorded on chain, raise, revoke
npm run test:live        # adapter contract tests against the real Metal gateway (~0.03 USDZ)
```

Node ≥ 22.13.

</details>

## LIVE vs SIMULATED

| Component | Live | Offline / without keys |
|---|---|---|
| Airwallex card holds | **LIVE, sandbox.** Card entered in Drop-in; increment, capture and cancel are real; reconciliation reads each intent back | `MockAirwallex`, same rules |
| Metal x402 payments | **LIVE, testnet.** Providers verify each payment on chain before delivering | `MockMetal` |
| Metal mandates | **LIVE, testnet.** Refusals recorded on chain | Simulated mandate, same checks |
| Metal clearing | SIMULATED in every mode: Margin uses its emulator; Metal's live testnet clearing isn't wired in yet | `ClearingEmulator` |
| LLM (judge, feed, report) | Gemini (`gemini-3.5-flash-lite`) or Claude | Template text |

The dashboard shows MODE and a LIVE or SIM badge on every rail, column and receipt.

## Guardrails, in code

| Rule | Where |
|---|---|
| Capture ≤ hold, exactly what was spent, floored to the cent; zero spend cancels | [orchestrator.ts `settleHold`](src/engine/orchestrator.ts) |
| Raise the hold before spending past it | [policy.ts `planHoldIncrease`](src/policy/policy.ts), [orchestrator.ts `askForMore`](src/engine/orchestrator.ts) |
| Nothing paid twice: ledger row before money moves, one key per purchase; on chain the EIP-3009 nonce comes from that key; Airwallex calls use deterministic `request_id`s | [ledger.ts `beginPayment`](src/ledger/ledger.ts), [metal.ts `nonceFor`](src/payments/metal.ts), [airwallex.ts](src/payments/airwallex.ts) |
| Providers deliver only after reading the payment on chain | [verify.ts `ChainPaymentVerifier`](src/providers/verify.ts) |
| Never pay above list price or to an unregistered address, checked twice | [policy.ts `verifyQuote`](src/policy/policy.ts), then the Metal mandate ([mandate-manager.ts](src/payments/mandate-manager.ts)) |
| The LLM never moves money | [ports.ts `QualityJudge`](src/engine/ports.ts) |
| Capture only after clearing is final | [orchestrator.ts `finalizeClearing`](src/engine/orchestrator.ts) |
| Every hold ends captured or cancelled, even after a crash: the startup sweeper settles holds a crashed run left open | [sweeper.ts](src/ledger/sweeper.ts), [recover.ts](src/server/recover.ts) |
| Card data never touches our server | [CardModal.tsx](apps/dashboard/components/CardModal.tsx) (Airwallex Drop-in), [airwallex-browser.ts](src/payments/airwallex-browser.ts) |

## Proof

`npm run sim` runs 10,000 seeded random scenarios: overruns, slowdowns, rogue providers, dropped acknowledgements, issuer declines, and customer declines and timeouts. It checks 12 families of invariants, including 5 for the simulated clearing layer:

> 10,000 simulated runs · 0 overcharges · 0 double payments · 0 orphaned holds · 0 rogue overpayments

`npm run sim:sabotage` runs the same checks against 5 deliberately broken engines and shows each one is caught. The breakages are a skipped quote check, a fresh key on retry, an ignored hold, a full-hold capture, and a capture before clearing is final.

## Team

**Rahul Pal** (payments and backend) · **Kavisha Sharma** (agent and product)
