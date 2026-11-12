/**
 * Engine server for the dashboard.
 *
 *   GET  /api/meta            mode, per-rail LIVE/SIMULATED status, proof badge (sim-report.json)
 *   GET  /api/stream          Server-Sent Events: every SessionMessage of the current run, replayed on connect
 *   POST /api/run             { scripted?: boolean }  start the demo scenario
 *   POST /api/approve         { jobId }  answer a pending hold increase
 *   POST /api/decline         { jobId }
 *   POST /api/control         { action }  demo buttons (see ControlAction)
 *
 * Run: npm run engine   (PORT=4100). Reads .env; GEMINI_API_KEY / LLM_API_KEY turn the LLM on.
 * npm run engine:offline (or DASHBOARD_LLM=off) keeps it off: each run costs ~17 LLM calls.
 * npm run engine:live (--live-metal) pays providers with real x402 on Metal testnet, about
 * 1.4 USDZ per scripted run; needs METAL_PRIVATE_KEY and METAL_RPC_URL.
 * npm run engine:live-mandate (--live-mandate) pays through a real Metal mandate on the owner's
 * account; needs METAL_OWNER_ACCOUNT, METAL_OWNER_KEY_FILE and METAL_RPC_URL.
 * Offline, every run still pays through a SIMULATED mandate, so both locks are always on.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { llmFromEnv, llmProviderFromEnv } from "../agent/llm-config.ts";
import { MetalFloatGateway } from "../payments/metal.ts";
import { MetalMandateGateway } from "../payments/mandate.ts";
import { AirwallexHoldGateway } from "../payments/airwallex.ts";
import { sweepRunLedgers } from "./recover.ts";
import { DemoSession, type ControlAction, type LiveAirwallex, type LiveMandate, type LiveMetal, type SessionMessage } from "./session.ts";

export interface RailStatus {
  rail: string;
  source: "live" | "simulated" | "off" | "not built";
  detail: string;
}

export interface Meta {
  /** "mixed": some rails live, some simulated; the per-rail badges say which. */
  mode: "mock" | "mixed" | "live";
  rails: RailStatus[];
  proof: { badge: string; runs: number; passed: boolean; generatedAt: string; clearingBadge?: string } | null;
  sabotage: { generatedAt: string; results: { name: string; caught: boolean; flagged: number; runs: number }[] } | null;
  running: boolean;
}

const CONTROLS: ControlAction[] = ["overrun_b", "slow_lite", "rogue_overquote", "rogue_wrong_payee", "rogue_junk", "rogue_honest", "mandate_test"];

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(data));
}

/** Where live-card runs keep their ledgers (one SQLite file per run). */
export const ledgerDirOf = (env: NodeJS.ProcessEnv) => env.MARGIN_LEDGER_DIR?.trim() || "data/ledgers";

