/**
 * Live Metal mandate on testnet (§5.3), step by step, every step checked on chain.
 *
 *   npm run live:mandate
 *
 * Uses the same MandateManager + MetalMandateGateway the dashboard uses:
 *   1. open      credential (payees = catalog, cap 3¢, budget $0.20) + bind on the owner's account
 *   2. pay 1¢    a `mandate pull` to a registered provider
 *   3. repeat    the same payment id again: must report the same payment, not pay twice
 *   4. refuse    an unregistered payee, then an amount over the cap: the mandate says no
 *   5. raise     budget +$0.05 (replace), as after an approved hold increase
 *   6. revoke    then a pull after revoke must be refused
 * Needs METAL_OWNER_ACCOUNT, METAL_OWNER_KEY_FILE, METAL_RPC_URL. Spends 1¢ plus gas.
 * Writes docs/live-runs/<timestamp>-mandate-lifecycle.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, getAddress, http, keccak256, toHex, type Hex } from "viem";
import { USDZ, formatUsdz } from "@metalntwx/metal-pay";
import { cents, fmt } from "../src/money.ts";
import { CATALOG } from "../src/policy/catalog.ts";
import { Ledger, MemoryStore } from "../src/ledger/ledger.ts";
import { MandateRefused, MetalMandateGateway } from "../src/payments/mandate.ts";
import { MandateManager } from "../src/payments/mandate-manager.ts";
import { METAL_EXPLORER_TX } from "../src/payments/metal-audit.ts";

const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
const AUTH_USED = keccak256(toHex("AuthorizationUsed(address,bytes32)"));
const UNREGISTERED = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead";
const LITE = CATALOG.find((p) => p.id === "model-lite")!.payTo;

const lines: string[] = [];
const say = (s: string) => {
  console.log(s);
  lines.push(s);
};

async function main() {
  const rpc = process.env.METAL_RPC_URL!;
  const gw = MetalMandateGateway.fromEnv();
  const chain = createPublicClient({ transport: http(rpc, { timeout: 20_000 }) });
  const account = getAddress(gw.payer);
  const balance = async () => formatUsdz(await chain.readContract({ address: USDZ.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }));
  const ledger = new Ledger(new MemoryStore());
  const m = new MandateManager(gw, CATALOG, cents(3)).attach(ledger);
  const run = `mandate-check-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;

  const receipt = async (label: string, tx: string) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return say(`  ${label}: no transaction hash printed (${tx || "empty"})`);
    const r = await chain.getTransactionReceipt({ hash: tx as Hex });
    const usdz = r.logs.filter((l) => l.address.toLowerCase() === USDZ.address.toLowerCase());
    const moved = usdz
      .filter((l) => l.topics[0] === TRANSFER && l.topics[2])
      .map((l) => `${getAddress(`0x${l.topics[1]!.slice(26)}`).slice(0, 8)}…→${getAddress(`0x${l.topics[2]!.slice(26)}`).slice(0, 8)}… ${formatUsdz(BigInt(l.data))}`);
    say(`  ${label}: ${r.status} · block ${r.blockNumber} · ${METAL_EXPLORER_TX}${tx}`);
    if (moved.length) say(`    USDZ transfers: ${moved.join("; ")}${usdz.some((l) => l.topics[0] === AUTH_USED) ? " · AuthorizationUsed ✓" : " · no AuthorizationUsed"}`);
    return r;
  };

  say(`Owner account ${account} · balance ${await balance()} USDZ · run ${run}\n`);

  say("1. Open: credential + bind");
  const opened = await m.deposit(cents(20));
  say(`  mandate ${m.active!.mandateId} · ${m.active!.payees.length} payees · cap ${fmt(m.active!.perPaymentCap)} · budget ${fmt(m.active!.budget)}`);
  await receipt("bind", opened.txHash);

  say("\n2. Pay 1¢ to model-lite under the mandate");
  const before = await balance();
  const paid = await m.pay({ idempotencyKey: `${run}:1`, payTo: LITE, amount: cents(1), asset: "USDZ" });
  await receipt("pull", paid.txHash);
  say(`  account balance ${before} → ${await balance()}`);

  say("\n3. Same payment id again, straight at the CLI (it must report, not pay)");
  const again = await gw.pull({ paymentId: `${run}:1`, payTo: LITE, amount: cents(1) });
  say(`  same tx: ${again.txHash === paid.txHash ? "yes" : `NO (${again.txHash})`} · balance ${await balance()}`);

  say("\n4. Refusals");
  for (const [what, payTo, amount] of [
    ["unregistered payee", UNREGISTERED, cents(1)],
    ["over the 3¢ cap", LITE, cents(4)],
  ] as const) {
    const err = await m.pay({ idempotencyKey: `${run}:${what}`, payTo, amount, asset: "USDZ" }).then(
      (x) => new Error(`PAID ${x.txHash}`),
      (e: unknown) => e,
    );
    if (err instanceof MandateRefused) {
      say(`  ${what}: refused · reason ${err.reason}`);
      if (err.refusalTx) await receipt("    refusal recorded", err.refusalTx);
    } else say(`  ${what}: UNEXPECTED ${String(err).slice(0, 200)}`);
  }
  say(`  balance ${await balance()}`);

  say("\n5. Raise budget +$0.05 (replace), as after an approved hold increase");
  await m.onHoldIncreased("check", cents(75), cents(80));
  const raisedEv = ledger.events().find((e) => e.type === "mandate.raised");
  say(`  budget now ${fmt(m.active!.budget)}`);
  await receipt("replace", String(raisedEv?.data.raiseTx ?? ""));

  say("\n6. Revoke, then try to pay");
  const revokeTx = await m.close();
  await receipt("revoke", revokeTx);
  const after = await gw.pull({ paymentId: `${run}:after-revoke`, payTo: LITE, amount: cents(1) }).then(
    (x) => `PAID ${x.txHash}`,
    (e) => (e instanceof MandateRefused ? `refused: ${e.message.split("\n")[0]!.slice(0, 160)}` : `error: ${String(e).slice(0, 160)}`),
  );
  say(`  pull after revoke: ${after}`);
  say(`\nFinal account balance ${await balance()} USDZ`);

  mkdirSync("docs/live-runs", { recursive: true });
  const file = `docs/live-runs/${run.replace("mandate-check-", "")}-mandate-lifecycle.md`;
  writeFileSync(file, [`# Live Metal mandate lifecycle · ${new Date().toISOString()}`, "", "`npm run live:mandate` on Metal testnet. Every transaction re-read from chain.", "", "```", ...lines, "```", ""].join("\n"));
  console.log(`\nSaved ${file}`);
}

main().catch((e) => {
  console.error("live mandate run failed:", String(e).replaceAll(process.env.METAL_RPC_URL ?? "\u0000", "<rpc>"));
  process.exit(1);
});
