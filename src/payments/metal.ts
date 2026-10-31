/**
 * Metal testnet float gateway — adapter to fill in from the Starter Kit 12 example.
 *
 * Wire each method to @metalntwx/metal-pay (and viem for wallet/balance calls).
 * Contract this adapter must keep, because the engine and the simulation rely on it:
 *
 *  - pay() is idempotent on `idempotencyKey`. If the SDK does not dedupe for you, keep a
 *    key -> txHash map (backed by the ledger) and return the stored tx on a repeat call.
 *    Use the key as (or inside) the x402 payment nonce so the provider dedupes too.
 *  - Throw TransientError when you cannot tell whether a payment settled (timeouts, dropped
 *    connections). The engine will retry with the same key, then call lookup().
 *  - lookup() must answer from chain or SDK state, not from memory alone.
 *  - Amounts arrive as integer micros of USDZ; convert to the token's decimals here only.
 */
import type { Micros } from "../money.ts";
import type { FloatGateway } from "./types.ts";

const notWired = (fn: string): never => {
  throw new Error(`MetalFloatGateway.${fn} not wired yet — see src/payments/metal.ts`);
};

export class MetalFloatGateway implements FloatGateway {
  async deposit(_amount: Micros): Promise<{ txHash: string }> {
    return notWired("deposit");
  }
  async pay(_req: { idempotencyKey: string; payTo: string; amount: Micros; asset: string }): Promise<{ txHash: string }> {
    return notWired("pay");
  }
  async lookup(_key: string): Promise<{ txHash: string; amount: Micros } | null> {
    return notWired("lookup");
  }
  async withdraw(_amount: Micros): Promise<{ txHash: string }> {
    return notWired("withdraw");
  }
  async balance(): Promise<Micros> {
    return notWired("balance");
  }
}
