# Submission text (paste-ready)

Updated 2026-11-09. Every claim here is backed by a run in [live-runs/](live-runs/) or a test; keep it that way if you edit.

## Project name

Margin

## Tagline (one line)

An AI agent that buys inference for research jobs: it holds each customer's budget on their card, pays providers per request on Metal, and charges only what it spent.

## Short description (about 50 words)

Margin runs AI research jobs and buys every paid step from whichever provider fits what's left of the budget. Each customer approves a card hold in Airwallex Drop-in. Margin pays providers per request in USDZ on Metal, through a mandate. It asks before spending past a hold, and captures exactly what it spent.

## Full description

**The problem.** An agent that spends money for customers needs two promises it can't break. It never charges a customer more than they agreed to, and it never pays a provider more than its published price. Both have to hold when providers misbehave, prices change and processes crash.

**What Margin does.**
- **The hold.** Each customer approves a spending cap as an Airwallex card pre-authorization. The card is entered in Airwallex Drop-in, so card data never touches our server.
- **Buying.** Margin plans the job's steps and buys each one, whether a model call, a web search or a data lookup, from the cheapest provider that fits the remaining budget. It pays per request with x402 in USDZ on Metal testnet.
- **When a job runs over.** Margin asks the customer to raise the hold, which is a live Airwallex incremental authorization. If the customer declines, it degrades the plan instead.
- **At the end.** It captures exactly what was spent and releases the rest.

**Two locks on every payment.**
- **Our policy check.** It refuses any quote above list price or to an unregistered address.
- **A Metal mandate.** The payment goes through a mandate with a payee allowlist, a per-payment cap and a budget. In the demo we switch our own check off for one attempt. A rogue provider asks to be paid at an unregistered address, and the mandate refuses it on its own, with the refusal recorded on chain.

**It reconciles exactly.** After every run, the ledger is checked against each payment re-read from the chain and each card hold re-read from Airwallex.

**Proven live (2026-11-09).** One dashboard run had Airwallex sandbox holds, Metal x402 payments and a Metal mandate all live together. It reconciled to the cent, with 0 violations:
- **The money:** $1.47 matched across the ledger, the chain and Airwallex.
- **The mandate:** bound and revoked on chain.
- **The rogue:** refused on chain.

**Proven at scale.**
- **Simulation.** 10,000 seeded random runs check 12 families of invariants. They include overruns, slowdowns, rogue providers, dropped acknowledgements, issuer declines and customer timeouts. Result: 0 overcharges, 0 double payments, 0 orphaned holds, 0 rogue overpayments.
- **Sabotage.** Five deliberately broken engines run against the same checks, and each one is caught.

## How it's built

- **Engine:** TypeScript on Node 22. The engine is an orchestrator around a pure policy module.
- **Ledger:** SQLite. Every payment gets its ledger row before money moves, under one key per purchase. On chain, the ERC-3009 nonce comes from that key, so nothing is paid twice.
- **Airwallex:** PaymentIntents with pre-auth and manual capture. Each hold is confirmed in Drop-in (`@airwallex/components-sdk`); increment, capture and cancel run server-side. Every call uses a deterministic `request_id` and retries through network loss.
- **Metal:** x402 v2 `exact` payments in USDZ on testnet through Metal's facilitator. Mandates come from `@metalntwx/metal-agent`. Providers verify each payment on chain before they deliver.
- **Crash safety:** a startup sweeper settles any card hold a crashed run left open. It captures what was spent, or cancels. It was tested live by killing a run mid-flight.
- **LLM (Gemini or Claude):** scores provider output and writes the narration. It never moves money.
- **Dashboard:** Next.js. Every rail, column and receipt is labelled LIVE or SIMULATED.

## Live vs simulated

| Component | State |
|---|---|
| Airwallex card holds | LIVE, sandbox (Drop-in, increment, capture, cancel) |
| Metal x402 payments | LIVE, testnet |
| Metal mandates | LIVE, testnet |
| Metal clearing | SIMULATED: Margin uses its emulator, which enforces the same finality rule; Metal's live testnet clearing isn't wired in yet |

## Challenges

- **Airwallex region.** Card acceptance wasn't available for our first sandbox's region. Airwallex confirmed it, and we moved to a sandbox in a supported region.
- **Card data.** Server-side card confirmation is reserved for merchants approved to handle raw card data. So customers enter their card in Airwallex Drop-in, which is also the right design.
- **Network loss.** A live run lost the network and left two holds open. We made every Airwallex call retry safely, and the startup sweeper now settles crashed runs on its own.
- **Package versions.** `@x402` package versions clashed with the Metal SDK. We pinned them to the versions it was built against.

## Links

- Code: https://github.com/rahulcse129/AgentXPayU
- Live-run evidence: https://github.com/rahulcse129/AgentXPayU/tree/main/docs/live-runs
- Demo video: *(add)*

## Team

Rahul Pal (payments and backend) · Kavisha Sharma (agent and product)
