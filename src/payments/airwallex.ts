/**
 * Airwallex sandbox client for card holds (Rahul's starting point).
 *
 * Endpoints (confirmed in the API reference):
 *   POST /api/v1/authentication/login
 *   POST /api/v1/pa/payment_intents/create
 *   POST /api/v1/pa/payment_intents/{id}/confirm
 *   POST /api/v1/pa/payment_intents/{id}/increment_authorization
 *   POST /api/v1/pa/payment_intents/{id}/capture
 *   POST /api/v1/pa/payment_intents/{id}/cancel
 *
 * Lines marked VERIFY are field details to check against the sandbox on day 1.
 * `request_id`s are deterministic so a retried call is deduped by Airwallex, not repeated.
 *
 * Card collection: in the real demo the customer enters the card in Airwallex Drop-in /
 * Elements on the dashboard, which confirms the intent with the client_secret. Passing
 * `paymentMethod` here confirms server-side instead (handy for scripted sandbox runs).
 */
import { toMajor, type Micros } from "../money.ts";
import { IssuerDeclined, TransientError, type HoldGateway } from "./types.ts";

export interface AirwallexConfig {
  clientId: string;
  apiKey: string;
  baseUrl?: string;
  currency?: string;
}

export class AirwallexHoldGateway implements HoldGateway {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;
  private readonly currency: string;

  constructor(private readonly cfg: AirwallexConfig) {
    this.baseUrl = cfg.baseUrl ?? "https://api-demo.airwallex.com";
    this.currency = cfg.currency ?? "USD";
  }

  static fromEnv(): AirwallexHoldGateway {
    const clientId = process.env.AIRWALLEX_CLIENT_ID;
    const apiKey = process.env.AIRWALLEX_API_KEY;
    if (!clientId || !apiKey) throw new Error("set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY (sandbox)");
    return new AirwallexHoldGateway({ clientId, apiKey, baseUrl: process.env.AIRWALLEX_BASE_URL });
  }

  private async auth(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.baseUrl}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.cfg.clientId, "x-api-key": this.cfg.apiKey },
    });
    if (!res.ok) throw new Error(`airwallex login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; expires_at?: string };
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 25 * 60_000;
    this.token = { value: body.token, expiresAt };
    return body.token;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const token = await this.auth();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TransientError(`airwallex ${path}: ${String(e)}`);
    }
    const text = await res.text();
    if (res.status >= 500) throw new TransientError(`airwallex ${path}: ${res.status} ${text}`);
    if (!res.ok) {
      if (text.includes("decline")) throw new IssuerDeclined(`airwallex ${path}: ${text}`);
      throw new Error(`airwallex ${path}: ${res.status} ${text}`);
    }
    return JSON.parse(text) as T;
  }

  async authorize({ jobId, amount, paymentMethod }: { jobId: string; amount: Micros; paymentMethod?: unknown }) {
    const intent = await this.post<{ id: string; client_secret: string }>("/api/v1/pa/payment_intents/create", {
      request_id: `margin-${jobId}-create`,
      merchant_order_id: `margin-${jobId}`,
      amount: toMajor(amount),
      currency: this.currency,
      payment_method_options: {
        // pre_auth is required for incremental authorization; Visa and Mastercard only.
        card: { authorization_type: "pre_auth" }, // VERIFY: accepted on create
      },
    });
    if (paymentMethod) {
      await this.post(`/api/v1/pa/payment_intents/${intent.id}/confirm`, {
        request_id: `margin-${jobId}-confirm`,
        payment_method: paymentMethod,
        payment_method_options: { card: { auto_capture: false } },
      });
    }
    return { holdId: intent.id };
  }

  async increment(holdId: string, newTotal: Micros) {
    await this.post(`/api/v1/pa/payment_intents/${holdId}/increment_authorization`, {
      request_id: `margin-${holdId}-inc-${newTotal}`,
      // VERIFY: whether `amount` is the new total or the delta. We pass the new total.
      amount: toMajor(newTotal),
    });
  }

  async capture(holdId: string, amount: Micros) {
    await this.post(`/api/v1/pa/payment_intents/${holdId}/capture`, {
      request_id: `margin-${holdId}-capture`,
      amount: toMajor(amount),
    });
  }

  async cancel(holdId: string, reason: string) {
    await this.post(`/api/v1/pa/payment_intents/${holdId}/cancel`, {
      request_id: `margin-${holdId}-cancel`,
      cancellation_reason: reason, // VERIFY: field name
    });
  }
}
