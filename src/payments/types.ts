import type { Micros } from "../money.ts";

/** Card holds. Implemented by Airwallex (real) and MockAirwallex (tests/sim). */
export interface HoldGateway {
  /** Pre-authorize `amount` with manual capture. Returns the PaymentIntent id. */
  authorize(req: { jobId: string; amount: Micros; paymentMethod?: unknown }): Promise<{ holdId: string }>;
  /** Raise the authorized total to `newTotal`. Must succeed before spending past the old hold. */
  increment(holdId: string, newTotal: Micros): Promise<void>;
  /** Capture `amount` (<= authorized) and release the rest. */
  capture(holdId: string, amount: Micros): Promise<void>;
  /** Release the whole hold. Used when a job spent nothing. */
  cancel(holdId: string, reason: string): Promise<void>;
}

/** Per-request provider payments from the job float. Implemented by Metal (real) and MockMetal. */
export interface FloatGateway {
  deposit(amount: Micros): Promise<{ txHash: string }>;
  /**
   * Pay a provider. MUST be idempotent on `idempotencyKey`: a second call with the same key
   * returns the original settlement and moves no money.
   */
  pay(req: { idempotencyKey: string; payTo: string; amount: Micros; asset: string }): Promise<{ txHash: string }>;
  /** Did a payment with this key settle? Used to resolve ambiguous failures. */
  lookup(idempotencyKey: string): Promise<{ txHash: string; amount: Micros } | null>;
  withdraw(amount: Micros): Promise<{ txHash: string }>;
  balance(): Promise<Micros>;
}

/** Network-level failure. The payment may or may not have settled; retry with the same key. */
export class TransientError extends Error {}
export class InsufficientFloat extends Error {}
export class IssuerDeclined extends Error {}
/** Something tried to break a hold rule (e.g. capture above the authorized amount). */
export class HoldViolation extends Error {}
/**
 * The rail turned a payment down and nothing moved: an expired authorization, or a Metal
 * mandate refusing the payee, the per-payment cap or the budget. The engine records the
 * refusal, blocks the provider and buys elsewhere; it does not retry.
 */
export class PaymentRefused extends Error {}
