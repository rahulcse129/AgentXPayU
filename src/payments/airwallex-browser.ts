/**
 * Card holds where the customer enters their card in Airwallex Drop-in, in the browser.
 *
 * The card never touches our server (project rule, and Airwallex refuses raw-card confirms from
 * accounts without native API access, seen 2026-11-08). So `authorize`:
 *   1. creates the PaymentIntent server-side (no card),
 *   2. hands { intent id, client_secret } to the page (onCardNeeded), which mounts Drop-in with
 *      authorizationType 'pre_auth' and autoCapture false, and the customer confirms there,
 *   3. reads the intent back from Airwallex until it is REQUIRES_CAPTURE: a hold is placed.
 * If the customer abandons, the card fails, or the wait times out, the intent is cancelled and
 * `authorize` throws, so the engine never runs a job without a real hold.
 * increment / capture / cancel stay server-side on the intent.
 */
import type { Micros } from "../money.ts";
import { AirwallexHoldGateway, type AirwallexIntent } from "./airwallex.ts";
import { IssuerDeclined, TransientError, type HoldGateway } from "./types.ts";

export interface CardRequest {
  jobId: string;
  holdId: string;
  clientSecret: string;
  amount: Micros;
  currency: string;
}

/** Airwallex PaymentIntent statuses (API reference) mapped to what a hold is. */
export function holdStatusOf(intent: Pick<AirwallexIntent, "status">): "pending" | "authorized" | "captured" | "cancelled" | "failed" {
  switch (intent.status) {
    case "REQUIRES_CAPTURE":
      return "authorized";
    case "SUCCEEDED":
      return "captured";
    case "CANCELLED":
      return "cancelled";
    case "REQUIRES_PAYMENT_METHOD":
    case "REQUIRES_CUSTOMER_ACTION":
    case "PENDING":
      return "pending";
    default:
      return "failed";
  }
}

export class BrowserConfirmedHolds implements HoldGateway {
  readonly source = "live" as const;

  constructor(
    readonly api: AirwallexHoldGateway,
    private readonly onCardNeeded: (req: CardRequest) => void,
    private readonly opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async authorize({ jobId, amount }: { jobId: string; amount: Micros }): Promise<{ holdId: string }> {
    const { holdId, clientSecret, currency } = await this.api.createIntent({ jobId, amount });
    this.onCardNeeded({ jobId, holdId, clientSecret, amount, currency });
    const deadline = Date.now() + (this.opts.timeoutMs ?? 5 * 60_000);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      let intent: AirwallexIntent;
      try {
        intent = await this.api.retrieve(holdId);
      } catch (e) {
        // A network blip while the customer types is not a decline: keep polling until the deadline.
        if (!(e instanceof TransientError) || Date.now() > deadline) throw e;
        await sleep(this.opts.pollMs ?? 2000);
        continue;
      }
      const status = holdStatusOf(intent);
      if (status === "authorized") return { holdId };
      if (status === "failed" || status === "cancelled" || status === "captured") {
        // captured would mean auto-capture ran: not a hold. Refuse to use it as one.
        throw new IssuerDeclined(`card hold for job ${jobId} not placed: intent ${holdId} is ${intent.status}`);
      }
      if (Date.now() > deadline) {
        await this.api.cancel(holdId, "card_not_entered").catch(() => {});
        throw new IssuerDeclined(`no card was authorized for job ${jobId} in time; intent ${holdId} cancelled`);
      }
      await sleep(this.opts.pollMs ?? 2000);
    }
  }

  increment(holdId: string, newTotal: Micros) {
    return this.api.increment(holdId, newTotal);
  }

  capture(holdId: string, amount: Micros) {
    return this.api.capture(holdId, amount);
  }

  cancel(holdId: string, reason: string) {
    return this.api.cancel(holdId, reason);
  }
}
