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
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { llmFromEnv, llmProviderFromEnv } from "../agent/llm-config.ts";
import { DemoSession, type ControlAction, type SessionMessage } from "./session.ts";

export interface RailStatus {
  rail: string;
  source: "live" | "simulated" | "off" | "not built";
  detail: string;
}

export interface Meta {
  mode: "mock" | "live";
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

export function createEngineServer(env: NodeJS.ProcessEnv = process.env, opts: { noLlm?: boolean } = {}) {
  const llm = opts.noLlm || env.DASHBOARD_LLM === "off" ? undefined : llmFromEnv(env);
  const session = new DemoSession({
    llm,
    paceScale: env.PACE_SCALE ? Number(env.PACE_SCALE) : 0.6,
    approvalTimeoutMs: env.APPROVAL_TIMEOUT_MS ? Number(env.APPROVAL_TIMEOUT_MS) : 30_000,
  });

  const meta = (): Meta => {
    const sim = readJson<{ badge: string; runs: number; passed: boolean; generatedAt: string; clearing?: { badge?: string } }>("sim-report.json");
    return {
      mode: "mock",
      rails: [
        { rail: "Airwallex holds", source: "simulated", detail: "MockAirwallex: enforces capture ≤ hold; sandbox client not yet run" },
        { rail: "Metal x402 payments", source: "simulated", detail: "MockMetal: idempotent settlement; testnet not yet wired" },
        { rail: "Metal mandates", source: "not built", detail: "§5.3: on-chain second lock, not built yet" },
        { rail: "Metal clearing", source: "simulated", detail: "ClearingEmulator: not available to builders on testnet" },
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
        const r = session.control(action);
        return send(res, r.ok ? 200 : action === "mandate_test" ? 501 : 409, r);
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
  const { server } = createEngineServer(process.env, { noLlm: process.argv.includes("--no-llm") });
  server.listen(port, () => console.log(`margin engine on http://localhost:${port}  (dashboard: npm run dashboard)`));
}
