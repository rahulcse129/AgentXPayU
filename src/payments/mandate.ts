/**
 * Metal mandates: an on-chain second lock that every provider payment goes THROUGH (§5.3).
 *
 * A mandate lets the agent pay from the owner's MetalAccount within limits the account itself
 * enforces on chain: a payee allowlist (the registered payTo addresses from catalog.ts), a
 * per-payment cap and a total budget. Payments are `mandate pull`s: the account checks each one
 * against the mandate before any token moves, so a bug in our own checks still cannot pay an
 * unregistered address or exceed the budget.
 *
 * Lifecycle (MandateManager drives it): open (credential + bind) when the batch's float is
 * deposited; raise the budget (credential + replace) after a hold increase succeeds; revoke when
 * the batch ends.
 *
 *  - MetalMandateGateway: LIVE. The real `metal-agent` 0.3.3 commands, as its --help documents
 *    them: `mandate credential create`, `mandate bind`, `mandate replace`, `mandate revoke`,
 *    `mandate pull`. Needs an owner MetalAccount (`metal-agent account create`).
 *  - MockMandateGateway: SIMULATED. The same four rules in memory, settling through MockMetal.
 *
 * First version by Kavisha (dbe6432); this rewrite routes payments through the mandate and uses
 * the commands metal-agent actually has.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Micros } from "../money.ts";
import { MockMetal } from "./mock-metal.ts";
import { PaymentRefused, TransientError } from "./types.ts";
import { toUsdzCents } from "./mandate-money.ts";

export interface MandatePayee {
  address: string;
  name?: string;
}

export interface MandateTerms {
  payees: MandatePayee[];
  perPaymentCap: Micros;
  budget: Micros;
  description?: string;
}

export interface MandateInfo {
  mandateId: string;
  /** Transaction that bound the mandate on the owner's account ("" when simulated). */
  bindTx: string;
  perPaymentCap: Micros;
  budget: Micros;
  payees: string[];
  revokeTx: string | null;
  source: "live" | "simulated";
}

/** The mandate refused the payment; nothing moved. */
export class MandateRefused extends PaymentRefused {
  constructor(
    message: string,
    /** Metal's reason code, e.g. payee_not_allowed (live only). */
    readonly reason?: string,
    /** The on-chain record of the refusal, when it was recorded (`--record-refusal`). */
    readonly refusalTx?: string,
  ) {
    super(message);
  }
}

export interface MandateGateway {
  readonly source: "live" | "simulated";
  /** The account payments come from (the owner's MetalAccount when live). */
  readonly payer: string;
  open(terms: MandateTerms): Promise<MandateInfo>;
  /** Raise the total budget. Spend so far carries over. */
  raiseBudget(newBudget: Micros): Promise<{ tx: string }>;
  revoke(): Promise<{ tx: string }>;
  /**
   * Pay `amount` to `payTo` under the mandate. At most once per paymentId.
   * Throws MandateRefused when the mandate says no, TransientError when the outcome is unknown.
   */
  pull(req: { paymentId: string; payTo: string; amount: Micros }): Promise<{ txHash: string }>;
  lookup(paymentId: string): Promise<{ txHash: string; amount: Micros } | null>;
}

// ------------------------------------------------------------------ simulated

/** The mandate's rules in memory, settling through MockMetal so the sim's rail checks still apply. */
export class MockMandateGateway implements MandateGateway {
  readonly source = "simulated" as const;
  readonly payer = "0x00000000000000000000000000000000000a11ce";
  private info: MandateInfo | null = null;
  private seq = 0;

  constructor(readonly metal: MockMetal = new MockMetal()) {}

  get mandate(): MandateInfo | null {
    return this.info;
  }

  async open(terms: MandateTerms): Promise<MandateInfo> {
    if (this.info && !this.info.revokeTx) throw new Error("a mandate is already open");
    this.info = {
      mandateId: `sim-mandate-${++this.seq}`,
      bindTx: "",
      perPaymentCap: terms.perPaymentCap,
      budget: terms.budget,
      payees: terms.payees.map((p) => p.address.toLowerCase()),
      revokeTx: null,
      source: "simulated",
    };
    await this.metal.deposit(terms.budget);
    return this.info;
  }

  async raiseBudget(newBudget: Micros) {
    const m = this.must();
    if (newBudget <= m.budget) throw new Error(`new budget ${newBudget} is not above ${m.budget}`);
    await this.metal.deposit(newBudget - m.budget);
    m.budget = newBudget;
    return { tx: "" };
  }

  async revoke() {
    const m = this.must();
    m.revokeTx = "";
    const left = await this.metal.balance();
    if (left > 0) await this.metal.withdraw(left);
    return { tx: "" };
  }

