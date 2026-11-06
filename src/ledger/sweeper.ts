/**
 * Startup sweeper: closes card holds left open by a previous crash (invariant 3: every hold ends
 * captured or cancelled, including for crashed jobs).
 *
 * For every hold the persistent ledger still shows as `authorized`:
 *   1. Resolve its `pending` payments from the payment rail (lookup): settled → paid, not → failed.
 *      If the rail cannot answer, leave the hold alone and report it: capturing before we know
 *      what was paid could charge the customer less than the providers were paid, or more.
 *   2. Capture exactly what was spent (floored to the cent, never above the authorization), or
 *      cancel if nothing was spent. Transient errors are retried.
 * Events go through Ledger, so a swept hold looks exactly like one the engine settled.
 *
 * Holds must outlive the crashed process for this to mean anything: real Airwallex intents do;
 * in-memory MockAirwallex holds do not (see src/server/main.ts).
 *
 * First version by Kavisha (dbe6432); this one resolves pending payments first.
 */
import type { FloatGateway, HoldGateway } from "../payments/types.ts";
import { TransientError } from "../payments/types.ts";
import { floorToCent } from "../money.ts";
import { Ledger, type LedgerStore } from "./ledger.ts";

export interface SweeperResult {
  swept: number;
  captured: number;
  cancelled: number;
  skipped: number;
  errors: string[];
}

export async function sweepOrphanedHolds(opts: {
  store: LedgerStore;
  holds: HoldGateway;
  /** The payment rail, to resolve payments a crash left pending. Without it such holds are skipped. */
  float?: Pick<FloatGateway, "lookup">;
  log?: (msg: string) => void;
  retryDelayMs?: number;
}): Promise<SweeperResult> {
  const { store, holds, float } = opts;
  const log = opts.log ?? console.log;
  const ledger = new Ledger(store);
  const result: SweeperResult = { swept: 0, captured: 0, cancelled: 0, skipped: 0, errors: [] };

  const jobIds = new Set<string>();
  for (const e of store.listEvents()) if (e.jobId && e.type === "hold.authorized") jobIds.add(e.jobId);
  const orphans = [...jobIds].filter((id) => store.getHold(id)?.status === "authorized");
  if (orphans.length === 0) {
    log("[sweeper] no orphaned holds");
    return result;
  }
  log(`[sweeper] ${orphans.length} orphaned hold(s) from a previous run`);

  for (const jobId of orphans) {
    const hold = store.getHold(jobId)!;

    // 1. What was actually paid? Pending rows are resolved from the rail, never guessed.
    const pending = ledger.payments(jobId).filter((p) => p.status === "pending");
    let unresolved = 0;
    for (const p of pending) {
      if (!float) {
        unresolved++;
        continue;
      }
      try {
        const settled = await float.lookup(p.key);
        if (settled) ledger.markPaid(p.key, settled.txHash);
        else ledger.markFailed(p.key, "not settled (startup sweep)");
      } catch (e) {
        unresolved++;
        log(`[sweeper] ${jobId}: could not resolve pending payment ${p.key}: ${String(e)}`);
      }
    }
    if (unresolved > 0) {
      result.skipped++;
      result.errors.push(`${jobId}: ${unresolved} pending payment(s) unresolved; hold ${hold.holdId} left open for a later sweep`);
      ledger.log(jobId, "hold.sweep_skipped", { holdId: hold.holdId, unresolved });
      continue;
    }

    // 2. Capture what was spent, or cancel.
    result.swept++;
    const amount = Math.min(floorToCent(ledger.spent(jobId)), hold.authorized);
    for (let attempt = 1; ; attempt++) {
      try {
        if (amount > 0) {
          await holds.capture(hold.holdId, amount);
          ledger.recordCapture(jobId, amount);
          result.captured++;
          log(`[sweeper] ${jobId}: captured ${amount} micros`);
        } else {
          await holds.cancel(hold.holdId, "job_crashed_before_any_spend");
          ledger.recordCancel(jobId, "startup sweep: nothing spent");
          result.cancelled++;
          log(`[sweeper] ${jobId}: cancelled, nothing spent`);
        }
        break;
      } catch (e) {
        if (e instanceof TransientError && attempt < 3) {
          await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 1000) * attempt));
          continue;
        }
        result.errors.push(`${jobId}: ${String(e)}`);
        ledger.log(jobId, "hold.sweep_failed", { holdId: hold.holdId, error: String(e) });
        log(`[sweeper] ${jobId}: could not close hold ${hold.holdId}: ${String(e)}`);
        break;
      }
    }
  }
  log(`[sweeper] done: ${result.captured} captured, ${result.cancelled} cancelled, ${result.skipped} skipped, ${result.errors.length} errors`);
  return result;
}
