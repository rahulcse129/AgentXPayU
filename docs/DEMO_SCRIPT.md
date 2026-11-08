# Demo video script

Target length: **about 3½ minutes** (hard cap 4). It's one live dashboard run with every buildable rail live, edited to
cut the waiting. The narration is in quotes; say it in your own words, but keep the claims exactly as written.
Each claim is backed by [the all-live run](live-runs/2026-11-09-dashboard-all-live-run.md).

## Before you record

1. **Clock:** synced, because Metal refuses payments signed with a skewed clock. On Windows, run
   `w32tm /resync /force` from an admin prompt.
2. **Build and start:**
   - `npm run dashboard:build` (once)
   - terminal 1: `APPROVAL_TIMEOUT_MS=60000 npm run engine:live-full`. Check that it prints `card holds: LIVE`
     and `Metal rail: LIVE through a Metal mandate`.
   - terminal 2: `npm run dashboard`
3. **Browser:** open http://localhost:3000 at 1920×1080, zoomed to 110–125% so the text is readable.
   Close other tabs.
4. **Second tab:** the Airwallex sandbox dashboard, logged in, on **Payments → Payment intents**. You'll show
   one captured intent at the end.
5. **Hide secrets:** keep `.env` and terminal history with keys off screen. The sandbox test card number is
   public and fine to show.
6. **Practice once off camera** with `npm run engine:offline`; the flow is the same, with no cards and no
   testnet spend.

A live run takes about 5–6 minutes of real time and spends about 1.5 testnet USDZ. Record it all, then cut.

## Shot list

The dashboard has four views in the left sidebar: **Overview** (job cards, recent activity, fault buttons,
rails), **Activity** (the full feed with filters, plus the fault buttons), **Settlement** (reconciliation and
receipts) and **Proof**. **Run scripted demo** is at the top right of every view.

### 1. Hook (0:00–0:15)

**Screen:** the Overview before the run. The banner at the top names the live rails, and the sidebar shows
**Mode: MIXED**.

> "AI agents are starting to spend money for people. Margin is an agent that buys inference for research jobs,
> and it makes two promises it can't break: never charge a customer more than they agreed to, and never pay a
> provider more than its published price."

### 2. The setup (0:15–0:30)

**Screen:** scroll down the Overview to the **Rails** table: Airwallex holds LIVE, Metal payments LIVE, Metal
mandate LIVE, clearing SIMULATED.

> "Three customers each want a research report. Card holds are live in the Airwallex sandbox, and providers
> are paid live on Metal testnet through a mandate. Clearing is simulated, because it isn't open on testnet
> yet, and it's labelled that way everywhere."

### 3. The customer approves a hold (0:30–0:55)

**Action:** press **Run scripted demo**. The Drop-in form appears for Acme Research ($1.00). Wait for the form
to finish loading, then enter `4035 5010 0000 0008`, `12/30`, CVC `123` and a name, and press Pay.

> "Each customer sets their budget as a card pre-authorization, entered in Airwallex's own Drop-in form, so
> card details never touch our server. This is a hold, not a charge."

**Edit:** show A in full, then speed up or cut B and C's card entry. Keep the feed line
"card hold authorized" visible for each one.

### 4. Sourcing (0:55–1:25)

**Screen:** on the Overview, the job cards fill up and **Recent activity** shows lines like
"buy from model-std for $0.24, the cheapest tier-2 option that fits". Then switch to **Activity** in the
sidebar: the full feed and the fault buttons sit side by side there, which suits shots 4–7.

**Action (off-narration):** as soon as the feed shows "⚠ model-lite slows to ~2.5s under load", press
**Trigger overrun (job B ×4)** in the **Inject faults** panel. That guarantees B asks to raise its hold later; without it, B sometimes
finishes within $0.75. Pressing earlier does nothing extra: before that line, the press merges into the
scripted overrun.

