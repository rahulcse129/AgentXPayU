/**
 * Local emulator of Metal clearing, following the rules Kit 12 documents. SIMULATED: no chain,
 * no Metal service. Like MockAirwallex, it enforces each rule and RECORDS any attempt to break
 * it, so the simulation can prove the engine never tries.
 *
 * Rules:
 *  - one deposit per job key; a deposit can only grow (raiseDeposit) until it is withdrawn
 *  - each payment is a signed cumulative total per (job, payee); a later total supersedes an
 *    earlier one and can never be lower
 *  - the latest totals of a job never add up to more than its deposit
 *  - payees redeem the latest total signed in or before a closed epoch; they receive only the
 *    part above what they already redeemed, after the signature verifies
 *  - unused deposit is withdrawable once every epoch the job signed in has closed and settled
 *
 * Why running totals fit the ledger's idempotency rule: a retry resends the same cumulative
 * total, and redeeming a total pays only the difference from the last redeemed one, so the
 * same total sent twice (or redeemed in two epochs) moves money once.
 */
import type { Micros } from "../money.ts";
import { ClearingViolation, type ClearingJobStatus, type ClearingPort, type Redemption, type RunningTotal } from "./port.ts";
import type { RunningTotalSigner } from "./signer.ts";

interface Deposit {
  jobKey: string;
  amount: Micros;
  openedEpoch: number;
  /** Latest signed total per payee (lower-cased address). */
  latest: Map<string, RunningTotal>;
  /** Cumulative already redeemed per payee. */
  redeemedTo: Map<string, Micros>;
  lastSignedEpoch: number;
  withdrawn: Micros | null;
}

export class ClearingEmulator implements ClearingPort {
  readonly source = "simulated" as const;
  readonly violations: string[] = [];
  readonly redemptions: Redemption[] = [];
  /** Every total ever signed, in order. For receipts and the sim checks. */
  readonly signed: RunningTotal[] = [];
  private readonly deposits = new Map<string, Deposit>();
  private epoch = 1;
  private readonly closed = new Set<number>();
  private readonly settled = new Set<number>();

  constructor(private readonly signer: RunningTotalSigner) {}

  get currentEpoch(): number {
    return this.epoch;
  }

  get signerKind(): RunningTotalSigner["kind"] {
    return this.signer.kind;
  }

  async openDeposit(jobKey: string, amount: Micros) {
    if (this.deposits.has(jobKey)) return this.violate(`second deposit for job ${jobKey}`);
    if (!Number.isSafeInteger(amount) || amount < 0) return this.violate(`deposit of ${amount} for ${jobKey}`);
    this.deposits.set(jobKey, {
      jobKey,
      amount,
      openedEpoch: this.epoch,
      latest: new Map(),
      redeemedTo: new Map(),
      lastSignedEpoch: 0,
      withdrawn: null,
    });
    return { depositId: `dep_sim_${jobKey}` };
  }

  async raiseDeposit(jobKey: string, newTotal: Micros) {
    const d = this.must(jobKey);
    if (d.withdrawn !== null) return this.violate(`raise on withdrawn deposit ${jobKey}`);
    if (!Number.isSafeInteger(newTotal) || newTotal <= d.amount) return this.violate(`raise ${jobKey} to ${newTotal} is not above ${d.amount}`);
    d.amount = newTotal;
  }

  async signRunningTotal(jobKey: string, payee: string, cumulative: Micros): Promise<RunningTotal> {
    const d = this.must(jobKey);
    const who = payee.toLowerCase();
    if (d.withdrawn !== null) return this.violate(`total signed for ${jobKey} after its deposit was withdrawn`);
    if (!Number.isSafeInteger(cumulative) || cumulative < 0) return this.violate(`total ${cumulative} for ${jobKey}/${who}`);
    const prev = d.latest.get(who);
    if (prev && cumulative < prev.cumulative) {
      return this.violate(`total for ${jobKey}/${who} went down from ${prev.cumulative} to ${cumulative}`);
    }
    // Same total again: return the original signed statement unchanged. Nothing new is owed.
    if (prev && cumulative === prev.cumulative) return prev;
    const owed = [...d.latest.entries()].reduce((s, [p, t]) => s + (p === who ? 0 : t.cumulative), cumulative);
    if (owed > d.amount) return this.violate(`totals for ${jobKey} reach ${owed} > deposit ${d.amount}`);

    const msg = { jobKey, payee: who, cumulative, epoch: this.epoch };
    const total: RunningTotal = { ...msg, signature: await this.signer.sign(msg) };
    d.latest.set(who, total);
    d.lastSignedEpoch = this.epoch;
    this.signed.push(total);
    return total;
  }

  async closeEpoch() {
    const e = this.epoch;
    this.closed.add(e);
    this.epoch++;
    return e;
  }

  async settle(epoch: number): Promise<Redemption[]> {
    if (!this.closed.has(epoch)) return this.violate(`settle of open epoch ${epoch}`);
    if (this.settled.has(epoch)) return this.violate(`epoch ${epoch} settled twice`);
    const out: Redemption[] = [];
    for (const d of this.deposits.values()) {
      for (const [who, t] of d.latest) {
        // A total signed in a later epoch waits for that epoch to close.
        if (t.epoch > epoch) continue;
        const already = d.redeemedTo.get(who) ?? 0;
        if (t.cumulative <= already) continue;
        if (!(await this.signer.verify({ jobKey: t.jobKey, payee: t.payee, cumulative: t.cumulative, epoch: t.epoch }, t.signature))) {
          this.violations.push(`bad signature on ${d.jobKey}/${who} total ${t.cumulative}`);
          continue;
        }
        const r: Redemption = { jobKey: d.jobKey, payee: who, cumulative: t.cumulative, amount: t.cumulative - already, epoch };
        d.redeemedTo.set(who, t.cumulative);
        this.redemptions.push(r);
        out.push(r);
      }
    }
    this.settled.add(epoch);
    return out;
  }

  async withdraw(jobKey: string) {
    const d = this.must(jobKey);
    if (d.withdrawn !== null) return this.violate(`second withdrawal for ${jobKey}`);
    for (let e = d.openedEpoch; e <= Math.max(d.openedEpoch, d.lastSignedEpoch); e++) {
      if (!this.settled.has(e)) return this.violate(`withdrawal for ${jobKey} before epoch ${e} settled`);
    }
    const amount = d.amount - this.redeemedOf(d);
    d.withdrawn = amount;
    return { amount };
  }

  status(jobKey: string): ClearingJobStatus | undefined {
    const d = this.deposits.get(jobKey);
    if (!d) return undefined;
    return { deposited: d.amount, redeemed: this.redeemedOf(d), withdrawn: d.withdrawn ?? 0, final: d.withdrawn !== null };
  }

  jobKeys(): string[] {
    return [...this.deposits.keys()];
  }

  /** Latest signed total for (job, payee), for receipts. */
  latestTotal(jobKey: string, payee: string): RunningTotal | undefined {
    return this.deposits.get(jobKey)?.latest.get(payee.toLowerCase());
  }

  private redeemedOf(d: Deposit): Micros {
    let s = 0;
    for (const v of d.redeemedTo.values()) s += v;
    return s;
  }

  private must(jobKey: string): Deposit {
    const d = this.deposits.get(jobKey);
    if (!d) return this.violate(`no deposit for job ${jobKey}`);
    return d;
  }

  private violate(msg: string): never {
    this.violations.push(msg);
    throw new ClearingViolation(msg);
  }
}
