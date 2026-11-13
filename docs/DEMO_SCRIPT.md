# Demo video script

For ABH Demo Day, following the organisers' recording guidelines: **under 4 minutes (target 3:20)**, the product
on screen within 30 seconds, one use case end to end, the real product (no slides), and the presenter's face in
a camera bubble. Send V1 to Dan Kim on Slack before the session.

**The use case:** a business runs AI research jobs for three customers, each paid for on the customer's own card.
**Before:** an AI agent holding a card can be talked into overpaying, or paying the wrong party.
**After:** every customer's budget is a card hold the agent can't exceed, every payment passes two locks, and the
customer is charged exactly what was spent.

Say it in your own words; don't read it word for word. Keep the numbers and claims as written: each is backed by
[the all-live run](live-runs/2026-11-09-dashboard-all-live-run.md).

## Who says what

| Part | Time | Presenter | Screen |
|---|---|---|---|
| The problem | 0:00–0:25 | Kavisha | Dashboard Overview, before the run |
| The demo | 0:25–2:40 | Rahul | Dashboard, live run |
| The outcome | 2:40–3:05 | Kavisha | Settlement, then Proof |
| What's next | 3:05–3:20 | Kavisha | Proof, or the GitHub README |

Plan the two handoffs ("Rahul, show them." / "Kavisha, what did that get us?"). If you record separately, cut on
those lines.

## Before you record

1. **Recording tool:** Screen Studio or Tella, at 1080p or higher, with your face in a small camera bubble. Camera
   at eye level, quiet room, natural light, headphones or a decent microphone.
2. **Clock:** synced, because Metal refuses payments signed with a skewed clock. On Windows, run
   `w32tm /resync /force` from an admin prompt.
3. **Build and start:**
   - `npm run dashboard:build` (once)
   - terminal 1: `APPROVAL_TIMEOUT_MS=60000 npm run engine:live-full`. Check that it prints `card holds: LIVE` and
     `Metal rail: LIVE through a Metal mandate`.
   - terminal 2: `npm run dashboard`
4. **Browser:** http://localhost:3000, full screen, zoomed to 125% so text reads in the video. Close every other
   tab except one: the Airwallex sandbox on **Payments → Payment intents**.
5. **Hide secrets:** keep `.env` and terminals with keys off screen. The sandbox test card number is public.
6. **Rehearse** once with `npm run engine:offline` (no cards, no testnet spend), timing each part.

**Or record against the deployed site.** Skip steps 2–3:
- Set the GitHub variable `MARGIN_ENGINE_SCRIPT=engine:live-full` and re-run the **Deploy to AWS** workflow.
- For a longer approval window, add `APPROVAL_TIMEOUT_MS=60000` to `.env` and run `node deploy/push-secrets.mjs --apply` before deploying.
- Open https://margin.rahulsbuild.tech, sign in, then follow step 4 with that URL.
- Show the address bar once, so viewers see it's the hosted site.
- Switch back to `engine:offline` afterwards.

A live run takes 5–6 minutes of real time. Record it all, then cut the waiting (card entry for B and C, the
providers' delays). Cuts are fine; the guidelines ask for clarity, not one take.

## The script

### 1. The problem (0:00–0:25), Kavisha, on camera over the Overview

> "Hi, I'm Kavisha, and this is Rahul. AI agents are starting to spend money for businesses, and an agent
> holding a card can be talked into overpaying, or paying the wrong party. We built Margin: an agent that buys
> AI work for customers, where the money limits live in the card and the payment rail, not in the model.
> Rahul, show them."

### 2. The demo (0:25–2:40), Rahul

**0:25 · A customer sets a budget.** Press **Run scripted demo**. The Airwallex Drop-in form opens for Acme
Research's $1.00. Enter `4035 5010 0000 0008`, `12/30`, CVC `123`, a name, and press Pay. (Wait for the form to
finish loading before typing.)

> "Let me show you. Three customers each want a research report. Each one approves a budget on their card in
> Airwallex's own checkout form. It's a hold, not a charge, and card details never touch our server."

**Edit:** cut B's and C's card entry; keep the three "card hold authorized" lines in view.

**0:55 · The agent buys.** Click **Activity** in the sidebar.

> "Now Margin works. For every step it picks the cheapest provider that fits what's left of that job's budget,
> and pays per request in USDZ on Metal. Every line here is a decision and its reason."

As soon as the feed shows "⚠ model-lite slows to ~2.5s under load", press **Trigger overrun (job B ×4)** in
**Inject faults** (off narration). Before that line, the press does nothing extra.

**1:15 · Lock one.** Click the **Refusals** filter.

> "A rogue provider asks for three times its list price. Our policy code refuses it before a cent moves."

**1:30 · Lock two.** Press **Disable our quote check (mandate test)**.

> "But what if our own code had a bug? I'll turn our check off. Now the rogue asks to be paid at an address
> that isn't on the list, and the Metal mandate refuses it on its own, recorded on chain. Two independent
> locks."

**1:55 · Asking before spending more.** B's prompt appears; press **Approve**. C's appears; press **Decline**.

> "Birch Capital's job ran over, so Margin asks before going past the hold. They approve: that's a live
> incremental authorization at Airwallex. Cobalt Labs declines, so Margin trims their report to fit instead of
> overspending."

**2:20 · Settled.** Click **Settlement**. Then switch to the Airwallex tab and open one of the run's intents:
**Succeeded**, captured less than authorized. Switch back.

> "At the end, each card is charged exactly what was spent, and the rest is released. Here's the same hold in
> Airwallex. Kavisha?"

### 3. The outcome (2:40–3:05), Kavisha, over Settlement then Proof

Point at "✓ Every dollar accounted for" and the matching columns, then click **Proof**.

> "So what changed? The agent never held the purse strings. In this live run, our ledger, the blockchain and
> Airwallex all matched to the cent, with zero violations. And it's not one lucky run: in 10,000 simulated
> runs with rogue providers and declines, there were zero overcharges and zero double payments."

### 4. What's next (3:05–3:20), Kavisha

> "Next, we'll wire in Metal's live testnet clearing, and add staged captures for long jobs. The code is on
> GitHub at rahulcse129/AgentXPayU, and runs without any keys. Thanks for watching."

## Before you send V1

- [ ] Under 4 minutes (aim for 3:20).
- [ ] The product is on screen by 0:30.
- [ ] Only the real dashboard and Airwallex: no slides.
- [ ] One use case, start to finish: hold → buy → two locks → ask → settle.
- [ ] Text is readable at 1080p; audio is clear.
- [ ] Camera at eye level, good light.
- [ ] Someone who has never seen Margin can follow it without extra context.
- [ ] It says why it matters and how to try it.
- [ ] We watched the whole recording once before sending.

## If something goes wrong while recording

| Symptom | Fix |
|---|---|
| The card number field stays empty after typing | Drop-in hadn't finished loading. Click the field again and retype |
| "Card number is invalid" | The field kept stray digits. Select all, delete, and retype |
| B never asks to raise its hold | Press **Trigger overrun (job B ×4)** after the "model-lite slows" line, not before; run again |
| The run fails with "live rail not ready" | Clock skew or a bad RPC. Resync the clock and restart the engine |
| The engine crashed mid-run | Restart it; the startup sweeper settles the open holds. Then run again |
| An approval prompt timed out | `APPROVAL_TIMEOUT_MS=60000` gives you 60 s; set it before starting the engine |
