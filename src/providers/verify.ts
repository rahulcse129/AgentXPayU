/**
 * How a provider decides a buyer really paid before it delivers.
 *
 * The buyer presents { txHash, key } in X-PAYMENT. ChainPaymentVerifier reads that transaction
 * from Metal testnet and accepts it only if it succeeded, carries an x402 settlement
 * (USDZ AuthorizationUsed), moved at least the quoted price in USDZ to this provider's
 * registered address, and has not already been used to buy something from this server.
 */
import { createPublicClient, getAddress, http, keccak256, toHex, type Hex, type PublicClient } from "viem";
import { USDZ } from "@metalntwx/metal-pay";
import type { Micros } from "../money.ts";
import { toBaseUnits } from "../payments/metal.ts";

export interface PaymentProof {
  txHash: string;
  key: string;
}

export interface PaymentVerifier {
  readonly source: "live" | "simulated";
  verify(proof: PaymentProof, expect: { payTo: string; amount: Micros }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** The demo mock: trusts the header. Labelled SIMULATED wherever it is used. */
export class TrustingVerifier implements PaymentVerifier {
  readonly source = "simulated" as const;
  async verify() {
    return { ok: true as const };
  }
}

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));
const AUTHORIZATION_USED_TOPIC = keccak256(toHex("AuthorizationUsed(address,bytes32)"));

export class ChainPaymentVerifier implements PaymentVerifier {
  readonly source = "live" as const;
  private readonly client: PublicClient;
  /** Transactions already exchanged for work. One payment buys one delivery. */
  private readonly redeemed = new Set<string>();

  constructor(rpcUrl: string) {
    this.client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  }

  async verify(proof: PaymentProof, expect: { payTo: string; amount: Micros }) {
    const tx = proof.txHash.toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(tx)) return { ok: false as const, reason: "X-PAYMENT has no transaction hash" };
    if (this.redeemed.has(tx)) return { ok: false as const, reason: `transaction ${tx} was already used to buy work` };
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: tx as Hex });
    } catch (e) {
      return { ok: false as const, reason: `transaction not found on Metal testnet: ${String((e as Error).message).split("\n")[0]}` };
    }
    if (receipt.status !== "success") return { ok: false as const, reason: "transaction reverted" };
    const usdz = receipt.logs.filter((l) => l.address.toLowerCase() === USDZ.address.toLowerCase());
    if (!usdz.some((l) => l.topics[0] === AUTHORIZATION_USED_TOPIC)) return { ok: false as const, reason: "not an x402 settlement (no AuthorizationUsed)" };
    const payee = getAddress(expect.payTo);
    let received = 0n;
    for (const l of usdz) {
      if (l.topics[0] !== TRANSFER_TOPIC || !l.topics[2]) continue;
      if (getAddress(`0x${l.topics[2].slice(26)}`) === payee) received += BigInt(l.data);
    }
    const due = toBaseUnits(expect.amount);
    if (received < due) return { ok: false as const, reason: `paid ${received} base units to ${payee}, price is ${due}` };
    this.redeemed.add(tx);
    return { ok: true as const };
  }
}
