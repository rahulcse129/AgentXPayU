/**
 * In-memory stand-in for the Metal testnet float wallet with x402 settlement.
 * Settlement is idempotent on the key, like the real clearing layer should be.
 * Fault injection: requests that fail before settling, and acknowledgements lost after settling.
 */
import type { Micros } from "../money.ts";
import { InsufficientFloat, TransientError, type FloatGateway } from "./types.ts";

export interface Settlement {
  key: string;
  payTo: string;
  amount: Micros;
  txHash: string;
}

export class MockMetal implements FloatGateway {
  deposited: Micros = 0;
  withdrawn: Micros = 0;
  private bal: Micros = 0;
  readonly settlements = new Map<string, Settlement>();
  /** pay() calls that hit an already-settled key and were deduped. */
  dedupedRetries = 0;
  private n = 0;

  constructor(
    private readonly opts: { failBeforeSettleRate?: number; ackLossRate?: number; rng?: () => number } = {},
  ) {}

  private roll(rate = 0): boolean {
    return rate > 0 && (this.opts.rng ?? Math.random)() < rate;
  }

  private tx(): string {
    return `0x${(++this.n).toString(16).padStart(64, "0")}`;
  }

  async deposit(amount: Micros) {
    this.bal += amount;
    this.deposited += amount;
    return { txHash: this.tx() };
  }

  async pay({ idempotencyKey, payTo, amount }: { idempotencyKey: string; payTo: string; amount: Micros; asset: string }) {
    const prior = this.settlements.get(idempotencyKey);
    if (prior) {
      if (prior.amount !== amount || prior.payTo !== payTo) {
        throw new Error(`settlement ${idempotencyKey} replayed with a different payload`);
      }
      this.dedupedRetries++;
      return { txHash: prior.txHash };
    }
    if (this.roll(this.opts.failBeforeSettleRate)) throw new TransientError("rpc timeout before settlement");
    if (amount > this.bal) throw new InsufficientFloat(`float ${this.bal} < ${amount}`);
    const s: Settlement = { key: idempotencyKey, payTo, amount, txHash: this.tx() };
    this.bal -= amount;
    this.settlements.set(idempotencyKey, s);
    if (this.roll(this.opts.ackLossRate)) throw new TransientError("connection dropped after settlement");
    return { txHash: s.txHash };
  }

  async lookup(idempotencyKey: string) {
    const s = this.settlements.get(idempotencyKey);
    return s ? { txHash: s.txHash, amount: s.amount } : null;
  }

  async withdraw(amount: Micros) {
    if (amount > this.bal) throw new InsufficientFloat(`withdraw ${amount} > ${this.bal}`);
    this.bal -= amount;
    this.withdrawn += amount;
    return { txHash: this.tx() };
  }

  async balance() {
    return this.bal;
  }

  totalSettled(): Micros {
    let t = 0;
    for (const s of this.settlements.values()) t += s.amount;
    return t;
  }
}
