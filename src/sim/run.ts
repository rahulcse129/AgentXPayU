/**
 * The "zero overcharges" proof.
 *
 *   npm run sim                       10,000 randomized runs, exits 1 on any violation
 *   npm run sim -- --runs=500 --seed=7
 *   npm run sim:sabotage              same checks against deliberately broken engines,
 *                                     to show the checks actually catch bugs
 *
 * Writes sim-report.json (the dashboard badge reads it).
 */
import { writeFileSync } from "node:fs";
import { fmt } from "../money.ts";
import type { Sabotage } from "../engine/orchestrator.ts";
import { randomScenario, runScenario } from "./harness.ts";

const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;

const runs = Number(arg("runs", "10000"));
const seed0 = Number(arg("seed", "1"));
const sabotageArg = arg("sabotage", "");

const SABOTAGES: Record<string, Sabotage> = {
  quote: { skipQuoteCheck: true },
  idempotency: { freshKeyOnRetry: true },
  hold: { ignoreHold: true },
  capture: { captureFullHold: true },
};

async function sweep(label: string, sabotage?: Sabotage) {
  const totals: Record<string, number> = {};
  const byRule = new Map<string, number>();
  const failingSeeds: number[] = [];
  const t0 = Date.now();

  for (let i = 0; i < runs; i++) {
    const out = await runScenario(randomScenario(seed0 + i), sabotage);
    for (const [k, n] of Object.entries(out.stats)) totals[k] = (totals[k] ?? 0) + n;
    if (out.violations.length) {
      failingSeeds.push(out.seed);
      for (const msg of out.violations) {
        const rule = msg.split(":")[0]!;
        byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      }
    }
  }
  return { label, totals, byRule, failingSeeds, ms: Date.now() - t0 };
}

function count(byRule: Map<string, number>, ...rules: string[]) {
  return rules.reduce((s, r) => s + (byRule.get(r) ?? 0), 0);
}

async function main() {
  if (sabotageArg) {
    const names = sabotageArg === "all" ? Object.keys(SABOTAGES) : sabotageArg.split(",");
    console.log(`Sabotage check: each broken engine should FAIL the invariants (${runs} runs each)\n`);
    let allCaught = true;
    for (const name of names) {
      const r = await sweep(name, SABOTAGES[name]);
      const caught = r.failingSeeds.length > 0;
      allCaught &&= caught;
      const rules = [...r.byRule.entries()].map(([k, n]) => `${k}×${n}`).join(", ") || "none";
      console.log(`  ${caught ? "CAUGHT " : "MISSED "} ${name.padEnd(12)} ${r.failingSeeds.length}/${runs} runs flagged  [${rules}]`);
    }
    console.log(allCaught ? "\nEvery sabotage was caught. The checks have teeth." : "\nSome sabotage went unnoticed.");
    process.exit(allCaught ? 0 : 1);
  }

  const r = await sweep("margin");
  const t = r.totals;
  const overcharges = count(r.byRule, "hold.exceeded", "hold.raced", "capture.mismatch", "airwallex.rule_broken");
  const doublePays = count(r.byRule, "payment.unrecorded", "payment.amount_mismatch");
  const orphans = count(r.byRule, "hold.orphaned", "payment.pending");
  const overpaid = count(r.byRule, "payment.overpaid", "payment.wrong_payee");
  const totalViolations = [...r.byRule.values()].reduce((a, b) => a + b, 0);
  const saved = (t.premiumOnlyCost ?? 0) - (t.spent ?? 0);

  const report = {
    generatedAt: new Date().toISOString(),
    runs,
    seeds: [seed0, seed0 + runs - 1],
    passed: totalViolations === 0,
    badge: `${runs.toLocaleString("en-US")} simulated runs · ${overcharges} overcharges · ${doublePays} double payments · ${orphans} orphaned holds · ${overpaid} rogue overpayments`,
    violationsByRule: Object.fromEntries(r.byRule),
    failingSeeds: r.failingSeeds.slice(0, 50),
    totals: t,
    savedVsPremiumOnly: { spentMicros: t.spent, premiumOnlyMicros: t.premiumOnlyCost, savedPct: t.premiumOnlyCost ? Math.round((100 * saved) / t.premiumOnlyCost) : 0 },
    durationMs: r.ms,
  };
  writeFileSync("sim-report.json", JSON.stringify(report, null, 2));

  console.log(`\n  ${report.badge}\n`);
  console.log(`  jobs ${t.jobs} · provider payments ${t.payments} · pay retries ${t.payRetries} (deduped on rail: ${t.dedupedRetries})`);
  console.log(`  rogue 402s refused ${t.refusedQuotes} · junk answers caught ${t.junkCaught} · paid-but-no-delivery ${t.noDelivery} · providers blocked ${t.providersBlocked}`);
  console.log(`  hold increases asked ${t.increaseRequests} (approved ${t.increasesApproved}, declined ${t.increasesDeclined}, timed out ${t.increasesTimedOut}, issuer declined ${t.issuerDeclines})`);
  console.log(`  budget-limited jobs ${t.degradedJobs} · reserve grants ${t.reserveGrants} · premium buys ${t.premiumBuys} · failed jobs ${t.failedJobs} (all settled)`);
  console.log(`  holds captured ${t.holdsCaptured} · cancelled ${t.holdsCancelled}`);
  console.log(`  spent ${fmt(t.spent ?? 0)} vs premium-only ${fmt(t.premiumOnlyCost ?? 0)} → saved ${report.savedVsPremiumOnly.savedPct}%`);
  console.log(`  ${(r.ms / 1000).toFixed(1)}s · report: sim-report.json`);
  if (!report.passed) {
    console.log(`\n  VIOLATIONS: ${JSON.stringify(report.violationsByRule)}  first seeds: ${r.failingSeeds.slice(0, 10).join(", ")}`);
    process.exit(1);
  }
}

main();
