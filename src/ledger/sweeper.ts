/**
 * Startup sweeper: closes orphaned holds left open by a previous server crash.
 *
 * The safety rule (invariant #3 in the project prompt):
 *   "Every hold ends captured or cancelled, including for failed and crashed jobs."
 *
 * When the server restarts after a crash, any hold still at status = 'authorized'
 * in SQLite is an orphan. The customer's card has money locked that may never be
 * released unless we clean it up.
 *
 * Logic per orphaned hold:
 *   - If the job has paid payments recorded in the ledger: capture exactly what was spent.
 *   - If nothing was spent: cancel the hold (releases the full amount to the customer).
 *   - Either way: update the hold status in the ledger store.
 *   - Log what happened so the dashboard and STATUS.md can reference it.
 *
 * The sweeper is called once at engine server startup, before accepting any requests.
 */
import type { HoldGateway } from "../payments/types.ts";
import type { LedgerStore } from "./ledger.ts";
import { TransientError } from "../payments/types.ts";
import { floorToCent } from "../money.ts";

export interface SweeperResult {
  swept: number;
  captured: number;
  cancelled: number;
  errors: string[];
}

/**
 * Sweep all holds that are still `authorized` in the SQLite store.
 * @param store  The persistent ledger store (must be SqliteStore, not MemoryStore).
 * @param holds  The card hold gateway (MockAirwallex or AirwallexHoldGateway).
 * @param log    Optional logger (defaults to console.log).
 */
export async function sweepOrphanedHolds(
  store: LedgerStore,
  holds: HoldGateway,
  log: (msg: string) => void = console.log,
): Promise<SweeperResult> {
  const result: SweeperResult = { swept: 0, captured: 0, cancelled: 0, errors: [] };

  // Find all holds that never reached 'captured' or 'cancelled'.
  // listPayments and getHold are both available on LedgerStore.
  const allPayments = store.listPayments();
  const allEvents = store.listEvents();

  // Collect jobIds with an 'authorized' hold.
  // We iterate events to find hold.authorized events without a matching hold.captured/cancelled.
  const holdAuthorized = new Set<string>();
  const holdClosed = new Set<string>();

  for (const ev of allEvents) {
    if (!ev.jobId) continue;
    if (ev.type === "hold.authorized") holdAuthorized.add(ev.jobId);
    if (ev.type === "hold.captured" || ev.type === "hold.cancelled") holdClosed.add(ev.jobId);
  }

  const orphanJobIds = [...holdAuthorized].filter((id) => !holdClosed.has(id));
  if (orphanJobIds.length === 0) {
    log("[Sweeper] No orphaned holds found.");
    return result;
  }

  log(`[Sweeper] Found ${orphanJobIds.length} orphaned hold(s) from a prior session.`);

  for (const jobId of orphanJobIds) {
    result.swept++;
    const holdRow = store.getHold(jobId);
    if (!holdRow) {
      result.errors.push(`${jobId}: hold row missing (data inconsistency)`);
      continue;
    }

    // Calculate what was actually paid for this job.
    const jobPayments = allPayments.filter((p) => p.jobId === jobId && p.status === "paid");
    const spent = jobPayments.reduce((s, p) => s + p.amount, 0);
    const captureAmount = floorToCent(spent);

    const maxRetries = 3;
    let succeeded = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (captureAmount > 0) {
          await holds.capture(holdRow.holdId, captureAmount);
          store.upsertHold({ ...holdRow, captured: captureAmount, status: "captured" });
          store.appendEvent({
            at: Date.now(),
            jobId,
            type: "hold.captured",
            data: { holdId: holdRow.holdId, captured: captureAmount, reason: "sweeper_on_restart" },
          });
          log(`[Sweeper] Job ${jobId}: captured ${captureAmount} micros (spent from ${jobPayments.length} payment(s)).`);
          result.captured++;
        } else {
          await holds.cancel(holdRow.holdId, "job_crashed_before_any_spend");
          store.upsertHold({ ...holdRow, captured: 0, status: "cancelled" });
          store.appendEvent({
            at: Date.now(),
            jobId,
            type: "hold.cancelled",
            data: { holdId: holdRow.holdId, released: holdRow.authorized, reason: "sweeper_on_restart" },
          });
          log(`[Sweeper] Job ${jobId}: cancelled (nothing was spent).`);
          result.cancelled++;
        }
        succeeded = true;
        break;
      } catch (e) {
        if (e instanceof TransientError && attempt < maxRetries) {
          log(`[Sweeper] Job ${jobId}: attempt ${attempt} transient error, retrying... (${String(e)})`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        } else {
          const msg = `${jobId}: failed after ${attempt} attempt(s): ${String(e)}`;
          result.errors.push(msg);
          log(`[Sweeper] ERROR — ${msg}`);
          break;
        }
      }
    }

    if (!succeeded) {
      log(`[Sweeper] WARNING: Job ${jobId} hold ${holdRow.holdId} could not be closed. Manual action needed.`);
    }
  }

  log(`[Sweeper] Done. Swept: ${result.swept}, Captured: ${result.captured}, Cancelled: ${result.cancelled}, Errors: ${result.errors.length}`);
  return result;
}

