/**
 * Signers for running totals.
 *
 * Eip712Signer is the real thing: an EIP-712 typed-data signature with viem, verified by
 * recovering the signer address. It costs ~2 ms to sign and ~14 ms to verify, which is too
 * slow for 140k payments across 10,000 simulated runs, so the bulk of the sim uses HmacSigner
 * (same message, same accept/reject behaviour, keyed SHA-256). A sample of sim runs and the
 * demo use Eip712Signer, and test/clearing.test.ts covers it directly.
 */
import { createHmac } from "node:crypto";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Micros } from "../money.ts";
import type { Hex } from "./port.ts";

export interface RunningTotalMessage {
  jobKey: string;
  payee: string;
  cumulative: Micros;
  epoch: number;
}

export interface RunningTotalSigner {
  readonly kind: "eip712" | "hmac";
  sign(m: RunningTotalMessage): Promise<Hex>;
  verify(m: RunningTotalMessage, signature: Hex): Promise<boolean>;
}

/** Metal testnet is eip155:63825. The emulator has no contract, so the domain names no verifyingContract. */
export const CLEARING_DOMAIN = { name: "Margin Clearing Emulator", version: "1", chainId: 63825 } as const;

export const RUNNING_TOTAL_TYPES = {
  RunningTotal: [
    { name: "jobKey", type: "string" },
    { name: "payee", type: "address" },
    { name: "cumulative", type: "uint256" },
    { name: "epoch", type: "uint64" },
  ],
} as const;

const typed = (m: RunningTotalMessage) => ({
  domain: CLEARING_DOMAIN,
  types: RUNNING_TOTAL_TYPES,
  primaryType: "RunningTotal" as const,
  message: { jobKey: m.jobKey, payee: m.payee as Hex, cumulative: BigInt(m.cumulative), epoch: BigInt(m.epoch) },
});

export class Eip712Signer implements RunningTotalSigner {
  readonly kind = "eip712";
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Hex {
    return this.account.address;
  }

  sign(m: RunningTotalMessage): Promise<Hex> {
    return this.account.signTypedData(typed(m));
  }

  async verify(m: RunningTotalMessage, signature: Hex): Promise<boolean> {
    try {
      const who = await recoverTypedDataAddress({ ...typed(m), signature });
      return who.toLowerCase() === this.account.address.toLowerCase();
    } catch {
      return false;
    }
  }
}

export class HmacSigner implements RunningTotalSigner {
  readonly kind = "hmac";
  constructor(private readonly secret = "margin-sim") {}

  private mac(m: RunningTotalMessage): Hex {
    const h = createHmac("sha256", this.secret);
    h.update(`${m.jobKey}|${m.payee.toLowerCase()}|${m.cumulative}|${m.epoch}`);
    return `0x${h.digest("hex")}`;
  }

  async sign(m: RunningTotalMessage): Promise<Hex> {
    return this.mac(m);
  }

  async verify(m: RunningTotalMessage, signature: Hex): Promise<boolean> {
    return this.mac(m) === signature;
  }
}

/** Anvil/Hardhat test key #1. Public and worthless; signs SIMULATED totals only. */
export const EMULATOR_TEST_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
