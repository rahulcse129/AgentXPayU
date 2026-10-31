/**
 * In-memory stand-in for Airwallex payment intents with manual capture.
 * It enforces the same rules the real API does, and it RECORDS any attempt to break them
 * so the simulation can prove Margin never tries.
 */
import type { Micros } from "../money.ts";
import { HoldViolation, IssuerDeclined, type HoldGateway } from "./types.ts";

export interface MockHold {
  holdId: string;
  jobId: string;
  authorized: Micros;
  captured: Micros;
  status: "authorized" | "captured" | "cancelled";
  history: { op: string; amount: Micros }[];
}

export class MockAirwallex implements HoldGateway {
  readonly holds = new Map<string, MockHold>();
  readonly violations: string[] = [];
  private n = 0;

  constructor(
    private readonly opts: { incrementDeclineRate?: number; authorizeDeclineRate?: number; rng?: () => number } = {},
  ) {}

  private roll(rate = 0): boolean {
    return rate > 0 && (this.opts.rng ?? Math.random)() < rate;
  }

  async authorize({ jobId, amount }: { jobId: string; amount: Micros }) {
    if (this.roll(this.opts.authorizeDeclineRate)) throw new IssuerDeclined(`card declined for ${jobId}`);
    const holdId = `int_mock_${++this.n}_${jobId}`;
    this.holds.set(holdId, { holdId, jobId, authorized: amount, captured: 0, status: "authorized", history: [{ op: "authorize", amount }] });
    return { holdId };
  }

  async increment(holdId: string, newTotal: Micros) {
    const h = this.must(holdId);
    if (h.status !== "authorized") return this.violate(`increment on ${h.status} hold ${holdId}`);
    if (newTotal <= h.authorized) return this.violate(`increment to ${newTotal} is not above ${h.authorized}`);
    if (this.roll(this.opts.incrementDeclineRate)) throw new IssuerDeclined(`issuer declined increment on ${holdId}`);
    h.authorized = newTotal;
    h.history.push({ op: "increment", amount: newTotal });
  }

  async capture(holdId: string, amount: Micros) {
    const h = this.must(holdId);
    if (h.status !== "authorized") return this.violate(`capture on ${h.status} hold ${holdId}`);
    if (amount > h.authorized) return this.violate(`capture ${amount} exceeds authorized ${h.authorized} on ${holdId}`);
    if (amount <= 0) return this.violate(`capture of ${amount} on ${holdId}; cancel instead`);
    h.captured = amount;
    h.status = "captured";
    h.history.push({ op: "capture", amount });
  }

  async cancel(holdId: string, _reason: string) {
    const h = this.must(holdId);
    if (h.status !== "authorized") return this.violate(`cancel on ${h.status} hold ${holdId}`);
    h.status = "cancelled";
    h.history.push({ op: "cancel", amount: 0 });
  }

  private must(holdId: string): MockHold {
    const h = this.holds.get(holdId);
    if (!h) throw new Error(`unknown hold ${holdId}`);
    return h;
  }

  private violate(msg: string): never {
    this.violations.push(msg);
    throw new HoldViolation(msg);
  }
}
