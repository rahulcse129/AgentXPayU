/**
 * Metal testnet float gateway: pays providers with x402 `exact` payments in USDZ, settled by
 * Metal's x402 facilitator. LIVE on testnet (first engine payments recorded in docs/STATUS.md).
 *
 * Contract the engine and the simulation rely on, and how it is kept here:
 *  - pay() is idempotent on `idempotencyKey`. The ERC-3009 nonce IS the key: nonce =
 *    keccak256("margin:" + key). The USDZ contract accepts each (payer, nonce) once, so a retry,
 *    a crash-and-restart or a duplicate call can never move money twice, whatever this process
 *    remembers.
 *  - TransientError when we cannot tell whether a payment settled (facilitator timeout, network
 *    error). The engine retries with the same key (same nonce) and then calls lookup().
 *  - lookup() answers from chain: USDZ.authorizationState(payer, nonce), and the transaction from
 *    the AuthorizationUsed(payer, nonce) event.
 *  - Amounts arrive as integer micros; USDZ has 18 decimals, so base units = micros × 10^12, exact.
 *
 * Payload format: the same EIP-3009 TransferWithAuthorization that @x402/evm's ExactEvmScheme
 * builds (validAfter "0", validBefore now + maxTimeoutSeconds, EIP-712 domain from the
 * requirement's extra { name, version }), except the nonce is derived from the key instead of
 * random. Requirements match what metal-pay's metalUsd parser issues.
 *
 * Float: on testnet the agent wallet is the float. deposit() and withdraw() are accounting
 * against the wallet balance (checked on chain), not transfers, and return txHash "". With
 * mandates (§5.3) the agent will pay from the owner's MetalAccount instead.
 *
 * Clock: authorizations are only valid until validBefore, judged by chain time. A local clock
 * minutes off makes the facilitator refuse with `authorization_window` (seen 2026-11-01), so
 * the first pay() compares the local clock with the latest block and refuses if they disagree.
 */
import { createPublicClient, erc20Abi, getAddress, http, keccak256, parseAbi, parseAbiItem, toHex, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FacilitatorTimeoutError } from "@x402/core/server";
import { METAL_NETWORKS, USDZ } from "@metalntwx/metal-pay";
import type { Micros } from "../money.ts";
import { InsufficientFloat, TransientError, type FloatGateway } from "./types.ts";

export const METAL_TESTNET = "eip155:63825";
export const METAL_TESTNET_CHAIN_ID = 63825;
const BASE_PER_MICRO = 10n ** BigInt(USDZ.decimals - 6);

export const toBaseUnits = (m: Micros): bigint => BigInt(m) * BASE_PER_MICRO;
export function fromBaseUnits(b: bigint): Micros {
  if (b % BASE_PER_MICRO !== 0n) throw new Error(`USDZ amount ${b} is not a whole number of micros`);
  return Number(b / BASE_PER_MICRO);
}

/** The deterministic ERC-3009 nonce for an idempotency key. */
export const nonceFor = (key: string): Hex => keccak256(toHex(`margin:${key}`));

const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const AUTH_STATE_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

// ------------------------------------------------------------------ the chain and facilitator, behind small seams

/** What the gateway reads from chain. ViemChain is the real one; tests use a fake. */
export interface MetalChain {
  chainId(): Promise<number>;
  latestBlockTime(): Promise<number>;
  balanceOf(address: Hex): Promise<bigint>;
  authorizationUsed(payer: Hex, nonce: Hex): Promise<boolean>;
  /** The settlement of (payer, nonce): its transaction and the USDZ the payer sent in it. */
  findSettlement(payer: Hex, nonce: Hex): Promise<{ txHash: Hex; value: bigint } | null>;
}

export interface Settler {
  settle(paymentPayload: Record<string, unknown>, requirements: Record<string, unknown>): Promise<{
    success: boolean;
    transaction?: string;
    errorReason?: string;
    errorMessage?: string;
  }>;
}

