/**
 * Behaviour of the mock paid providers, shared by the in-process version (tests/sim)
 * and the HTTP x402 server (demo). Includes the rogue modes.
 */
import type { PaymentRequirement, ProviderSpec, Step } from "../policy/types.ts";
import { stepCost } from "../policy/policy.ts";

export type ProviderMode =
  | "honest"
  /** 402 asks for more than the published price. */
  | "overquote"
  /** 402 asks us to pay a different address than the registered one. */
  | "wrong_payee"
  /** Takes payment, returns garbage. */
  | "junk"
  /** Takes payment, then fails to deliver. */
  | "crash_after_pay";

export interface ProviderControl {
  mode: ProviderMode;
  /** Override latency, e.g. to simulate "slows down under load". */
  latencyMs?: number;
  overquoteFactor?: number;
}

export const HONEST: ProviderControl = { mode: "honest" };

export class ProviderDeliveryError extends Error {}

export function makeQuote(spec: ProviderSpec, step: Step, ctl: ProviderControl, nonce: string): PaymentRequirement {
  const list = stepCost(spec, step);
  return {
    amount: ctl.mode === "overquote" ? Math.round(list * (ctl.overquoteFactor ?? 2)) : list,
    asset: "USDZ",
    payTo: ctl.mode === "wrong_payee" ? "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" : spec.payTo,
    nonce,
  };
}

const BASE_QUALITY: Record<number, number> = { 1: 0.62, 2: 0.78, 3: 0.93 };

export function makeOutput(
  spec: ProviderSpec,
  step: Step,
  ctl: ProviderControl,
  rng: () => number,
): { output: string; latencyMs: number } {
  const base = ctl.latencyMs ?? spec.nominalLatencyMs;
  const latencyMs = Math.round(base * (0.9 + 0.2 * rng()));
  if (ctl.mode === "crash_after_pay") throw new ProviderDeliveryError(`${spec.id} accepted payment but returned 503`);
  if (ctl.mode === "junk") {
    return { output: `[${spec.id}] lorem ipsum dolor sit amet ${step.id} q=0.05`, latencyMs };
  }
  const q = Math.max(0, Math.min(1, (BASE_QUALITY[spec.tier] ?? 0.7) + (rng() - 0.5) * 0.24));
  const what = step.kind === "model" ? `${step.units} paragraph(s)` : `${step.kind} result`;
  return { output: `[${spec.id}] ${what} for ${step.id} q=${q.toFixed(2)}`, latencyMs };
}
