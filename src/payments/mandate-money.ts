/**
 * Micro-to-major-unit conversion for the metal-agent CLI.
 * metal-agent mandate commands take amounts in USDZ major units (dollars), e.g. "0.05".
 * Our ledger uses micros (integer micro-dollars).
 *
 * 1 USDZ = 1,000,000 micros.  1 micro = 0.000001 USDZ.
 * We format with exactly 6 decimal places and trim trailing zeros but keep at least 2.
 *
 * Examples:
 *   5000  → "0.005000" → "0.005"   (5 milli-dollars = $0.005)
 *   100   → "0.0001"               (100 micros = $0.0001)
 *   1000000 → "1.00"               (1 dollar)
 */
import type { Micros } from "../money.ts";

export function toMajorString(micros: Micros): string {
  if (!Number.isInteger(micros) || micros < 0) throw new Error(`invalid micros: ${micros}`);
  const whole = Math.floor(micros / 1_000_000);
  const frac = micros % 1_000_000;
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fracStr}`;
}