export class ViemChain implements MetalChain {
  private readonly client: PublicClient;
  constructor(
    rpcUrl: string,
    private readonly lookbackBlocks = 50_000n,
  ) {
    this.client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }) });
  }
  chainId() {
    return this.client.getChainId();
  }
  async latestBlockTime() {
    return Number((await this.client.getBlock()).timestamp);
  }
  balanceOf(address: Hex) {
    return this.client.readContract({ address: USDZ.address, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  }
  authorizationUsed(payer: Hex, nonce: Hex) {
    return this.client.readContract({ address: USDZ.address, abi: AUTH_STATE_ABI, functionName: "authorizationState", args: [payer, nonce] });
  }
  async findSettlement(payer: Hex, nonce: Hex) {
    const head = await this.client.getBlockNumber();
    const logs = await this.client.getLogs({
      address: USDZ.address,
      event: AUTHORIZATION_USED,
      args: { authorizer: payer, nonce },
      fromBlock: head > this.lookbackBlocks ? head - this.lookbackBlocks : 0n,
      toBlock: head,
    });
    const txHash = logs[0]?.transactionHash;
    if (!txHash) return null;
    const receipt = await this.client.getTransactionReceipt({ hash: txHash });
    let value = 0n;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== USDZ.address.toLowerCase() || l.topics[0] !== TRANSFER_TOPIC) continue;
      if (l.topics[1] && getAddress(`0x${l.topics[1].slice(26)}`) === getAddress(payer)) value += BigInt(l.data);
    }
    return { txHash, value };
  }
}

const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

// ------------------------------------------------------------------ the gateway

export interface MetalGatewayOptions {
  privateKey: Hex;
  chain: MetalChain;
  settler: Settler;
  /** Seconds an authorization stays valid after signing (validBefore = now + this). */
  maxTimeoutSeconds?: number;
  /** Refuse to pay when the local clock and the chain disagree by more than this. */
  maxClockSkewSeconds?: number;
  now?: () => number;
}

interface Paid {
  payTo: string;
  amount: Micros;
  txHash: string;
}

export class MetalFloatGateway implements FloatGateway {
  readonly source = "live" as const;
  private readonly account: PrivateKeyAccount;
  private readonly paid = new Map<string, Paid>();
  private allocated: Micros = 0;
  private clockChecked = false;

  constructor(private readonly o: MetalGatewayOptions) {
    this.account = privateKeyToAccount(o.privateKey);
  }

  /** METAL_PRIVATE_KEY, METAL_RPC_URL; facilitator from metal-pay's testnet network entry. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): MetalFloatGateway {
    const pk = env.METAL_PRIVATE_KEY?.trim();
    const rpc = env.METAL_RPC_URL?.trim();
    if (!pk || !rpc) throw new Error("set METAL_PRIVATE_KEY and METAL_RPC_URL (Metal testnet)");
    const facilitator = new HTTPFacilitatorClient({ url: METAL_NETWORKS.testnet.facilitatorUrl, timeoutMs: 60_000 });
    return new MetalFloatGateway({
      privateKey: (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex,
      chain: new ViemChain(rpc),
      settler: facilitator as unknown as Settler,
    });
  }

  get address(): Hex {
    return this.account.address;
  }

  /** Refuses unless the RPC is Metal testnet and the local clock agrees with the chain. */
  async preflight(): Promise<{ chainId: number; skewSeconds: number }> {
    const chainId = await this.o.chain.chainId();
    if (chainId !== METAL_TESTNET_CHAIN_ID) throw new Error(`METAL_RPC_URL is chain ${chainId}, not Metal testnet ${METAL_TESTNET_CHAIN_ID}`);
    const skewSeconds = Math.round((this.o.now ?? Date.now)() / 1000 - (await this.o.chain.latestBlockTime()));
    const limit = this.o.maxClockSkewSeconds ?? 30;
    if (Math.abs(skewSeconds) > limit) {
      throw new Error(
        `local clock is ${skewSeconds}s off Metal testnet (limit ${limit}s); payments would be refused as outside their authorization window. Sync the system clock.`,
      );
    }
    this.clockChecked = true;
    return { chainId, skewSeconds };
  }

  async deposit(amount: Micros): Promise<{ txHash: string }> {
    const wallet = await this.o.chain.balanceOf(this.address);
    if (toBaseUnits(this.allocated + amount) > wallet + toBaseUnits(this.spent())) {
      throw new InsufficientFloat(`agent wallet holds ${fromBaseUnitsFloor(wallet)} micros of USDZ, cannot allocate ${amount} more`);
    }
    this.allocated += amount;
    return { txHash: "" };
  }

  async withdraw(amount: Micros): Promise<{ txHash: string }> {
    if (amount > (await this.balance())) throw new InsufficientFloat(`withdraw ${amount} > float left ${await this.balance()}`);
    this.allocated -= amount;
    return { txHash: "" };
  }

  async balance(): Promise<Micros> {
    return this.allocated - this.spent();
  }

