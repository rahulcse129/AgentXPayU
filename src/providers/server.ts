/**
 * Mock paid providers over HTTP, x402-style (Kavisha's demo backend).
 *
 *   POST /p/:id/work      body { step, key }
 *       no X-PAYMENT header -> 402 { accepts: [PaymentRequirement] }
 *       with X-PAYMENT      -> 200 { output, latencyMs }   (after simulated latency)
 *   GET  /providers       published catalog
 *   GET  /control         current behaviour of every provider
 *   POST /control         { providerId, mode?, latencyMs?, overquoteFactor? }  — demo buttons
 *
 * Simplified on purpose: this mock trusts the X-PAYMENT proof. The real flow should use the
 * x402 client/facilitator from the Metal starter kit to verify settlement before delivering.
 *
 * Run: npm run providers   (PORT=4021 by default)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CATALOG, providerById } from "../policy/catalog.ts";
import type { Step } from "../policy/types.ts";
import { HONEST, makeOutput, makeQuote, ProviderDeliveryError, type ProviderControl, type ProviderMode } from "./logic.ts";

const controls = new Map<string, ProviderControl>();
const ctl = (id: string) => controls.get(id) ?? HONEST;
const LATENCY_SCALE = Number(process.env.LATENCY_SCALE ?? 1);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export function createProviderServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/providers") return send(res, 200, CATALOG);
      if (req.method === "GET" && url.pathname === "/control") {
        return send(res, 200, Object.fromEntries(CATALOG.map((p) => [p.id, ctl(p.id)])));
      }
      if (req.method === "POST" && url.pathname === "/control") {
        const b = await readJson(req);
        const id = String(b.providerId);
        providerById(id);
        const patch: Partial<ProviderControl> = {};
        if (b.mode) patch.mode = b.mode as ProviderMode;
        if (b.latencyMs !== undefined) patch.latencyMs = b.latencyMs === null ? undefined : Number(b.latencyMs);
        if (b.overquoteFactor !== undefined) patch.overquoteFactor = Number(b.overquoteFactor);
        controls.set(id, { ...ctl(id), ...patch });
        return send(res, 200, { providerId: id, ...ctl(id) });
      }
      const m = /^\/p\/([\w-]+)\/work$/.exec(url.pathname);
      if (req.method === "POST" && m) {
        const spec = providerById(m[1]!);
        const b = await readJson(req);
        const step = b.step as Step;
        const key = String(b.key);
        const payment = req.headers["x-payment"];
        if (!payment) return send(res, 402, { x402Version: 1, accepts: [makeQuote(spec, step, ctl(spec.id), key)] });
        const out = makeOutput(spec, step, ctl(spec.id), Math.random);
        await new Promise((r) => setTimeout(r, out.latencyMs * LATENCY_SCALE));
        return send(res, 200, out);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, e instanceof ProviderDeliveryError ? 503 : 400, { error: String(e) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4021);
  createProviderServer().listen(port, () => console.log(`mock providers on http://localhost:${port}`));
}
