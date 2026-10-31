/**
 * Metal clearing behind an interface (Kit 12: per-job deposit, signed running totals,
 * epochs, withdrawal after epoch close).
 *
 * Metal clearing is NOT available to builders on testnet (track channel, see docs/STATUS.md),
 * so the default implementation is ClearingEmulator, and everything it produces is
 * `source: "simulated"`. A live adapter implements the same port; the engine does not change.
 *
 * Clearing runs beside the x402 rail, not instead of it: each x402 payment the rail settles
 * is also expressed as a signed cumulative total for that (job, payee), and the job's card
 * capture waits until its clearing has finalized. Reconciliation then checks
 * ledger paid = rail settled = clearing redeemed = Airwallex captured.
 */
import type { Micros } from "../money.ts";

export type Hex = `0x${string}`;
export type DataSource = "simulated" | "live";

/** One signed statement "job J owes payee P a total of C so far". A later total supersedes an earlier one. */
export interface RunningTotal {
  jobKey: string;
  payee: string;
  cumulative: Micros;
  /** Epoch in which this total was signed. */
  epoch: number;
  signature: Hex;
}

export interface Redemption {
  jobKey: string;
  payee: string;
  /** The cumulative total redeemed. */
  cumulative: Micros;
  /** What moved: cumulative minus what this payee had already redeemed for this job. */
  amount: Micros;
  epoch: number;
}

export interface ClearingJobStatus {
  deposited: Micros;
  redeemed: Micros;
  withdrawn: Micros;
  /** Unused deposit withdrawn after its last epoch settled: the job's clearing is final. */
  final: boolean;
}

export interface ClearingPort {
  readonly source: DataSource;
  /** Fund the job's deposit. Exactly one deposit per job key. */
  openDeposit(jobKey: string, amount: Micros): Promise<{ depositId: string }>;
  /**
   * Raise the job's deposit to `newTotal`. Called only after the card hold increment succeeded,
   * so the clearing cap never runs ahead of what the customer approved.
   * (Not in the Kit 12 list; Metal's depositToClearing can fund an account again, so a live
   * adapter maps this to a second deposit into the same account.)
   */
  raiseDeposit(jobKey: string, newTotal: Micros): Promise<void>;
  /** Sign the new cumulative total owed to `payee` by this job. Resending the same total is a no-op. */
  signRunningTotal(jobKey: string, payee: string, cumulative: Micros): Promise<RunningTotal>;
  /** Close the current epoch and return its number. Totals signed after this land in the next epoch. */
  closeEpoch(): Promise<number>;
  /** Payees redeem the latest total each signed up to and including this (closed) epoch. */
  settle(epoch: number): Promise<Redemption[]>;
  /** Withdraw the job's unused deposit. Only after every epoch it signed in has closed and settled. */
  withdraw(jobKey: string): Promise<{ amount: Micros }>;
  status(jobKey: string): ClearingJobStatus | undefined;
}

/** Something tried to break a clearing rule. The emulator records these so the sim can prove we never do. */
export class ClearingViolation extends Error {}
