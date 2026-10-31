import type { Micros } from "../money.ts";

export type StepKind = "model" | "search" | "data";
export type Tier = 1 | 2 | 3;

/** A provider as published in the price list. Price is per unit (paragraph for models, call for search/data). */
export interface ProviderSpec {
  id: string;
  kind: StepKind;
  tier: Tier;
  pricePerUnit: Micros;
  /** Registered payout address. A 402 asking us to pay anywhere else is refused. */
  payTo: string;
  nominalLatencyMs: number;
}

/** What the agent has learned about a provider at runtime. */
export interface ProviderHealth {
  latencyEmaMs: number;
  qualityFailures: number;
  blocked: boolean;
  blockReason?: string;
}

export interface Step {
  id: string;
  kind: StepKind;
  /** Paragraphs for model steps, 1 for search/data. */
  units: number;
  minTier: Tier;
  maxLatencyMs: number;
  /** Optional steps are the first thing dropped when the budget is tight. */
  optional?: boolean;
  /** Premium allowed if the answer judged not good enough. */
  premiumEligible?: boolean;
}

export interface JobBudget {
  /** Currently authorized card hold. */
  holdAmount: Micros;
  /** Confirmed payments. */
  spent: Micros;
  /** Payments started but not confirmed. Counted against headroom. */
  inFlight: Micros;
}

/** x402-style payment requirement returned by a provider with HTTP 402. */
export interface PaymentRequirement {
  amount: Micros;
  asset: string;
  payTo: string;
  nonce: string;
}

export interface PolicyConfig {
  /** Answers scoring below this may be re-bought at a higher tier. */
  qualityThreshold: number;
  /** Answers scoring below this count as junk against the provider. */
  junkThreshold: number;
  /** Junk answers before a provider is blocked. */
  maxQualityFailures: number;
  /** Largest total hold the agent may ever request for one job. */
  maxHold: Micros;
  /** Extra headroom requested on top of the projected need when raising a hold. */
  holdIncreaseBuffer: Micros;
  /** Weight of the newest latency sample in the moving average. */
  latencyAlpha: number;
  asset: string;
}

export const DEFAULT_POLICY: PolicyConfig = {
  qualityThreshold: 0.7,
  junkThreshold: 0.2,
  maxQualityFailures: 2,
  maxHold: 3_000_000,
  holdIncreaseBuffer: 50_000,
  latencyAlpha: 0.5,
  asset: "USDZ",
};
