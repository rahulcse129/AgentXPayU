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
  /** Account ID for `x-login-as`, needed when a scoped key is linked to more than one account. */
  loginAs?: string;
  /** Prefix for request_ids, unique per run, so job ids reused across runs (A, B, C) get new intents. */
  runTag?: string;
  /**
   * Waits between attempts when a call fails transiently (network error or 5xx). Every POST carries a
   * deterministic request_id, so a retry is deduped by Airwallex, never repeated. Default 1s, 3s, 8s, 20s (rides out ~30s of network loss).
   */
  retryDelaysMs?: number[];
}

/** The fields of a PaymentIntent we read back. Amounts are decimal major units. */
export interface AirwallexIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  captured_amount?: number;
  merchant_order_id?: string;
  latest_payment_attempt?: { status?: string; amount?: number; captured_amount?: number; authorization_code?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export class AirwallexHoldGateway implements HoldGateway {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly baseUrl: string;
  private readonly currency: string;

  constructor(private readonly cfg: AirwallexConfig) {
    // The sandbox host in Airwallex's docs; api-demo.airwallex.com reaches the same sandbox.
    this.baseUrl = cfg.baseUrl || "https://api.sandbox.airwallex.com";
    this.currency = cfg.currency ?? "USD";
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, runTag?: string): AirwallexHoldGateway {
    const clientId = env.AIRWALLEX_CLIENT_ID;
    const apiKey = env.AIRWALLEX_API_KEY;
    if (!clientId || !apiKey) throw new Error("set AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY (sandbox)");
    return new AirwallexHoldGateway({
      clientId,
      apiKey,
      baseUrl: env.AIRWALLEX_BASE_URL,
      loginAs: env.AIRWALLEX_LOGIN_AS || undefined,
      runTag,
    });
  }

  private async auth(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1/authentication/login`, {
        method: "POST",
        headers: {
          "x-client-id": this.cfg.clientId,
          "x-api-key": this.cfg.apiKey,
          ...(this.cfg.loginAs ? { "x-login-as": this.cfg.loginAs } : {}),
        },
      });
    } catch (e) {
      throw new TransientError(`airwallex login: ${String(e)}`);
    }
    if (res.status >= 500) throw new TransientError(`airwallex login: ${res.status} ${await res.text()}`);
    if (!res.ok) throw new Error(`airwallex login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; expires_at?: string };
    const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 25 * 60_000;
    this.token = { value: body.token, expiresAt };
    return body.token;
  }

  /** One authenticated call, retried with backoff while it fails transiently. Returns the body text. */
  private async send(label: string, path: string, init: { method: "GET" | "POST"; body?: string }): Promise<string> {
    const delays = this.cfg.retryDelaysMs ?? [1000, 3000, 8000, 20_000];
    for (let attempt = 0; ; attempt++) {
      try {
        const token = await this.auth();
        let res: Response;
        try {
          res = await fetch(`${this.baseUrl}${path}`, {
            method: init.method,
            headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
            body: init.body,
          });
        } catch (e) {
          throw new TransientError(`${label}: ${String(e)}`);
        }
        const text = await res.text();
        if (res.status >= 500) throw new TransientError(`${label}: ${res.status} ${text}`);
        if (res.status === 401) this.token = null; // expired token: log in again on the next call
        if (!res.ok) {
          if (text.includes("decline")) throw new IssuerDeclined(`${label}: ${text}`);
          throw new Error(`${label}: ${res.status} ${text}`);
        }
        return text;
      } catch (e) {
        if (!(e instanceof TransientError) || attempt >= delays.length) throw e;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return JSON.parse(await this.send(`airwallex ${path}`, path, { method: "POST", body: JSON.stringify(body) })) as T;
  }

  get currencyCode(): string {
    return this.currency;
  }

  /**
   * Create the PaymentIntent the customer will confirm (no card involved). request_id is
   * deterministic per (run, job), so a retried create returns the same intent instead of a second one.
   */
  async createIntent({ jobId, amount }: { jobId: string; amount: Micros }): Promise<{ holdId: string; clientSecret: string; currency: string }> {
    const tag = this.cfg.runTag ? `${this.cfg.runTag}-` : "";
    const intent = await this.post<{ id: string; client_secret: string }>("/api/v1/pa/payment_intents/create", {
      request_id: `margin-${tag}${jobId}-create`,
      merchant_order_id: `margin-${tag}${jobId}`,
      amount: toMajor(amount),
      currency: this.currency,
    });
    return { holdId: intent.id, clientSecret: intent.client_secret, currency: this.currency };
  }

  async authorize({ jobId, amount, paymentMethod }: { jobId: string; amount: Micros; paymentMethod?: unknown }) {
    const intent = { id: (await this.createIntent({ jobId, amount })).holdId };
    if (paymentMethod) {
      // Per the API reference, authorization_type and auto_capture are "only applicable when
      // payment_method is provided", so they go on confirm, not create. pre_auth is what makes
      // increment_authorization possible (Visa and Mastercard only); auto_capture false keeps it a hold.
      await this.post(`/api/v1/pa/payment_intents/${intent.id}/confirm`, {
        request_id: `margin-${jobId}-confirm`,
        payment_method: paymentMethod,
        payment_method_options: { card: { authorization_type: "pre_auth", auto_capture: false } },
      });
    }
    return { holdId: intent.id };
  }

  /** Read an intent back: status and amounts, for the smoke test, receipts and the startup sweeper. */
  async retrieve(holdId: string): Promise<AirwallexIntent> {
    const text = await this.send(`airwallex retrieve ${holdId}`, `/api/v1/pa/payment_intents/${holdId}`, { method: "GET" });
    return JSON.parse(text) as AirwallexIntent;
  }

  async increment(holdId: string, newTotal: Micros) {
    await this.post(`/api/v1/pa/payment_intents/${holdId}/increment_authorization`, {
      request_id: `margin-${holdId}-inc-${newTotal}`,
      // `amount` is the new total, not the delta: confirmed in the sandbox 2026-11-09 (0.75 raised with 1.24 reads back 1.24).
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
      cancellation_reason: reason, // accepted by the sandbox (2026-11-09)
    });
  }
}
