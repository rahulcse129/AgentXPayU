// Container entrypoint for the engine.
//
// 1. MARGIN_SECRETS_JSON (one Secrets Manager secret, injected by ECS) is a JSON object of env vars,
//    e.g. {"AIRWALLEX_API_KEY": "...", "METAL_PRIVATE_KEY": "..."}. Each key becomes an env var unless
//    the task definition already set it. Unknown or empty keys are fine, so one secret serves every mode.
// 2. METAL_OWNER_KEY, if present, is the *contents* of the metal-agent owner key file. It is written to
//    a 0600 file outside the image and METAL_OWNER_KEY_FILE points at it, because metal-agent wants a path.
// 3. ENGINE_SCRIPT picks the npm script (engine:offline, engine:live, engine:live-full, ...).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const env = { ...process.env };

if (env.MARGIN_SECRETS_JSON) {
  let parsed;
  try {
    parsed = JSON.parse(env.MARGIN_SECRETS_JSON);
  } catch {
    console.error("[entrypoint] MARGIN_SECRETS_JSON is not valid JSON; refusing to start");
    process.exit(1);
  }
  for (const [k, v] of Object.entries(parsed ?? {})) {
    if (v === null || v === undefined || v === "") continue;
    if (env[k] === undefined || env[k] === "") env[k] = String(v);
  }
  delete env.MARGIN_SECRETS_JSON;
}

if (env.METAL_OWNER_KEY) {
  const dir = join(homedir(), ".margin");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "owner-key");
  writeFileSync(file, env.METAL_OWNER_KEY, { mode: 0o600 });
  env.METAL_OWNER_KEY_FILE = file;
  delete env.METAL_OWNER_KEY;
}

const script = env.ENGINE_SCRIPT || "engine:offline";
if (!/^engine(:[a-z-]+)?$/.test(script)) {
  console.error(`[entrypoint] ENGINE_SCRIPT=${script} is not an engine script; refusing to start`);
  process.exit(1);
}
// Run the script's node command directly (not through npm) so SIGTERM from ECS reaches the engine.
const cmd = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts?.[script];
const argv = typeof cmd === "string" ? cmd.trim().split(/\s+/) : [];
if (argv[0] !== "node") {
  console.error(`[entrypoint] package.json has no node script named ${script}; refusing to start`);
  process.exit(1);
}
console.log(`[entrypoint] starting ${script}: ${cmd}`);

const child = spawn(process.execPath, argv.slice(1), { stdio: "inherit", env, cwd: new URL("..", import.meta.url) });
child.on("error", (e) => {
  console.error(`[entrypoint] failed to start: ${e.message}`);
  process.exit(1);
});
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