export function createEngineServer(
  env: NodeJS.ProcessEnv = process.env,
  opts: { noLlm?: boolean; liveMetal?: boolean; liveMandate?: boolean; liveAirwallex?: boolean } = {},
) {
  const llm = opts.noLlm || env.DASHBOARD_LLM === "off" ? undefined : llmFromEnv(env);
  if (opts.liveMetal && opts.liveMandate) throw new Error("choose one: --live-metal (agent wallet) or --live-mandate (owner account)");
  let live: LiveMetal | undefined;
  let liveMandate: LiveMandate | undefined;
  let payer = "";
  if (opts.liveMetal) {
    const rpcUrl = env.METAL_RPC_URL?.trim();
    if (!rpcUrl || !env.METAL_PRIVATE_KEY) throw new Error("--live-metal needs METAL_PRIVATE_KEY and METAL_RPC_URL in .env");
    payer = MetalFloatGateway.fromEnv(env).address;
    live = { rpcUrl, makeFloat: () => MetalFloatGateway.fromEnv(env) };
  }
  if (opts.liveMandate) {
    const gw = MetalMandateGateway.fromEnv(env);
    payer = gw.payer;
    liveMandate = { rpcUrl: env.METAL_RPC_URL!.trim(), makeGateway: () => MetalMandateGateway.fromEnv(env) };
  }
  let liveAirwallex: LiveAirwallex | undefined;
  if (opts.liveAirwallex) {
    if (!env.AIRWALLEX_CLIENT_ID || !env.AIRWALLEX_API_KEY) throw new Error("--live-airwallex needs AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY in .env");
    liveAirwallex = { makeApi: (runTag) => AirwallexHoldGateway.fromEnv(env, runTag), ledgerDir: ledgerDirOf(env) };
  }
  const session = new DemoSession({
    llm,
    live,
    liveMandate,
    liveAirwallex,
    paceScale: env.PACE_SCALE ? Number(env.PACE_SCALE) : 0.6,
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS ? Number(env.APPROVAL_TIMEOUT_MS) : 30_000,
  });

  const meta = (): Meta => {
    const sim = readJson<{ badge: string; runs: number; passed: boolean; generatedAt: string; clearing?: { badge?: string } }>("sim-report.json");
    const anyLive = Boolean(live || liveMandate || liveAirwallex);
    return {
      mode: anyLive ? "mixed" : "mock",
      rails: [
        liveAirwallex
          ? { rail: "Airwallex holds", source: "live", detail: "Airwallex sandbox PaymentIntents: the customer confirms each hold in Airwallex Drop-in (pre-auth, manual capture); increment, capture and cancel are real" }
          : { rail: "Airwallex holds", source: "simulated", detail: "MockAirwallex: enforces capture ≤ hold. Run with --live-airwallex for real holds placed in Airwallex Drop-in." },
        live
          ? { rail: "Metal x402 payments", source: "live", detail: `Metal testnet (eip155:63825) via Metal's x402 facilitator; agent ${payer}; providers verify each payment on chain` }
          : liveMandate
            ? { rail: "Metal payments", source: "live", detail: `Metal testnet: mandate pulls from the owner's account ${payer}; providers verify each payment on chain` }
            : { rail: "Metal x402 payments", source: "simulated", detail: "MockMetal: idempotent settlement. Run npm run engine:live for real testnet payments." },
        liveMandate
          ? { rail: "Metal mandates", source: "live", detail: `On chain on ${payer}: payee allowlist, per-payment cap and budget checked by the account before every payment` }
          : live
            ? { rail: "Metal mandates", source: "off", detail: "This mode pays x402 straight from the agent wallet. Use engine:live-mandate for the on-chain second lock." }
            : { rail: "Metal mandates", source: "simulated", detail: "MockMandateGateway: the same payee allowlist, cap and budget rules, in memory, in front of every payment" },
        { rail: "Metal clearing", source: "simulated", detail: "ClearingEmulator, following Metal's clearing rules. Metal's live testnet clearing is not wired into Margin yet." },
        llm
          ? { rail: "LLM (judge, feed, report)", source: "live", detail: `${llmProviderFromEnv(env)} ${llm.model}; never sees prices or holds` }
          : { rail: "LLM (judge, feed, report)", source: "off", detail: "no key: tag judge and template lines" },
      ],
      proof: sim ? { badge: sim.badge, runs: sim.runs, passed: sim.passed, generatedAt: sim.generatedAt, clearingBadge: sim.clearing?.badge } : null,
      sabotage: readJson("sabotage-report.json"),
      running: session.isRunning,
    };
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/api/meta") return send(res, 200, meta());
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", ...CORS });
        res.write("retry: 2000\n\n");
        const write = (m: SessionMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
        const unsubscribe = session.subscribe(write);
        const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
        req.on("close", () => {
          clearInterval(ping);
          unsubscribe();
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        const b = await body(req);
        const r = session.start({ scripted: b.scripted !== false });
        return send(res, r.ok ? 202 : 409, r);
      }
      if (req.method === "POST" && (url.pathname === "/api/approve" || url.pathname === "/api/decline")) {
        const jobId = String((await body(req)).jobId ?? "");
        const ok = url.pathname === "/api/approve" ? session.approve(jobId) : session.decline(jobId);
        return send(res, ok ? 200 : 404, { ok, message: ok ? undefined : `no pending request for job ${jobId}` });
      }
      if (req.method === "POST" && url.pathname === "/api/control") {
        const action = String((await body(req)).action ?? "") as ControlAction;
        if (!CONTROLS.includes(action)) return send(res, 400, { ok: false, message: `unknown action ${action}` });
        const r = await session.control(action);
        return send(res, r.ok ? 200 : 409, r);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  });
  return { server, session };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4100);
  const liveMetal = process.argv.includes("--live-metal");
  const liveMandate = process.argv.includes("--live-mandate");
  const liveAirwallex = process.argv.includes("--live-airwallex");
  const { server } = createEngineServer(process.env, { noLlm: process.argv.includes("--no-llm"), liveMetal, liveMandate, liveAirwallex });

  // Startup sweeper: real Airwallex holds outlive a crash, so each live-card run's ledger is a
  // SQLite file, and every file is swept before we take requests (src/server/recover.ts). Simulated
  // holds die with the process, so there is nothing to sweep for them.
  if (liveAirwallex) {
    const dir = ledgerDirOf(process.env);
    const x402Lookup = process.env.METAL_PRIVATE_KEY && process.env.METAL_RPC_URL ? MetalFloatGateway.fromEnv(process.env) : undefined;
    const r = await sweepRunLedgers({ dir, holds: AirwallexHoldGateway.fromEnv(process.env), x402Lookup });
    console.log(`[sweeper] ${r.files} run ledger(s) in ${dir}: ${r.captured} captured, ${r.cancelled} cancelled, ${r.skipped} left open`);
    for (const e of r.errors) console.log(`[sweeper] NEEDS ATTENTION: ${e}`);
  } else {
    console.log("[sweeper] idle: card holds are simulated in memory and do not survive a restart (runs with real Airwallex holds)");
  }

  const rail = liveMandate ? "LIVE through a Metal mandate" : liveMetal ? "LIVE x402 (testnet)" : "SIMULATED (simulated mandate in front)";
  const cards = liveAirwallex ? "LIVE (Airwallex sandbox, card entered in Drop-in)" : "SIMULATED";
  server.listen(port, () => console.log(`margin engine on http://localhost:${port} · Metal rail: ${rail} · card holds: ${cards}  (dashboard: npm run dashboard)`));
}
