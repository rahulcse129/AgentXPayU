# Dashboard run with live Airwallex card holds (Drop-in), 2026-11-09

`APPROVAL_TIMEOUT_MS=60000 npm run engine:live-cards` (`--live-airwallex --no-llm`) plus `npm run dashboard`,
scripted demo. Card holds are LIVE in the Airwallex sandbox; the Metal rail, mandate and clearing are SIMULATED
in this mode (each is labelled on the dashboard).

## How each hold was placed

1. The engine creates a PaymentIntent server-side (`request_id` `margin-<runTag>-<job>-create`, no card).
2. The dashboard shows Airwallex Drop-in for that intent (`@airwallex/components-sdk` 1.36.0, `pre_auth`,
   `autoCapture: false`). Card entered: Airwallex's sandbox test Visa. Card data went from Drop-in to Airwallex;
   our page and server never saw it.
3. The engine polls the intent until `REQUIRES_CAPTURE`, then starts the job.

## Result: reconciled, 0 violations

| Job | Intent | Hold | Captured (read back from Airwallex) | Released |
|---|---|---|---|---|
| A, Acme Research | `int_sgpvzc9hjhnz8to5ybe` | $1.00 | $0.48 | $0.52 |
| B, Birch Capital | `int_sgpvtdh4nhnz8u8xpgj` | $0.75 → **$1.24** (customer approved, live `increment_authorization`) | $0.60 | $0.64 |
| C, Cobalt Labs | `int_sgpvtdh4nhnz8upt7tz` | $0.75 (customer declined the raise; plan degraded) | $0.39 | $0.36 |
| **Total** | | | **$1.47** = ledger $1.47 = rail $1.47 = clearing $1.47 | |

The rogue provider was blocked twice in the run. Our quote check refused an overquote. With the check
deliberately off, the simulated mandate refused payment to the unregistered address.

## Settled by the sandbox (were `VERIFY` comments)

- `increment_authorization.amount` is the **new total**: B sent 1.24 and the intent reads back `amount: 1.24`
  (a delta would read 1.99).
- The captured amount is on the intent as `captured_amount` (also `latest_payment_attempt.captured_amount`).
  After a partial capture the intent is `SUCCEEDED`, attempt `CAPTURE_REQUESTED`.
- `cancel` accepts `cancellation_reason`.

## The run before this one failed, and what changed

An earlier run the same day lost the network for at least 17 s near the end:

- C's intent create failed, so C never got a card and the job failed.
- Both captures failed (`hold.settle_failed`).
- The read-back for the summary threw, so the run reported no result.

The holds for A ($1.00) and B ($0.75) stayed open at Airwallex (`REQUIRES_CAPTURE`). The session ledger is
in memory, so there was no record of what they had spent, and they were cancelled by hand
(`int_sgpvtdh4nhnz8efra0c`, `int_sgpvtdh4nhnz8ikf9d6`, both now `CANCELLED`, nothing captured).

Fixes, with tests in `test/airwallex.test.ts`:

- Every Airwallex call retries network errors and 5xx with backoff (1 s, 3 s, 8 s, 20 s). That is safe
  because every POST has a deterministic `request_id`.
- A login that fails on the network now counts as transient. It used to be a hard error.
- Card polling keeps going through a blip until the deadline.
- An unreadable intent at summary time is reported as a violation (`airwallex.unreadable`). It no longer
  fails the run.

Still open: the dashboard session ledger is in memory, so a crash with live holds open can't be swept on
restart. The engine now prints a warning about this at startup.
