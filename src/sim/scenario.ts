/**
 * The scripted submission scenario, shared by the terminal demo and the dashboard server.
 * Three jobs, holds $1.00 / $0.75 / $0.75, only 1.50 USDZ of float, 30¢ of it held back as reserve.
 */
import { cents, usd } from "../money.ts";
import type { Step } from "../policy/types.ts";
import type { JobSpec } from "../engine/orchestrator.ts";

const m = (id: string, units: number, minTier: 1 | 2, extra: Partial<Step> = {}): Step => ({
  id, kind: "model", units, minTier, maxLatencyMs: 1000, ...extra,
});
const search = (id: string): Step => ({ id, kind: "search", units: 1, minTier: 2, maxLatencyMs: 1000 });
const data = (id: string): Step => ({ id, kind: "data", units: 1, minTier: 2, maxLatencyMs: 1000, optional: true });

export const DEMO_JOBS: JobSpec[] = [
  { id: "A", customer: "Acme Research", hold: usd(1.0), steps: [search("search"), data("lookup"), m("outline", 12, 2), m("body", 15, 1), m("summary", 10, 2, { premiumEligible: true })] },
  { id: "B", customer: "Birch Capital", hold: usd(0.75), steps: [search("search"), m("draft", 10, 1), m("analysis", 12, 2), m("wrapup", 8, 1), data("lookup")] },
  { id: "C", customer: "Cobalt Labs", hold: usd(0.75), steps: [search("search"), m("scan", 14, 1), m("compare", 10, 2), data("lookup"), m("brief", 6, 1)] },
];

export const DEMO_TOPICS = new Map([
  ["A", "How small online retailers can cut card-payment costs"],
  ["B", "Risks of letting AI agents make purchases on a company card"],
  ["C", "Choosing between open-weight and hosted language models for a startup"],
]);

export const DEMO_FLOAT = usd(1.5);
export const DEMO_RESERVE = cents(30);
