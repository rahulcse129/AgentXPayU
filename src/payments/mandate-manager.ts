/**
 * MandateManager: wires mandate lifecycle into an Orchestrator run.
 *
 * Sits beside the engine: the engine focuses on money; this focuses on the on-chain locks.
 *
 * Usage in a run:
 *   const mm = new MandateManager(gateway, catalog, ledger);
 *   await mm.openBatch(float, agentAddress);       // create + bind mandate
 *   // ... engine runs jobs ...
 *   await mm.onHoldIncreased(jobId, newTotal);     // raise mandate budget (after Airwallex ok)
 *   await mm.closeBatch();                         // revoke mandate
 *
 * The mandate demo moment:
 *   mm.bypassPolicyCheck = true;                   // simulates our verifyQuote being disabled
 *   mm.wouldMandateAllow(payTo, amount)             // Metal on-chain check still runs
 *
 * All mandate tx hashes go into the ledger so the dashboard can display them in receipts
 * and show the dual-lock status ("Policy check ✓ · Metal mandate ✓").
 */
import type { Ledger } from "../ledger/ledger.ts";
import type { ProviderSpec } from "../policy/types.ts";
import type { Micros } from "../money.ts";
import { cents } from "../money.ts";
import { type MandateGateway, type MandateInfo, MockMandateGateway, MetalMandateGateway } from "./mandate.ts";

export class MandateManager {
  private mandate: MandateInfo | null = null;

  /**
   * When true, the engine skips its own verifyQuote (the deliberate demo weakness).
   * Metal's mandate still enforces the allowlist and per-payment cap.
   */
  bypassPolicyCheck = false;

  constructor(
    private readonly gateway: MandateGateway,
    private readonly catalog: ProviderSpec[],
    private readonly ledger: Ledger,
  ) {}

  get active(): MandateInfo | null {
    return this.mandate;
  }

  get source(): "live" | "simulated" {
    return this.gateway.source;
  }

  /**
   * Create and bind a mandate for the whole batch.
   * @param budget  Total float for this batch (in micros).
   * @param agentAddress  The Metal agent wallet address (from MetalFloatGateway.address or env).
   */
  async openBatch(budget: Micros, agentAddress: string): Promise<MandateInfo> {
    if (this.mandate) throw new Error("mandate already open; call closeBatch first");

    const payees = this.catalog.map((p) => p.payTo);
    // The largest single step the catalog allows (model-premium @ 5¢/unit × max 1 unit = 5¢).
    const perPaymentCap: Micros = cents(5);

    const info = await this.gateway.create({ payees, perPaymentCap, budget, agentAddress });
    this.mandate = info;

    this.ledger.log(null, "mandate.created", {
      mandateId: info.mandateId,
      createTx: info.createTx,
      bindTx: info.bindTx,
      payees: info.payees.length,
      perPaymentCap,
      budget,
      source: info.source,
    });

    return info;
  }

  /**
   * Raise the mandate's budget after a customer approves a hold increase.
   * Must be called AFTER Airwallex increment_authorization succeeds.
   * @param newTotal  The new authorized total in micros.
   */
  async onHoldIncreased(newTotal: Micros): Promise<string> {
    if (!this.mandate) throw new Error("no active mandate");
    const { tx } = await this.gateway.raise(this.mandate.mandateId, newTotal);
    this.mandate.budget = newTotal;

    this.ledger.log(null, "mandate.raised", {
      mandateId: this.mandate.mandateId,
      raiseTx: tx,
      newTotal,
      source: this.mandate.source,
    });

    return tx;
  }

  /**
   * Revoke the mandate at job end. After this Metal refuses all further payments.
   */
  async closeBatch(): Promise<string> {
    if (!this.mandate) return "";
    const { tx } = await this.gateway.revoke(this.mandate.mandateId);
    this.mandate.revokeTx = tx;

    this.ledger.log(null, "mandate.revoked", {
      mandateId: this.mandate.mandateId,
      revokeTx: tx,
      source: this.mandate.source,
    });

    return tx;
  }

  /**
   * Check whether a payment would be allowed by the active mandate.
   * Used by the demo "mandate test": with bypassPolicyCheck=true, the engine skips
   * verifyQuote, but this check still enforces the on-chain allowlist and cap.
   *
   * Returns { allowed: true } or { allowed: false, reason: "..." }.
   */
  wouldMandateAllow(payTo: string, amount: Micros): { allowed: boolean; reason?: string } {
    if (!this.mandate) return { allowed: false, reason: "no active mandate" };
    if (this.mandate.revokeTx) return { allowed: false, reason: "mandate already revoked" };

    const knownPayee = this.mandate.payees.includes(payTo.toLowerCase());
    if (!knownPayee) {
      const reason = `Metal mandate: payee ${payTo} not in allowlist (${this.mandate.payees.length} registered)`;
      this.ledger.log(null, "mandate.blocked", { payTo, amount, reason, mandateId: this.mandate.mandateId });
      return { allowed: false, reason };
    }

    if (amount > this.mandate.perPaymentCap) {
      const reason = `Metal mandate: amount ${amount} micros exceeds per-payment cap ${this.mandate.perPaymentCap} micros`;
      this.ledger.log(null, "mandate.blocked", { payTo, amount, reason, mandateId: this.mandate.mandateId });
      return { allowed: false, reason };
    }

    return { allowed: true };
  }

  /**
   * Summary for the dashboard dual-lock display and receipts.
   */
  status(): {
    source: "live" | "simulated";
    mandateId: string | null;
    createTx: string | null;
    bindTx: string | null;
    revokeTx: string | null;
    budget: Micros;
    perPaymentCap: Micros;
    payeeCount: number;
    bypassActive: boolean;
  } {
    return {
      source: this.gateway.source,
      mandateId: this.mandate?.mandateId ?? null,
      createTx: this.mandate?.createTx ?? null,
      bindTx: this.mandate?.bindTx ?? null,
      revokeTx: this.mandate?.revokeTx ?? null,
      budget: this.mandate?.budget ?? 0,
      perPaymentCap: this.mandate?.perPaymentCap ?? 0,
      payeeCount: this.mandate?.payees.length ?? 0,
      bypassActive: this.bypassPolicyCheck,
    };
  }
}

/**
 * Build a MandateManager from environment.
 * Live mode: needs METAL_PRIVATE_KEY + METAL_RPC_URL and MODE != mock.
 * Mock mode (or if keys missing): uses MockMandateGateway.
 */
export function mandateManagerFromEnv(
  catalog: ProviderSpec[],
  ledger: Ledger,
  env: NodeJS.ProcessEnv = process.env,
  gateway?: MandateGateway,
): MandateManager {
  if (gateway) return new MandateManager(gateway, catalog, ledger);
  if (env.METAL_PRIVATE_KEY && env.METAL_RPC_URL && env.MODE !== "mock") {
    // Live: import MetalMandateGateway lazily (requires viem + metal-pay).
    // Caller must handle async; use MetalMandateGateway.fromEnv(env) directly in live session.
    throw new Error("Use MetalMandateGateway.fromEnv(env) directly in live mode (async boundary).");
  }
  return new MandateManager(new MockMandateGateway(), catalog, ledger);
}
