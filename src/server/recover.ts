/**
 * Recovery for dashboard runs with live Airwallex holds. Each run's ledger is a SQLite file
 * (`<dir>/<runTag>.db`); on engine startup every file is swept, so a hold left `authorized` by a
 * crash is captured for what was spent or cancelled (invariant 3).
 *
 * Which rail paid decides how payments a crash left `pending` are resolved:
 *   - "simulated": MockMetal died with the process and moved no real money, so nothing pending settled.
 *   - "x402": MetalFloatGateway.lookup reads the chain (deterministic nonce), so it answers after a restart.
 *   - "mandate": the mandate CLI can only be re-asked by the process that asked first, so a restart
 *     cannot tell paid from unpaid. No lookup: such a hold is skipped and reported, never guessed.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "../ledger/sqlite.ts";
import { sweepOrphanedHolds, type SweeperResult } from "../ledger/sweeper.ts";
import type { FloatGateway, HoldGateway } from "../payments/types.ts";

export type PaymentRail = "simulated" | "x402" | "mandate";

/** Ledger event a run writes first, so a later sweep knows which rail to ask. */
export const RUN_RAILS_EVENT = "run.rails";

type Lookup = Pick<FloatGateway, "lookup">;

export function openRunLedger(dir: string, runTag: string): SqliteStore {
  mkdirSync(dir, { recursive: true });
  return new SqliteStore(join(dir, `${runTag}.db`));
}

export async function sweepRunLedgers(opts: {
  dir: string;
  holds: HoldGateway;
  /** The x402 rail's lookup, when the engine has Metal credentials; undefined skips pending x402 payments. */
  x402Lookup?: Lookup;
  log?: (msg: string) => void;
  retryDelayMs?: number;
}): Promise<SweeperResult & { files: number }> {
  const log = opts.log ?? console.log;
  const total = { files: 0, swept: 0, captured: 0, cancelled: 0, skipped: 0, errors: [] as string[] };
  if (!existsSync(opts.dir)) return total;
  for (const name of readdirSync(opts.dir).filter((f) => f.endsWith(".db")).sort()) {
    const store = new SqliteStore(join(opts.dir, name));
    try {
      const rails = store.listEvents().find((e) => e.type === RUN_RAILS_EVENT);
      const rail = (rails?.data.payments as PaymentRail | undefined) ?? "mandate"; // unknown: the safe choice
      const float: Lookup | undefined =
        rail === "simulated" ? { lookup: async () => null } : rail === "x402" ? opts.x402Lookup : undefined;
      const tag = name.replace(/\.db$/, "");
      const r = await sweepOrphanedHolds({ store, holds: opts.holds, float, log: (m) => log(m.replace("[sweeper]", `[sweeper] ${tag}`)), retryDelayMs: opts.retryDelayMs });
      total.files++;
      total.swept += r.swept;
      total.captured += r.captured;
      total.cancelled += r.cancelled;
      total.skipped += r.skipped;
      total.errors.push(...r.errors.map((e) => `${tag} ${e}`));
    } finally {
      store.close();
    }
  }
  return total;
}
