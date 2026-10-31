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
 * X-PAYMENT carries { txHash, key }. By default the server trusts it (TrustingVerifier, the
 * SIMULATED demo). With a ChainPaymentVerifier (live mode, or VERIFY_PAYMENTS=chain with
 * METAL_RPC_URL) it delivers only after reading the payment from Metal testnet: see verify.ts.
 *
 * Run: npm run providers   (PORT=4021 by default)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { CATALOG, providerById } from "../policy/catalog.ts";
import type { Step } from "../policy/types.ts";
import { HONEST, makeOutput, makeQuote, ProviderDeliveryError, type ProviderControl, type ProviderMode } from "./logic.ts";
import { ChainPaymentVerifier, TrustingVerifier, type PaymentProof, type PaymentVerifier } from "./verify.ts";

const controls = new Map<string, ProviderControl>();
const ctl = (id: string) => controls.get(id) ?? HONEST;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export function createProviderServer(
  opts: { verifier?: PaymentVerifier; latencyScale?: number } = {},
) {
  const verifier = opts.verifier ?? new TrustingVerifier();
  const latencyScale = opts.latencyScale ?? Number(process.env.LATENCY_SCALE ?? 1);
  /** What each purchase key was quoted, so the payment is checked against the price we asked. */
  const quoted = new Map<string, number>();
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
        if (!payment) {
          const quote = makeQuote(spec, step, ctl(spec.id), key);
          quoted.set(key, quote.amount);
          return send(res, 402, { x402Version: 1, accepts: [quote] });
        }
        let proof: PaymentProof;
        try {
          proof = JSON.parse(String(payment)) as PaymentProof;
        } catch {
          return send(res, 402, { error: "X-PAYMENT is not valid JSON" });
        }
        const price = quoted.get(key) ?? makeQuote(spec, step, ctl(spec.id), key).amount;
        const check = await verifier.verify(proof, { payTo: spec.payTo, amount: price });
        if (!check.ok) return send(res, 402, { error: `payment not accepted: ${check.reason}` });
        const out = makeOutput(spec, step, ctl(spec.id), Math.random);
        await new Promise((r) => setTimeout(r, out.latencyMs * latencyScale));
        return send(res, 200, out);
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, e instanceof ProviderDeliveryError ? 503 : 400, { error: String(e) });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4021);
  const live = process.env.VERIFY_PAYMENTS === "chain";
  if (live && !process.env.METAL_RPC_URL) throw new Error("VERIFY_PAYMENTS=chain needs METAL_RPC_URL");
  const verifier = live ? new ChainPaymentVerifier(process.env.METAL_RPC_URL!) : new TrustingVerifier();
  createProviderServer({ verifier }).listen(port, () =>
    console.log(`providers on http://localhost:${port} · payments verified: ${live ? "on Metal testnet (LIVE)" : "trusted (SIMULATED)"}`),
  );
}