  async pull(req: { paymentId: string; payTo: string; amount: Micros }) {
    const prior = await this.metal.lookup(req.paymentId);
    if (prior) return this.metal.pay({ idempotencyKey: req.paymentId, payTo: req.payTo, amount: req.amount, asset: "USDZ" });
    const m = this.must();
    if (m.revokeTx !== null) throw new MandateRefused("Metal mandate: revoked");
    if (!m.payees.includes(req.payTo.toLowerCase())) throw new MandateRefused(`Metal mandate: payee ${req.payTo} is not on the mandate's payee list`);
    if (req.amount > m.perPaymentCap) throw new MandateRefused(`Metal mandate: ${req.amount} micros exceeds the per-payment cap ${m.perPaymentCap}`);
    if (this.metal.totalSettled() + req.amount > m.budget) throw new MandateRefused(`Metal mandate: payment would exceed the budget ${m.budget}`);
    return this.metal.pay({ idempotencyKey: req.paymentId, payTo: req.payTo, amount: req.amount, asset: "USDZ" });
  }

  lookup(paymentId: string) {
    return this.metal.lookup(paymentId);
  }

  private must(): MandateInfo {
    if (!this.info) throw new MandateRefused("Metal mandate: none open");
    return this.info;
  }
}

// ------------------------------------------------------------------ live (metal-agent CLI)

export interface MetalMandateConfig {
  /** The owner's MetalAccount address (`metal-agent account create` prints it). */
  principal: string;
  /** Owner key file: signs credentials and pays the gas of bind / replace / revoke. */
  ownerKeyFile: string;
  rpcUrl: string;
  /** Where credentials and the mandate key live. Holds a private key: keep it outside the repo. */
  workDir: string;
  /**
   * Record each refusal on chain (`--record-refusal`, gas from the owner key), so "the mandate
   * refused" is a transaction anyone can check. Refusals are rare: the rogue, the mandate test.
   */
  recordRefusals?: boolean;
}

const require = createRequire(import.meta.url);
const CLI = join(dirname(require.resolve("@metalntwx/metal-agent/package.json")), "dist", "index.js");

/** `key value` lines, as every metal-agent command prints them. */
export function parseCliOutput(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf(" ");
    if (i > 0 && !m.has(line.slice(0, i))) m.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return m;
}

/** The transaction hash a command printed, or "" when there is none (never a partial value). */
export function txOf(kv: Map<string, string>, out: string): string {
  const isHash = (s?: string) => (s && /^0x[0-9a-fA-F]{64}$/.test(s) ? s : undefined);
  return isHash(kv.get("transaction")?.split(/\s/)[0]) ?? isHash(kv.get("tx")?.split(/\s/)[0]) ?? out.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? "";
}

export class MetalMandateGateway implements MandateGateway {
  readonly source = "live" as const;
  private info: MandateInfo | null = null;
  private credential = "";
  private mandateKeyFile = "";
  private n = 0;
  /** paymentId → what was asked, so lookup can re-ask the CLI (which pays at most once per id). */
  private readonly asked = new Map<string, { payTo: string; amount: Micros }>();

  constructor(private readonly cfg: MetalMandateConfig) {
    mkdirSync(cfg.workDir, { recursive: true });
  }

  get payer(): string {
    return this.cfg.principal;
  }

