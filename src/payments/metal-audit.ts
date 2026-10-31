/**
 * Independent audit of live payments: re-read each transaction from Metal testnet and report
 * what USDZ actually moved from our agent to the provider. Shares no state with
 * MetalFloatGateway, so the reconciliation does not just repeat what the gateway believed.
 */
import { createPublicClient, getAddress, http, keccak256, toHex, type Hex } from "viem";
import { USDZ } from "@metalntwx/metal-pay";
import type { Micros } from "../money.ts";
import { fromBaseUnits } from "./metal.ts";

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));
export const METAL_EXPLORER_TX = "https://testnet.metalntwx.com/tx/";

export interface AuditedPayment {
  key: string;
  payTo: string;
  txHash: string;
  /** USDZ moved from the payer to payTo in that transaction, in micros. */
  amount: Micros;
  succeeded: boolean;
}

export async function auditPaymentsOnChain(
  rpcUrl: string,
  payer: string,
  payments: { key: string; payTo: string; txHash?: string }[],
): Promise<AuditedPayment[]> {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
  const from = getAddress(payer);
  const out: AuditedPayment[] = [];
  for (const p of payments) {
    if (!p.txHash) {
      out.push({ key: p.key, payTo: p.payTo, txHash: "", amount: 0, succeeded: false });
      continue;
    }
    const receipt = await client.getTransactionReceipt({ hash: p.txHash as Hex });
    const to = getAddress(p.payTo);
    let moved = 0n;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== USDZ.address.toLowerCase() || l.topics[0] !== TRANSFER_TOPIC || !l.topics[1] || !l.topics[2]) continue;
      if (getAddress(`0x${l.topics[1].slice(26)}`) === from && getAddress(`0x${l.topics[2].slice(26)}`) === to) moved += BigInt(l.data);
    }
    out.push({ key: p.key, payTo: p.payTo, txHash: p.txHash, amount: fromBaseUnits(moved), succeeded: receipt.status === "success" });
  }
  return out;
}
