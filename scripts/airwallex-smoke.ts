/**
 * Airwallex sandbox smoke test (§5.1): one hold authorized, raised, partly captured; a second
 * hold authorized and cancelled. Reads every intent back so the VERIFY questions in
 * src/payments/airwallex.ts are answered by what the sandbox actually did.
 *
 *   npm run smoke:airwallex        (needs AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY in .env)
 *
 * Sandbox only: refuses any base URL that is not an Airwallex sandbox host. The card is Airwallex's
 * published sandbox test card that "always succeeds regardless of amount" (docs: test card
 * numbers), confirmed server-side because this is a script; the dashboard uses Drop-in.
 */
import { cents } from "../src/money.ts";
import { AirwallexHoldGateway, type AirwallexIntent } from "../src/payments/airwallex.ts";

const SANDBOX_HOSTS = ["api.sandbox.airwallex.com", "api-demo.airwallex.com"];
const base = process.env.AIRWALLEX_BASE_URL || "https://api.sandbox.airwallex.com";
if (!SANDBOX_HOSTS.includes(new URL(base).host)) {
  console.error(`Refusing to run: AIRWALLEX_BASE_URL is ${base}, not an Airwallex sandbox host (${SANDBOX_HOSTS.join(", ")}).`);
  process.exit(1);
}

const TEST_CARD = {
  type: "card",
  card: { number: "4035501000000008", expiry_month: "12", expiry_year: "2030", cvc: "123", name: "Margin Smoke Test" },
};
const paymentMethod = process.env.AIRWALLEX_TEST_PAYMENT_METHOD ? JSON.parse(process.env.AIRWALLEX_TEST_PAYMENT_METHOD) : TEST_CARD;

const gw = AirwallexHoldGateway.fromEnv();
// Unique per run: request_ids are deterministic per job, so a rerun with the same job id would
// (correctly) be deduped by Airwallex and return the first run's intent.
const run = `smoke-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;

const show = (label: string, i: AirwallexIntent) =>
  console.log(
    `  ${label.padEnd(22)} ${i.id}  status=${i.status}  amount=${i.amount} ${i.currency}` +
      (i.captured_amount !== undefined ? `  captured=${i.captured_amount}` : "") +
      (i.latest_payment_attempt?.status ? `  attempt=${i.latest_payment_attempt.status}` : ""),
  );

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    console.log(`  ${label}: FAILED ${String((e as Error).message).slice(0, 600)}`);
    throw e;
  }
}

async function main() {
  console.log(`Airwallex sandbox smoke test · ${base} · run ${run}\n`);
  const findings: string[] = [];

  console.log("Hold 1: authorize $0.75 → raise to $1.24 → capture $1.00");
  const { holdId: h1 } = await step("authorize", () => gw.authorize({ jobId: `${run}-A`, amount: cents(75), paymentMethod }));
  const a1 = await gw.retrieve(h1);
  show("after authorize", a1);

  await step("increment", () => gw.increment(h1, cents(124)));
  const a2 = await gw.retrieve(h1);
  show("after increment", a2);
  if (a2.amount === 1.24) findings.push("increment_authorization `amount` is the NEW TOTAL (0.75 → 1.24 sent as 1.24).");
  else if (a2.amount === 1.99) findings.push("increment_authorization `amount` is a DELTA (sending 1.24 made 0.75 + 1.24 = 1.99). Fix increment() to send the difference.");
  else findings.push(`increment_authorization: intent amount after increment is ${a2.amount}; inspect manually.`);

  await step("capture", () => gw.capture(h1, cents(100)));
  const a3 = await gw.retrieve(h1);
  show("after capture $1.00", a3);
  findings.push(`partial capture of 1.00 on a 1.24 hold: status ${a3.status}, captured_amount ${a3.captured_amount ?? "(not reported)"}.`);

  console.log("\nHold 2: authorize $0.75 → cancel");
  const { holdId: h2 } = await step("authorize", () => gw.authorize({ jobId: `${run}-B`, amount: cents(75), paymentMethod }));
  show("after authorize", await gw.retrieve(h2));
  await step("cancel", () => gw.cancel(h2, "nothing_spent"));
  const b2 = await gw.retrieve(h2);
  show("after cancel", b2);
  findings.push(`cancel with { cancellation_reason }: status ${b2.status}.`);

  console.log("\nFindings:");
  for (const f of findings) console.log(`  - ${f}`);
}

main().catch(() => process.exit(1));
