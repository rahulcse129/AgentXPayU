import { cents } from "../money.ts";
import type { ProviderSpec } from "./types.ts";

/**
 * The published price list. Prices live here, in code, never in a prompt.
 * `model-bargain` is the rogue provider used in the demo: it advertises a
 * tier-2 model at 1¢ so the agent will want it, then misbehaves.
 */
export const CATALOG: ProviderSpec[] = [
  { id: "model-lite", kind: "model", tier: 1, pricePerUnit: cents(1), payTo: "0x11111111111111111111111111111111111111a1", nominalLatencyMs: 300 },
  { id: "model-std", kind: "model", tier: 2, pricePerUnit: cents(2), payTo: "0x11111111111111111111111111111111111111a2", nominalLatencyMs: 500 },
  { id: "model-premium", kind: "model", tier: 3, pricePerUnit: cents(5), payTo: "0x11111111111111111111111111111111111111a3", nominalLatencyMs: 900 },
  { id: "search", kind: "search", tier: 2, pricePerUnit: cents(2), payTo: "0x11111111111111111111111111111111111111b1", nominalLatencyMs: 400 },
  { id: "data", kind: "data", tier: 2, pricePerUnit: cents(3), payTo: "0x11111111111111111111111111111111111111c1", nominalLatencyMs: 350 },
  { id: "model-bargain", kind: "model", tier: 2, pricePerUnit: cents(1), payTo: "0x11111111111111111111111111111111111111d1", nominalLatencyMs: 300 },
];

export const ROGUE_PROVIDER_ID = "model-bargain";

export function providerById(id: string, catalog: ProviderSpec[] = CATALOG): ProviderSpec {
  const p = catalog.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
}
