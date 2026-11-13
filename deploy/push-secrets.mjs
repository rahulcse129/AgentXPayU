// Copy the engine's keys from your local .env into the AWS secret the deployed engine reads (margin/app).
//
//   node deploy/push-secrets.mjs            dry run: shows which key NAMES would be set, changes nothing
//   node deploy/push-secrets.mjs --apply    writes the secret
//
// Never prints a value. Keys already in the secret but not in .env are kept. The Metal owner key FILE is read
// and stored as METAL_OWNER_KEY (deploy/entrypoint.mjs writes it back to a file inside the container).
// Uses the AWS CLI and its default profile/region (override with AWS_PROFILE / AWS_REGION).
// After --apply, restart the engine: Actions → Deploy to AWS → Run workflow (or ECS → Force new deployment).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET_ID = process.env.MARGIN_SECRET_ID || "margin/app";
const apply = process.argv.includes("--apply");

// Only these travel to AWS. Local paths and local URLs (ledger/mandate dirs, PROVIDERS_URL, PORT,
// NEXT_PUBLIC_ENGINE_URL) stay behind: the container sets its own.
const ALLOWED = [
  "AIRWALLEX_CLIENT_ID", "AIRWALLEX_API_KEY", "AIRWALLEX_BASE_URL", "AIRWALLEX_LOGIN_AS",
  "METAL_RPC_URL", "METAL_PRIVATE_KEY", "METAL_OWNER_ACCOUNT", "METAL_RECORD_REFUSALS",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "LLM_API_KEY", "ANTHROPIC_API_KEY", "LLM_PROVIDER", "LLM_MODEL", "LLM_MAX_CALLS",
  "DASHBOARD_LLM", "PACE_SCALE", "APPROVAL_TIMEOUT_MS", "VERIFY_PAYMENTS", "LATENCY_SCALE",
];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v !== "") out[m[1]] = v;
  }
  return out;
}

function awsBin() {
  const win = "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe";
  return process.platform === "win32" && existsSync(win) ? win : "aws";
}

function aws(args) {
  return execFileSync(awsBin(), [...args, "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

if (!existsSync(".env")) {
  console.error("No .env here. Run from the repo root.");
  process.exit(1);
}
const local = parseEnv(readFileSync(".env", "utf8"));

const wanted = {};
for (const k of ALLOWED) if (local[k]) wanted[k] = local[k];
if (local.METAL_OWNER_KEY_FILE) {
  if (!existsSync(local.METAL_OWNER_KEY_FILE)) {
    console.error("METAL_OWNER_KEY_FILE in .env points to a file that doesn't exist; fix it or remove the line.");
    process.exit(1);
  }
  wanted.METAL_OWNER_KEY = readFileSync(local.METAL_OWNER_KEY_FILE, "utf8").trim();
}
const skipped = Object.keys(local).filter((k) => !(k in wanted) && k !== "METAL_OWNER_KEY_FILE");

let current = {};
try {
  const r = JSON.parse(aws(["secretsmanager", "get-secret-value", "--secret-id", SECRET_ID]));
  current = JSON.parse(r.SecretString || "{}");
} catch (e) {
  const msg = String(e.stderr || e.message);
  console.error(`Can't read secret ${SECRET_ID}: ${msg.includes("ResourceNotFound") ? "it doesn't exist (deploy MarginApp first)" : msg.trim().split("\n").pop()}`);
  process.exit(1);
}

const merged = { ...current, ...wanted };
const status = (k) => (!(k in current) ? "new" : current[k] === wanted[k] ? "unchanged" : "updated");
console.log(`Secret ${SECRET_ID}:`);
for (const k of Object.keys(wanted).sort()) console.log(`  ${k.padEnd(24)} ${status(k)}`);
for (const k of Object.keys(current).filter((k) => !(k in wanted)).sort()) console.log(`  ${k.padEnd(24)} kept (not in .env)`);
if (skipped.length) console.log(`Not sent (local-only): ${skipped.join(", ")}`);

if (!apply) {
  console.log("\nDry run. Nothing was written. Re-run with --apply to save.");
  process.exit(0);
}

// Pass the value through a private temp file, not the command line (which other processes can read).
const dir = mkdtempSync(join(tmpdir(), "margin-secret-"));
const file = join(dir, "secret.json");
try {
  writeFileSync(file, JSON.stringify(merged), { mode: 0o600 });
  aws(["secretsmanager", "put-secret-value", "--secret-id", SECRET_ID, "--secret-string", `file://${file}`]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\nSaved ${Object.keys(merged).length} keys to ${SECRET_ID}.`);
console.log("Restart the engine to load them: GitHub → Actions → Deploy to AWS → Run workflow.");
