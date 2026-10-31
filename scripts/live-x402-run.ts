/**
 * Live engine run on Metal testnet (§5.2): one small job, the real engine, real x402 payments.
 *
 *   npm run live:x402
 *
 * LIVE:      provider payments (MetalFloatGateway → Metal's x402 facilitator, USDZ on eip155:63825),
 *            and the providers' check that they were paid (ChainPaymentVerifier reads each tx).
 * SIMULATED: the card hold (MockAirwallex; the team's Airwallex sandbox has Payments disabled
 *            for its region) and clearing (ClearingEmulator; not available on testnet).
 *
 * Spends at most FLOAT below (testnet USDZ). After the run every ledger payment is re-read from
 * chain, independently of the gateway, and ledger paid = chain transferred = captured is checked.
 * Writes docs/live-runs/<timestamp>-engine-x402-run.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createPublicClient, getAddress, http, keccak256, toHex, type Hex } from "viem";
import { USDZ } from "@metalntwx/metal-pay";
import { cents, fmt, usd } from "../src/money.ts";
import { Ledger, MemoryStore, type LedgerEvent } from "../src/ledger/ledger.ts";
import { CATALOG, ROGUE_PROVIDER_ID } from "../src/policy/catalog.ts";
import { DEFAULT_POLICY, type Step } from "../src/policy/types.ts";
import { MockAirwallex } from "../src/payments/mock-airwallex.ts";
import { MetalFloatGateway, fromBaseUnits, nonceFor } from "../src/payments/metal.ts";
import { HttpProviders } from "../src/providers/http-client.ts";
import { createProviderServer } from "../src/providers/server.ts";
import { ChainPaymentVerifier } from "../src/providers/verify.ts";
import { Orchestrator, type JobSpec } from "../src/engine/orchestrator.ts";
import { ScriptedCustomers, TagJudge } from "../src/engine/ports.ts";
import { ClearingEmulator } from "../src/clearing/emulator.ts";
import { EMULATOR_TEST_KEY, Eip712Signer } from "../src/clearing/signer.ts";
import { describe } from "../src/agent/describe.ts";

const FLOAT = usd(0.25);
const EXPLORER = "https://testnet.metalntwx.com/tx/";
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

const JOB: JobSpec = {
  id: `live-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`,
  customer: "Live testnet check",
  hold: usd(0.25),
  steps: [
    { id: "search", kind: "search", units: 1, minTier: 2, maxLatencyMs: 5000 },
    // Tier 2: the rogue (1¢ list, overquoting ×3) is the cheapest and gets refused before any payment.
    { id: "brief", kind: "model", units: 2, minTier: 2, maxLatencyMs: 5000 } satisfies Step,
    { id: "lookup", kind: "data", units: 1, minTier: 2, maxLatencyMs: 5000 },
  ],
};

async function main() {
  const rpc = process.env.METAL_RPC_URL;
  if (!rpc || !process.env.METAL_PRIVATE_KEY) throw new Error("set METAL_PRIVATE_KEY and METAL_RPC_URL in .env");
  const metal = MetalFloatGateway.fromEnv();
  const pre = await metal.preflight();
  const chain = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) });
  const walletBefore = await chain.readContract({ address: USDZ.address, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [metal.address] });
  console.log(`Metal testnet chain ${pre.chainId} · clock skew ${pre.skewSeconds}s · agent ${metal.address} · wallet ${fromBaseUnits(walletBefore - (walletBefore % 10n ** 12n)) / 1e6} USDZ`);

  // Providers over HTTP that only deliver after reading the payment from chain.
  const server = createProviderServer({ verifier: new ChainPaymentVerifier(rpc), latencyScale: 0 });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await fetch(`${base}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: ROGUE_PROVIDER_ID, mode: "overquote", overquoteFactor: 3 }) });

  const events: LedgerEvent[] = [];
  const ledger = new Ledger(new MemoryStore(), Date.now, (e) => {
    events.push(e);
    const line = describe(e);
    if (line) console.log(line);
    if (e.type === "payment.paid") console.log(`      ↳ LIVE tx ${EXPLORER}${e.data.txHash}`);
  });
  const airwallex = new MockAirwallex();
  const clearing = new ClearingEmulator(new Eip712Signer(EMULATOR_TEST_KEY));
  const engine = new Orchestrator({
    ledger, holds: airwallex, float: metal, providers: new HttpProviders(base), judge: new TagJudge(),
    customers: new ScriptedCustomers(() => "approved"), clearing, catalog: CATALOG, policy: DEFAULT_POLICY, rng: Math.random,
  });

  let results;
  try {
    results = await engine.run([JOB], { float: FLOAT, reserve: 0, maxPayRetries: 3 });
  } finally {
    server.close();
  }

  // Independent check: re-read every paid row from chain.
  console.log("\nIndependent on-chain check of every payment:");
  const rows: string[] = [];
  let chainTotal = 0;
  let problems = 0;
  for (const p of ledger.payments(JOB.id).filter((x) => x.status === "paid")) {
    const receipt = await chain.getTransactionReceipt({ hash: p.txHash as Hex });
    let moved = 0n;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== USDZ.address.toLowerCase() || l.topics[0] !== TRANSFER_TOPIC || !l.topics[1] || !l.topics[2]) continue;
      if (getAddress(`0x${l.topics[1].slice(26)}`) === metal.address && getAddress(`0x${l.topics[2].slice(26)}`) === getAddress(p.payTo)) moved += BigInt(l.data);
    }
    const onChain = fromBaseUnits(moved);
    const nonceUsed = (await metal.lookup(p.key)) !== null;
    const ok = receipt.status === "success" && onChain === p.amount && nonceUsed;
    if (!ok) problems++;
    chainTotal += onChain;
    const line = `${ok ? "✓" : "✗"} ${p.stepId.padEnd(7)} ${p.providerId.padEnd(10)} ledger ${fmt(p.amount)}  chain ${fmt(onChain)}  nonce ${nonceFor(p.key).slice(0, 10)}… used=${nonceUsed}  ${EXPLORER}${p.txHash}`;
    console.log("  " + line);
    rows.push(line);
  }
  const refused = ledger.payments(JOB.id).filter((x) => x.status === "refused");
  const r = results[0]!;
  const ledgerPaid = ledger.spent(JOB.id);
  const reconciled = ledgerPaid === chainTotal && chainTotal === r.captured && problems === 0;
  const summary = [
    `job ${r.jobId}: ${r.status}, ${r.stepsDone}/${r.stepsTotal} steps`,
    `refused before paying: ${refused.map((x) => `${x.providerId} (${x.reason})`).join("; ") || "none"}`,
    `ledger paid ${fmt(ledgerPaid)} = on-chain transferred ${fmt(chainTotal)} = captured ${fmt(r.captured)} [hold SIMULATED] → ${reconciled ? "RECONCILED" : "MISMATCH"}`,
  ];
  console.log("\n" + summary.join("\n"));

  mkdirSync("docs/live-runs", { recursive: true });
  const file = `docs/live-runs/${JOB.id.replace("live-", "")}-engine-x402-run.md`;
  writeFileSync(
    file,
    [
      `# Live engine run on Metal testnet · ${new Date().toISOString()}`,
      "",
      `LIVE: x402 payments (MetalFloatGateway → Metal facilitator) and the providers' on-chain payment check. SIMULATED: card hold (MockAirwallex), clearing (ClearingEmulator).`,
      "",
      `Agent ${metal.address} · chain ${pre.chainId} · clock skew ${pre.skewSeconds}s · float ${fmt(FLOAT)}`,
      "",
      "## Payments, re-read from chain",
      "",
      ...rows.map((x) => `- ${x}`),
      "",
      "## Result",
      "",
      ...summary.map((x) => `- ${x}`),
      "",
      "## Feed",
      "",
      ...events.map((e) => describe(e)).filter(Boolean).map((x) => `- ${x}`),
      "",
    ].join("\n"),
  );
  console.log(`\nSaved ${file}`);
  if (!reconciled) process.exit(1);
}

main().catch((e) => {
  console.error("live run failed:", String(e).replace(process.env.METAL_RPC_URL ?? "\u0000", "<rpc>"));
  process.exit(1);
});