  /** METAL_OWNER_ACCOUNT, METAL_OWNER_KEY_FILE, METAL_RPC_URL, METAL_MANDATE_DIR. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MetalMandateGateway {
    const principal = env.METAL_OWNER_ACCOUNT?.trim();
    const ownerKeyFile = env.METAL_OWNER_KEY_FILE?.trim();
    const rpcUrl = env.METAL_RPC_URL?.trim();
    if (!principal || !ownerKeyFile || !rpcUrl) {
      throw new Error("live mandates need METAL_OWNER_ACCOUNT, METAL_OWNER_KEY_FILE and METAL_RPC_URL (see `metal-agent account create`)");
    }
    const home = env.USERPROFILE ?? env.HOME ?? ".";
    return new MetalMandateGateway({
      principal,
      ownerKeyFile,
      rpcUrl,
      workDir: env.METAL_MANDATE_DIR?.trim() || join(home, ".metal-agent", "margin-mandates"),
      recordRefusals: env.METAL_RECORD_REFUSALS !== "0",
    });
  }

  private run(args: string[]): Promise<{ code: number; out: string; kv: Map<string, string> }> {
    const full = [CLI, ...args, "--network", "testnet", ...(args[1] === "credential" ? [] : ["--rpc-url", this.cfg.rpcUrl])];
    return new Promise((resolve) => {
      execFile(process.execPath, full, { timeout: 180_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
        const out = `${stdout}\n${stderr}`.replaceAll(this.cfg.rpcUrl, "<rpc>");
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, out, kv: parseCliOutput(out) });
      });
    });
  }

  private async writeCredential(terms: MandateTerms, file: string, reuseKey?: string) {
    const args = [
      "mandate", "credential", "create",
      "--principal", this.cfg.principal,
      "--cap", toUsdzCents(terms.perPaymentCap),
      "--budget", toUsdzCents(terms.budget),
      "--out", file,
      "--key", this.cfg.ownerKeyFile,
      ...(terms.description ? ["--description", terms.description] : []),
      ...terms.payees.flatMap((p) => ["--payee", p.name ? `${p.address},${p.name}` : p.address]),
      ...(reuseKey ? ["--mandate-key-file", reuseKey] : []),
    ];
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`metal-agent mandate credential create failed: ${r.out.trim().slice(0, 400)}`);
    const id = r.kv.get("mandate");
    if (!id) throw new Error(`credential create printed no mandate id: ${r.out.slice(0, 300)}`);
    return { mandateId: id, keyFile: r.kv.get("mandate-key-file")?.split(" ")[0] ?? file.replace(/\.json$/, ".key.json") };
  }

  private terms: MandateTerms | null = null;

  async open(terms: MandateTerms): Promise<MandateInfo> {
    if (this.info && !this.info.revokeTx) throw new Error("a mandate is already open");
    const file = join(this.cfg.workDir, `margin-${Date.now()}-${++this.n}.json`);
    const { mandateId, keyFile } = await this.writeCredential(terms, file);
    const bound = await this.run(["mandate", "bind", "--credential", file, "--key", this.cfg.ownerKeyFile]);
    if (bound.code !== 0) throw new Error(`metal-agent mandate bind failed: ${bound.out.trim().slice(0, 400)}`);
    this.credential = file;
    this.mandateKeyFile = keyFile;
    this.terms = terms;
    this.info = {
      mandateId,
      bindTx: txOf(bound.kv, bound.out),
      perPaymentCap: terms.perPaymentCap,
      budget: terms.budget,
      payees: terms.payees.map((p) => p.address.toLowerCase()),
      revokeTx: null,
      source: "live",
    };
    return this.info;
  }

  async raiseBudget(newBudget: Micros) {
    if (!this.info || !this.terms) throw new Error("no mandate open");
    // A wider credential under the same mandate key replaces the old one in one transaction;
    // what was spent carries over into the new budget.
    const file = join(this.cfg.workDir, `margin-${Date.now()}-${++this.n}.json`);
    const terms = { ...this.terms, budget: newBudget };
    const { mandateId } = await this.writeCredential(terms, file, this.mandateKeyFile);
    const r = await this.run(["mandate", "replace", "--credential", file, "--replaces", this.credential, "--key", this.cfg.ownerKeyFile]);
    if (r.code !== 0) throw new Error(`metal-agent mandate replace failed: ${r.out.trim().slice(0, 400)}`);
    this.credential = file;
    this.terms = terms;
    this.info = { ...this.info, mandateId, budget: newBudget };
    return { tx: txOf(r.kv, r.out) };
  }

  async revoke() {
    if (!this.info) throw new Error("no mandate open");
    const r = await this.run(["mandate", "revoke", "--credential", this.credential, "--key", this.cfg.ownerKeyFile]);
    if (r.code !== 0) throw new Error(`metal-agent mandate revoke failed: ${r.out.trim().slice(0, 400)}`);
    this.info.revokeTx = txOf(r.kv, r.out);
    return { tx: this.info.revokeTx };
  }

  async pull(req: { paymentId: string; payTo: string; amount: Micros }) {
    if (!this.credential) throw new MandateRefused("Metal mandate: none open");
    const amount = toUsdzCents(req.amount);
    this.asked.set(req.paymentId, { payTo: req.payTo, amount: req.amount });
    const args = [
      "mandate", "pull", "--credential", this.credential, "--to", req.payTo, "--amount", amount,
      "--payment-id", req.paymentId, "--mandate-key-file", this.mandateKeyFile,
    ];
    const r = await this.run(args);
    // Exit codes from `metal-agent mandate pull --help`: 0 paid, 1 refused or error, 3 pending, 4 held in the payee's escrow.
    if (r.code === 0 || r.code === 4) return { txHash: txOf(r.kv, r.out) };
    if (r.code === 3) throw new TransientError(`mandate pull pending: ${r.out.trim().slice(0, 200)}`);
    if (r.kv.get("outcome")?.startsWith("refused")) {
      // e.g. "reason payee_not_allowed (...)": Metal checked the payout against the account's mandate.
      const reason = r.kv.get("reason") ?? "refused";
      const code = reason.split(" ")[0]!;
      let refusalTx = "";
      if (this.cfg.recordRefusals) {
        const rec = await this.run([...args, "--key", this.cfg.ownerKeyFile, "--record-refusal"]);
        refusalTx = txOf(rec.kv, rec.out);
      }
      throw new MandateRefused(
        `Metal mandate refused: ${reason}${refusalTx ? `; refusal recorded on chain ${refusalTx}` : "; not sent"}`,
        code,
        refusalTx || undefined,
      );
    }
    // Any other failure may or may not have reached the chain; the same payment id pays at most once.
    throw new TransientError(`mandate pull failed: ${r.out.trim().slice(0, 300)}`);
  }

  async lookup(paymentId: string) {
    const asked = this.asked.get(paymentId);
    if (!asked) return null;
    // Re-asking with the same id reports an earlier payout instead of paying again (CLI help).
    try {
      const { txHash } = await this.pull({ paymentId, ...asked });
      return { txHash, amount: asked.amount };
    } catch {
      return null;
    }
  }
}
