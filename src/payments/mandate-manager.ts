/**
 * MandateManager: the engine's float when payments go through a Metal mandate.
 *
 * It is a FloatGateway, so the engine needs no special path:
 *   deposit(float)      → open the mandate (credential + bind) with budget = the batch's float
 *   pay(key, ...)       → `mandate pull` under it; the mandate checks payee, cap and budget first
 *   lookup(key)         → the mandate rail's record of that payment id
 *   onHoldIncreased()   → raise the budget, called only after the Airwallex increment succeeded
 *   close()             → revoke at batch end; nothing can be paid under it afterwards
 *
 * Every step is written to the ledger (mandate.opened / raised / revoked / refused) so the feed,
 * receipts and dashboard show both locks: our policy check, then Metal's mandate.
 *
 * First version by Kavisha (dbe6432): lifecycle and ledger events. This version makes the
 * mandate the payment path instead of a check beside it.
 */
import type { Ledger } from "../ledger/ledger.ts";
import type { ProviderSpec } from "../policy/types.ts";
import type { Micros } from "../money.ts";
import { InsufficientFloat, type FloatGateway } from "./types.ts";
import { MandateRefused, type MandateGateway, type MandateInfo } from "./mandate.ts";

export class MandateManager implements FloatGateway {
  private mandate: MandateInfo | null = null;
  private allocated: Micros = 0;
  private readonly paid = new Map<string, { payTo: string; amount: Micros; txHash: string }>();
  private ledger: Ledger | null = null;

  constructor(
    readonly gateway: MandateGateway,
    private readonly catalog: ProviderSpec[],
    /** The largest single payment the mandate allows. */
    private readonly perPaymentCap: Micros,
  ) {}

  /** Ledger for the current run (created per run, after this manager). */
  attach(ledger: Ledger): this {
    this.ledger = ledger;
    return this;
  }

  get source(): "live" | "simulated" {
    return this.gateway.source;
  }

  get active(): MandateInfo | null {
    return this.mandate;
  }

  async deposit(amount: Micros): Promise<{ txHash: string }> {
    if (!this.mandate) {
      const info = await this.gateway.open({
        payees: this.catalog.map((p) => ({ address: p.payTo, name: p.id })),
        perPaymentCap: this.perPaymentCap,
        budget: amount,
        description: "Margin job batch",
      });
      this.mandate = info;
      this.allocated = amount;
      this.ledger?.log(null, "mandate.opened", {
        mandateId: info.mandateId,
        bindTx: info.bindTx,
        payees: info.payees.length,
        perPaymentCap: info.perPaymentCap,
        budget: info.budget,
        source: info.source,
      });
      return { txHash: info.bindTx };
    }
    await this.raiseTo(this.mandate.budget + amount, "float topped up");
    this.allocated += amount;
    return { txHash: "" };
  }

  async pay(req: { idempotencyKey: string; payTo: string; amount: Micros; asset: string }): Promise<{ txHash: string }> {
    const { idempotencyKey: key, payTo, amount, asset } = req;
    if (asset !== "USDZ") throw new Error(`mandates pay in USDZ only, asked for ${asset}`);
    const prior = this.paid.get(key);
    if (prior) {
      if (prior.amount !== amount || prior.payTo.toLowerCase() !== payTo.toLowerCase()) throw new Error(`payment ${key} replayed with a different payload`);
      return { txHash: prior.txHash };
    }
    if (amount > (await this.balance())) throw new InsufficientFloat(`float ${await this.balance()} < ${amount}`);
    try {
      const { txHash } = await this.gateway.pull({ paymentId: key, payTo, amount });
      this.paid.set(key, { payTo, amount, txHash });
      return { txHash };
    } catch (e) {
      if (e instanceof MandateRefused) {
        this.ledger?.log(null, "mandate.refused", {
          key,
          payTo,
          amount,
          why: e.message,
          reason: e.reason,
          refusalTx: e.refusalTx,
          mandateId: this.mandate?.mandateId,
          source: this.source,
        });
      }
      throw e;
    }
  }

  async lookup(key: string): Promise<{ txHash: string; amount: Micros } | null> {
    const known = this.paid.get(key);
    if (known) return { txHash: known.txHash, amount: known.amount };
    const found = await this.gateway.lookup(key);
    if (found) this.paid.set(key, { payTo: "", amount: found.amount, txHash: found.txHash });
    return found;
  }

  /** Accounting only: the unspent budget simply stays unspent until close() revokes the mandate. */
  async withdraw(amount: Micros): Promise<{ txHash: string }> {
    if (amount > (await this.balance())) throw new InsufficientFloat(`withdraw ${amount} > float left ${await this.balance()}`);
    this.allocated -= amount;
    return { txHash: "" };
  }

  async balance(): Promise<Micros> {
    let spent = 0;
    for (const p of this.paid.values()) spent += p.amount;
    return this.allocated - spent;
  }

  /** After a customer-approved hold increase succeeded: the mandate budget grows by the same amount. */
  async onHoldIncreased(jobId: string, from: Micros, to: Micros): Promise<void> {
    if (!this.mandate || to <= from) return;
    await this.raiseTo(this.mandate.budget + (to - from), `job ${jobId} hold raised ${from} → ${to}`);
  }

  async close(): Promise<string> {
    if (!this.mandate || this.mandate.revokeTx !== null) return "";
    const { tx } = await this.gateway.revoke();
    this.mandate.revokeTx = tx;
    this.ledger?.log(null, "mandate.revoked", { mandateId: this.mandate.mandateId, revokeTx: tx, source: this.source });
    return tx;
  }

  private async raiseTo(newBudget: Micros, why: string) {
    const m = this.mandate!;
    const { tx } = await this.gateway.raiseBudget(newBudget);
    const from = m.budget;
    m.budget = newBudget;
    this.ledger?.log(null, "mandate.raised", { mandateId: m.mandateId, from, to: newBudget, raiseTx: tx, why, source: this.source });
  }
}
