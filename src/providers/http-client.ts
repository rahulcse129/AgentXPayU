import type { PaymentRequirement, Step } from "../policy/types.ts";
import type { ProviderPort } from "../engine/ports.ts";
import { ProviderDeliveryError } from "./logic.ts";

/** ProviderPort over HTTP against src/providers/server.ts (or real x402 providers). */
export class HttpProviders implements ProviderPort {
  constructor(private readonly baseUrl = "http://localhost:4021") {}

  async requestQuote(providerId: string, step: Step, key: string): Promise<PaymentRequirement> {
    const res = await fetch(`${this.baseUrl}/p/${providerId}/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step, key }),
    });
    if (res.status !== 402) throw new Error(`${providerId}: expected 402, got ${res.status}`);
    const body = (await res.json()) as { accepts: PaymentRequirement[] };
    const req = body.accepts[0];
    if (!req) throw new Error(`${providerId}: 402 without payment requirements`);
    return req;
  }

  async deliver(providerId: string, step: Step, key: string, txHash: string) {
    const res = await fetch(`${this.baseUrl}/p/${providerId}/work`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": JSON.stringify({ txHash, key }) },
      body: JSON.stringify({ step, key }),
    });
    if (!res.ok) throw new ProviderDeliveryError(`${providerId}: ${res.status} ${await res.text()}`);
    return (await res.json()) as { output: string; latencyMs: number };
  }
}
