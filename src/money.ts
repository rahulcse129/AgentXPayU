/**
 * All money is integer micro-dollars (1 USD = 1_000_000 micros).
 * 1 USDZ is treated as 1 USD. Never use floating point for balances.
 */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;
export const MICROS_PER_CENT = 10_000;

export const usd = (d: number): Micros => Math.round(d * MICROS_PER_USD);
export const cents = (c: number): Micros => Math.round(c * MICROS_PER_CENT);

/** Round down to whole cents: the customer never pays for a fraction of a cent. */
export const floorToCent = (m: Micros): Micros => Math.floor(m / MICROS_PER_CENT) * MICROS_PER_CENT;
export const ceilToCent = (m: Micros): Micros => Math.ceil(m / MICROS_PER_CENT) * MICROS_PER_CENT;

export const fmt = (m: Micros): string => `$${(m / MICROS_PER_USD).toFixed(2)}`;
export const fmtUsdz = (m: Micros): string => `${(m / MICROS_PER_USD).toFixed(2)} USDZ`;

/** Airwallex amounts are decimal major units. */
export const toMajor = (m: Micros): number => Math.round(m / MICROS_PER_CENT) / 100;

export function assertMicros(m: Micros, label = "amount"): void {
  if (!Number.isSafeInteger(m) || m < 0) {
    throw new Error(`${label} must be a non-negative integer number of micros, got ${m}`);
  }
}
