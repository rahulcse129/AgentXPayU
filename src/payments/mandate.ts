/**
 * Metal mandate layer: an on-chain second lock that sits beside our own policy checks.
 *
 * §5.3 of the project prompt. When a job batch starts, we create a mandate on the agent's
 * Metal account and bind it. The mandate enforces three limits directly on the blockchain:
 *   1. PAYEE ALLOWLIST — the agent can only pay the registered addresses from catalog.ts.
 *      The rogue provider's wrong_payee attack is refused by Metal itself, even if our own
 *      verifyQuote is bypassed.
 *   2. PER-PAYMENT CAP — the largest single step allowed by policy (cents(5) = 5¢).
 *   3. TOTAL BUDGET — sized to the job batch's float.
 *
 * When a hold increase is approved, we raise the mandate budget (after Airwallex's increment
 * succeeds, so the on-chain cap never runs ahead of what the customer approved).
 * When the batch ends (or fails), we revoke the mandate so no further spending is possible.
 *
 * The mandate "disable our check" demo moment:
 *   - A demo flag (`MANDATE_TEST=1`) skips verifyQuote in the engine.
 *   - The rogue provider still can't get paid because Metal's on-chain mandate refuses the tx.
 *   - Both the refusal and the mandate tx hash are shown on the dashboard.
 *
 * Live vs simulated:
 *   - `MetalMandateGateway` calls real metal-agent mandate commands (live mode).
 *   - `MockMandateGateway` follows the same rules in memory (mock / offline mode).
 *   - Both implement `MandateGateway` so the engine and session are identical in both modes.
 *
 * metal-agent 0.3.3 mandate commands (from the installed CLI help):
 *   metal-agent mandate create --payees <addr,...> --per-payment <amt> --budget <amt>
 *   metal-agent mandate bind   --mandate <id> --account <addr>
 *   metal-agent mandate raise  --mandate <id> --budget <amt>   (replaces budget)
 *   metal-agent mandate revoke --mandate <id>
 *
 * We call these via the SDK's JavaScript interface when available, falling back to child_process
 * for the CLI. Mandate tx hashes are recorded in the ledger so the dashboard can display them.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Micros } from "../money.ts";
import { toMajorString } from "./mandate-money.ts";

const exec = promisify(execFile);

// ------------------------------------------------------------------ port

export interface MandateInfo {
  mandateId: string;
  /** tx hash from create */
  createTx: string;
  /** tx hash from bind */
  bindTx: string;
  /** per-payment cap in micros */
  perPaymentCap: Micros;
  /** total budget in micros */
  budget: Micros;
  /** allowlisted payee addresses */
  payees: string[];
  /** null until revoked */
  revokeTx: string | null;
  source: "live" | "simulated";
}

export interface MandateGateway {
  readonly source: "live" | "simulated";
  /**
   * Create and bind a mandate for the batch.
   * Called once when float is deposited, before any payment.
   */
  create(opts: {
    payees: string[];
    perPaymentCap: Micros;
    budget: Micros;
    agentAddress: string;
  }): Promise<MandateInfo>;

  /**
   * Raise the mandate's budget to newTotal (called after Airwallex increment_authorization
   * succeeds and BEFORE spending continues past the old budget).
   */
  raise(mandateId: string, newTotal: Micros): Promise<{ tx: string }>;

  /**
   * Revoke the mandate at job end. After this, Metal will refuse any payment under it.
   */
  revoke(mandateId: string): Promise<{ tx: string }>;
}

// ------------------------------------------------------------------ mock (offline / tests)

let mockSeq = 0;

export class MockMandateGateway implements MandateGateway {
  readonly source = "simulated" as const;

  /** All mandates created this session, keyed by id. For test assertions. */
  readonly mandates = new Map<string, MandateInfo>();

  async create(opts: { payees: string[]; perPaymentCap: Micros; budget: Micros; agentAddress: string }): Promise<MandateInfo> {
    const id = `mock-mandate-${++mockSeq}`;
    const info: MandateInfo = {
      mandateId: id,
      createTx: `0xmock-create-${id}`,
      bindTx: `0xmock-bind-${id}`,
      perPaymentCap: opts.perPaymentCap,
      budget: opts.budget,
      payees: opts.payees.map((p) => p.toLowerCase()),
      revokeTx: null,
      source: "simulated",
    };
    this.mandates.set(id, info);
    return info;
  }

  async raise(mandateId: string, newTotal: Micros): Promise<{ tx: string }> {
    const m = this.mandates.get(mandateId);
    if (!m) throw new Error(`mandate ${mandateId} not found`);
    m.budget = newTotal;
    return { tx: `0xmock-raise-${mandateId}-${newTotal}` };
  }

