/**
 * Micros to the decimal *USDZ strings the metal-agent CLI takes. Mandate amounts are "to the
 * cent" (CLI help), so anything finer is refused rather than rounded: money is never rounded
 * in either party's favour.
 */
import { MICROS_PER_CENT, type Micros } from "../money.ts";
import { PaymentRefused } from "./types.ts";

export function toUsdzCents(micros: Micros): string {
  if (!Number.isSafeInteger(micros) || micros < 0) throw new Error(`invalid micros: ${micros}`);
  if (micros % MICROS_PER_CENT !== 0) throw new PaymentRefused(`amount ${micros} micros is not a whole number of cents; mandates pay to the cent`);
  const c = micros / MICROS_PER_CENT;
  return `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}