  async pay(req: { idempotencyKey: string; payTo: string; amount: Micros; asset: string }): Promise<{ txHash: string }> {
    const { idempotencyKey: key, payTo, amount, asset } = req;
    if (asset !== "USDZ") throw new Error(`Metal gateway pays in USDZ only, asked for ${asset}`);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error(`invalid amount ${amount}`);

    const prior = this.paid.get(key);
    if (prior) {
      if (prior.amount !== amount || prior.payTo.toLowerCase() !== payTo.toLowerCase()) {
        throw new Error(`payment ${key} replayed with a different payload`);
      }
      return { txHash: prior.txHash };
    }

    // Already settled (a previous process, or an answer we lost)? Then this call is the retry.
    const nonce = nonceFor(key);
    const settled = await this.settledOnChain(key, nonce, { payTo, amount });
    if (settled) return { txHash: settled.txHash };

    if (!this.clockChecked) await this.preflight();
    if (amount > (await this.balance())) throw new InsufficientFloat(`float ${await this.balance()} < ${amount}`);

    const requirements = {
      scheme: "exact",
      network: METAL_TESTNET,
      asset: USDZ.address,
      amount: toBaseUnits(amount).toString(),
      payTo: getAddress(payTo),
      maxTimeoutSeconds: this.o.maxTimeoutSeconds ?? 120,
      extra: { name: USDZ.name, version: USDZ.version, primaryType: "TransferWithAuthorization" },
    };
    const authorization = {
      from: this.address,
      to: requirements.payTo,
      value: requirements.amount,
      validAfter: "0",
      validBefore: String(Math.floor((this.o.now ?? Date.now)() / 1000) + requirements.maxTimeoutSeconds),
      nonce,
    };
    const signature = await this.account.signTypedData({
      domain: { name: USDZ.name, version: USDZ.version, chainId: METAL_TESTNET_CHAIN_ID, verifyingContract: USDZ.address },
      types: AUTH_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce,
      },
    });
    const paymentPayload = { x402Version: 2, accepted: requirements, payload: { authorization, signature } };

    let result: Awaited<ReturnType<Settler["settle"]>>;
    try {
      result = await this.o.settler.settle(paymentPayload, requirements);
    } catch (e) {
      // A timeout or dropped connection may still have settled. Same key next time = same nonce.
      if (e instanceof FacilitatorTimeoutError || isNetworkError(e)) throw new TransientError(`facilitator: ${String(e)}`);
      throw new TransientError(`facilitator error, outcome unknown: ${String(e)}`);
    }
    if (result.success && result.transaction) {
      this.paid.set(key, { payTo, amount, txHash: result.transaction });
      return { txHash: result.transaction };
    }
    // Refused. If the nonce is used anyway (a race with an earlier attempt), that settlement stands.
    const raced = await this.settledOnChain(key, nonce, { payTo, amount });
    if (raced) return { txHash: raced.txHash };
    const why = `${result.errorReason ?? "refused"}${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
    if (/insufficient|balance/i.test(why)) throw new InsufficientFloat(`facilitator refused: ${why}`);
    throw new PaymentRefused(`facilitator refused, nothing was paid: ${why}`);
  }

  async lookup(key: string): Promise<{ txHash: string; amount: Micros } | null> {
    const known = this.paid.get(key);
    const nonce = nonceFor(key);
    if (!(await this.o.chain.authorizationUsed(this.address, nonce))) return null;
    const s = await this.o.chain.findSettlement(this.address, nonce);
    if (s) return { txHash: s.txHash, amount: fromBaseUnits(s.value) };
    // Used on chain but older than our log window: the chain is the authority that it settled.
    return known ? { txHash: known.txHash, amount: known.amount } : null;
  }

  private async settledOnChain(key: string, nonce: Hex, expect: { payTo: string; amount: Micros }): Promise<Paid | null> {
    if (!(await this.o.chain.authorizationUsed(this.address, nonce))) return null;
    const s = await this.o.chain.findSettlement(this.address, nonce);
    const amount = s ? fromBaseUnits(s.value) : expect.amount;
    if (amount !== expect.amount) throw new Error(`payment ${key} settled on chain for ${amount}, asked to pay ${expect.amount}`);
    const p: Paid = { payTo: expect.payTo, amount, txHash: s?.txHash ?? "" };
    this.paid.set(key, p);
    return p;
  }

  private spent(): Micros {
    let s = 0;
    for (const p of this.paid.values()) s += p.amount;
    return s;
  }
}

/** The facilitator turned the payment down for a reason that moved nothing (expired window, bad signature...). */
export class PaymentRefused extends Error {}

function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|socket|network/i.test(String(e));
}

const fromBaseUnitsFloor = (b: bigint): Micros => Number(b / BASE_PER_MICRO);