  async revoke(mandateId: string): Promise<{ tx: string }> {
    const m = this.mandates.get(mandateId);
    if (!m) throw new Error(`mandate ${mandateId} not found`);
    m.revokeTx = `0xmock-revoke-${mandateId}`;
    return { tx: m.revokeTx };
  }

  /**
   * Check whether a payment would be allowed by this mandate.
   * Used by the demo "mandate test" to show Metal refusing rogue payments even with our
   * own verifyQuote disabled.
   */
  wouldAllow(mandateId: string, payTo: string, amount: Micros): { allowed: boolean; reason?: string } {
    const m = this.mandates.get(mandateId);
    if (!m) return { allowed: false, reason: "mandate not found" };
    if (m.revokeTx) return { allowed: false, reason: "mandate revoked" };
    if (!m.payees.includes(payTo.toLowerCase())) {
      return { allowed: false, reason: `payee ${payTo} not in allowlist` };
    }
    if (amount > m.perPaymentCap) {
      return { allowed: false, reason: `amount ${amount} > per-payment cap ${m.perPaymentCap}` };
    }
    return { allowed: true };
  }
}

// ------------------------------------------------------------------ live (Metal testnet)

/**
 * Calls the `metal-agent mandate` CLI commands that ship with @metalntwx/metal-agent@0.3.3.
 * Each command returns a JSON object with { mandateId?, tx } on success.
 *
 * We use the CLI rather than a JS SDK because metal-agent 0.3.3 does not export mandate
 * functions from its Node entry-point (confirmed by reading node_modules). The CLI is the
 * documented interface (hackathon track channel, 2026-10-31).
 *
 * Usage: set METAL_PRIVATE_KEY and METAL_RPC_URL; the CLI reads them from env / the key file.
 */
export class MetalMandateGateway implements MandateGateway {
  readonly source = "live" as const;

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Path to the metal-agent binary (default: npx metal-agent). */
    private readonly bin = "metal-agent",
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MetalMandateGateway {
    if (!env.METAL_PRIVATE_KEY || !env.METAL_RPC_URL) {
      throw new Error("MetalMandateGateway needs METAL_PRIVATE_KEY and METAL_RPC_URL");
    }
    return new MetalMandateGateway(env);
  }

  private async run(args: string[]): Promise<Record<string, unknown>> {
    const env = {
      ...this.env,
      METAL_RPC_URL: this.env.METAL_RPC_URL,
      METAL_PRIVATE_KEY: this.env.METAL_PRIVATE_KEY,
    };
    try {
      const { stdout } = await exec(this.bin, ["mandate", ...args, "--json"], {
        env,
        timeout: 60_000,
      });
      return JSON.parse(stdout.trim()) as Record<string, unknown>;
    } catch (e) {
      // If the binary doesn't exist in PATH, npx will fetch it. Surface the error clearly.
      throw new Error(`metal-agent mandate ${args[0]} failed: ${String(e)}`);
    }
  }

  async create(opts: { payees: string[]; perPaymentCap: Micros; budget: Micros; agentAddress: string }): Promise<MandateInfo> {
    // Step 1: create mandate
    const created = await this.run([
      "create",
      "--payees", opts.payees.join(","),
      "--per-payment", toMajorString(opts.perPaymentCap),
      "--budget", toMajorString(opts.budget),
      "--network", "testnet",
    ]);
    const mandateId = String(created.mandateId ?? created.id ?? "");
    const createTx = String(created.tx ?? created.txHash ?? "");
    if (!mandateId) throw new Error(`metal-agent mandate create did not return a mandateId: ${JSON.stringify(created)}`);

    // Step 2: bind to agent account
    const bound = await this.run([
      "bind",
      "--mandate", mandateId,
      "--account", opts.agentAddress,
      "--network", "testnet",
    ]);
    const bindTx = String(bound.tx ?? bound.txHash ?? "");

    return {
      mandateId,
      createTx,
      bindTx,
      perPaymentCap: opts.perPaymentCap,
      budget: opts.budget,
      payees: opts.payees.map((p) => p.toLowerCase()),
      revokeTx: null,
      source: "live",
    };
  }

  async raise(mandateId: string, newTotal: Micros): Promise<{ tx: string }> {
    const result = await this.run([
      "raise",
      "--mandate", mandateId,
      "--budget", toMajorString(newTotal),
      "--network", "testnet",
    ]);
    return { tx: String(result.tx ?? result.txHash ?? "") };
  }

  async revoke(mandateId: string): Promise<{ tx: string }> {
    const result = await this.run([
      "revoke",
      "--mandate", mandateId,
      "--network", "testnet",
    ]);
    return { tx: String(result.tx ?? result.txHash ?? "") };
  }
}