> "For every step, Margin picks the cheapest provider that fits what's left of that job's budget, and pays per
> request in USDZ on Metal. Each provider checks the payment on chain before it delivers. When the cheap model
> slows down, it routes around it."

### 5. Lock one: our policy check (1:25–1:40)

**Screen:** the red feed line "model-bargain blocked (quoted $0.42, list price $0.14)". Click the
**Refusals** filter above the feed to show only the blocked payments.

> "A rogue provider asks for three times its list price. Our policy check refuses it before a cent moves."

### 6. Lock two: the Metal mandate (1:40–2:05)

**Action:** right after that refusal, press **Disable our quote check (mandate test)** at the bottom of the
**Inject faults** panel.

**Screen:** a few seconds later, the feed shows "Metal mandate refused … mandate_payee_not_listed … refusal
recorded on chain", then "our quote check is back on".

> "What if our own check had a bug? Let's turn it off. Now the rogue asks to be paid at an address that isn't
> registered, and the Metal mandate refuses it on its own. That refusal is recorded on chain. Two independent
> locks."

### 7. Asking before spending more (2:05–2:25)

**Action:** the approval prompt for B appears ("raise hold $0.75 → $…"). Press **Approve $…**. Then C's prompt
appears; press **Decline**.

> "Birch Capital's job ran over, so Margin asks before spending past the hold. They approve, and that's a
> live incremental authorization at Airwallex. Cobalt Labs declines, so Margin trims C's plan to fit the
> budget instead of overspending."

### 8. Settle and reconcile (2:25–2:50)

**Screen:** click **Settlement** in the sidebar (or **View settlement →** in the green banner on the
Overview). Point at "✓ Every dollar accounted for", the matching columns
(Ledger paid = Settled on chain = Clearing = Airwallex captured), and the Locks row with the mandate's bind and
revoke links.

> "At the end, each hold is captured for exactly what was spent, and the rest is released. Then Margin
> reconciles: the ledger, every payment re-read from the chain, and every hold re-read from Airwallex all match
> to the cent. Zero violations."

### 9. The proof is real (2:50–3:05)

**Action:** scroll down Settlement to the receipts. Click one Metal tx link, and the testnet explorer opens on that transaction. Then
switch to the Airwallex tab and open that job's PaymentIntent: status **Succeeded**, with a captured amount
below the authorized amount.

> "These are real transactions: here's one on the Metal explorer, and here's the hold in Airwallex, captured
> for less than was authorized."

### 10. Close (3:05–3:20)

**Screen:** click **Proof** in the sidebar: the 10,000-run result and the sabotage table, every broken engine
CAUGHT. Optionally cut to a terminal running `npm run check` and show its final lines.

> "Behind it, 10,000 simulated runs with rogue providers, crashes and declines show 0 overcharges and 0 double
> payments. Five deliberately broken engines are each caught. Margin: an agent you can trust with a card."

## If something goes wrong while recording

| Symptom | Fix |
|---|---|
| The card number field stays empty after typing | Drop-in hadn't finished loading. Click the field again and retype |
| "Card number is invalid" | The field kept stray digits. Select all, delete, and retype |
| B never asks to raise its hold | Press **Trigger overrun (job B ×4)** after the "model-lite slows" line, not before; run again |
| The run fails with "live rail not ready" | Clock skew or a bad RPC. Resync the clock and restart the engine |
| The engine crashed mid-run | Restart it; the startup sweeper settles the open holds. Then run again |
| An approval prompt timed out | `APPROVAL_TIMEOUT_MS=60000` gives you 60 s; set it before starting the engine |

## Optional: with the LLM narrating

Run `npm run engine -- --live-airwallex --live-mandate` (it needs `GEMINI_API_KEY` in `.env`). Feed lines
are rephrased, and each receipt gets a short report. It adds about 17 LLM calls per run. If the free tier
runs out, the engine falls back to template lines on its own, so the run still works.
