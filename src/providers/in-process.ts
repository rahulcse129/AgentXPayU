import { providerById } from "../policy/catalog.ts";
import type { PaymentRequirement, ProviderSpec, Step } from "../policy/types.ts";
import type { ProviderPort } from "../engine/ports.ts";
import { HONEST, makeOutput, makeQuote, type ProviderControl } from "./logic.ts";

/** Mock providers called in-process. Same behaviour as the HTTP server, no network. */
export class InProcessProviders implements ProviderPort {
  private controls = new Map<string, ProviderControl>();
  readonly deliveries: { providerId: string; key: string; txHash: string }[] = [];

  constructor(
    private readonly catalog: ProviderSpec[],
    private readonly rng: () => number,
  ) {}

  /** Change a provider's behaviour mid-run (slowdown, rogue mode, recovery). */
  control(providerId: string, patch: Partial<ProviderControl>) {
    this.controls.set(providerId, { ...this.get(providerId), ...patch });
  }

  get(providerId: string): ProviderControl {
    return this.controls.get(providerId) ?? HONEST;
  }

  async requestQuote(providerId: string, step: Step, key: string): Promise<PaymentRequirement> {
    return makeQuote(providerById(providerId, this.catalog), step, this.get(providerId), key);
  }

  async deliver(providerId: string, step: Step, key: string, txHash: string) {
    const out = makeOutput(providerById(providerId, this.catalog), step, this.get(providerId), this.rng);
    this.deliveries.push({ providerId, key, txHash });
    return out;
  }
}
