/**
 * Our own record of every hold and every payment. The chain and Airwallex are
 * reconciled against this, not the other way round.
 *
 * Idempotency rule: a payment is written as `pending` BEFORE money moves, keyed by
 * `${jobId}:${stepId}:${providerId}`. A retry reuses the key and the exact same payload,
 * so the payment rail can dedupe it and nothing is paid twice.
 */
import type { Micros } from "../money.ts";

export type PaymentStatus = "pending" | "paid" | "failed" | "refused";

export interface PaymentRow {
  key: string;
  jobId: string;
  stepId: string;
  providerId: string;
  amount: Micros;
  payTo: string;
  status: PaymentStatus;
  txHash?: string;
  reason?: string;
  attempts: number;
  createdAt: number;
}

export type HoldStatus = "authorized" | "captured" | "cancelled";

export interface HoldRow {
  jobId: string;
  holdId: string;
  authorized: Micros;
  captured: Micros;
  status: HoldStatus;
}

export interface LedgerEvent {
  seq: number;
  at: number;
  jobId: string | null;
  type: string;
  data: Record<string, unknown>;
}

export interface LedgerStore {
  getPayment(key: string): PaymentRow | undefined;
  insertPayment(row: PaymentRow): void;
  updatePayment(key: string, patch: Partial<PaymentRow>): void;
  listPayments(jobId?: string): PaymentRow[];
  getHold(jobId: string): HoldRow | undefined;
  upsertHold(row: HoldRow): void;
  appendEvent(e: Omit<LedgerEvent, "seq">): LedgerEvent;
  listEvents(jobId?: string): LedgerEvent[];
}

export class IdempotencyConflict extends Error {}

export class Ledger {
  constructor(
    private readonly store: LedgerStore,
    private readonly now: () => number = Date.now,
    private readonly onEvent?: (e: LedgerEvent) => void,
  ) {}

  // ---------------------------------------------------------- events

  log(jobId: string | null, type: string, data: Record<string, unknown> = {}): LedgerEvent {
    const e = this.store.appendEvent({ at: this.now(), jobId, type, data });
    this.onEvent?.(e);
    return e;
  }

  events(jobId?: string): LedgerEvent[] {
    return this.store.listEvents(jobId);
  }

  // ---------------------------------------------------------- holds

  recordHold(jobId: string, holdId: string, authorized: Micros): void {
    this.store.upsertHold({ jobId, holdId, authorized, captured: 0, status: "authorized" });
    this.log(jobId, "hold.authorized", { holdId, authorized });
  }

  recordIncrement(jobId: string, newTotal: Micros): void {
    const h = this.mustHold(jobId);
    this.store.upsertHold({ ...h, authorized: newTotal });
    this.log(jobId, "hold.incremented", { holdId: h.holdId, from: h.authorized, to: newTotal });
  }

  recordCapture(jobId: string, amount: Micros): void {
    const h = this.mustHold(jobId);
    this.store.upsertHold({ ...h, captured: amount, status: "captured" });
    this.log(jobId, "hold.captured", { holdId: h.holdId, captured: amount, released: h.authorized - amount });
  }

  recordCancel(jobId: string, reason: string): void {
    const h = this.mustHold(jobId);
    this.store.upsertHold({ ...h, status: "cancelled" });
    this.log(jobId, "hold.cancelled", { holdId: h.holdId, released: h.authorized, reason });
  }

  hold(jobId: string): HoldRow | undefined {
    return this.store.getHold(jobId);
  }

  private mustHold(jobId: string): HoldRow {
    const h = this.store.getHold(jobId);
    if (!h) throw new Error(`no hold for job ${jobId}`);
    return h;
  }

  // ---------------------------------------------------------- payments

  /**
   * Start (or resume) a payment. Returns the existing row if this key was seen before.
   * A different payload under the same key is a bug and throws.
   */
  beginPayment(p: { key: string; jobId: string; stepId: string; providerId: string; amount: Micros; payTo: string }): PaymentRow {
    const existing = this.store.getPayment(p.key);
    if (existing) {
      if (existing.amount !== p.amount || existing.payTo !== p.payTo || existing.providerId !== p.providerId) {
        throw new IdempotencyConflict(`payment ${p.key} retried with a different payload`);
      }
      this.store.updatePayment(p.key, { attempts: existing.attempts + 1 });
      return { ...existing, attempts: existing.attempts + 1 };
    }
    const row: PaymentRow = { ...p, status: "pending", attempts: 1, createdAt: this.now() };
    this.store.insertPayment(row);
    this.log(p.jobId, "payment.pending", { key: p.key, providerId: p.providerId, amount: p.amount });
    return row;
  }

  markPaid(key: string, txHash: string): void {
    const row = this.mustPayment(key);
    if (row.status === "paid") return;
    this.store.updatePayment(key, { status: "paid", txHash });
    this.log(row.jobId, "payment.paid", { key, providerId: row.providerId, amount: row.amount, txHash });
  }

  markFailed(key: string, reason: string): void {
    const row = this.mustPayment(key);
    if (row.status === "paid") throw new Error(`cannot fail paid payment ${key}`);
    this.store.updatePayment(key, { status: "failed", reason });
    this.log(row.jobId, "payment.failed", { key, reason });
  }

  /** Record a refused 402 for the audit trail. No money moves. */
  recordRefusal(p: { jobId: string; stepId: string; providerId: string; quoted: Micros; payTo: string; reason: string }): void {
    const key = `${p.jobId}:${p.stepId}:${p.providerId}:refused`;
    if (!this.store.getPayment(key)) {
      this.store.insertPayment({
        key,
        jobId: p.jobId,
        stepId: p.stepId,
        providerId: p.providerId,
        amount: p.quoted,
        payTo: p.payTo,
        status: "refused",
        reason: p.reason,
        attempts: 1,
        createdAt: this.now(),
      });
    }
    this.log(p.jobId, "payment.refused", { providerId: p.providerId, quoted: p.quoted, reason: p.reason });
  }

  private mustPayment(key: string): PaymentRow {
    const row = this.store.getPayment(key);
    if (!row) throw new Error(`unknown payment ${key}`);
    return row;
  }

  payments(jobId?: string): PaymentRow[] {
    return this.store.listPayments(jobId);
  }

  spent(jobId: string): Micros {
    return this.sum(jobId, "paid");
  }

  inFlight(jobId: string): Micros {
    return this.sum(jobId, "pending");
  }

  private sum(jobId: string, status: PaymentStatus): Micros {
    return this.store
      .listPayments(jobId)
      .filter((p) => p.status === status)
      .reduce((s, p) => s + p.amount, 0);
  }
}

// ---------------------------------------------------------------- in-memory store

export class MemoryStore implements LedgerStore {
  private payments = new Map<string, PaymentRow>();
  private holds = new Map<string, HoldRow>();
  private events: LedgerEvent[] = [];

  getPayment(key: string) {
    const r = this.payments.get(key);
    return r ? { ...r } : undefined;
  }
  insertPayment(row: PaymentRow) {
    if (this.payments.has(row.key)) throw new IdempotencyConflict(`duplicate payment key ${row.key}`);
    this.payments.set(row.key, { ...row });
  }
  updatePayment(key: string, patch: Partial<PaymentRow>) {
    const r = this.payments.get(key);
    if (!r) throw new Error(`unknown payment ${key}`);
    this.payments.set(key, { ...r, ...patch, key });
  }
  listPayments(jobId?: string) {
    return [...this.payments.values()].filter((p) => !jobId || p.jobId === jobId).map((p) => ({ ...p }));
  }
  getHold(jobId: string) {
    const h = this.holds.get(jobId);
    return h ? { ...h } : undefined;
  }
  upsertHold(row: HoldRow) {
    this.holds.set(row.jobId, { ...row });
  }
  appendEvent(e: Omit<LedgerEvent, "seq">) {
    const ev = { ...e, seq: this.events.length + 1 };
    this.events.push(ev);
    return ev;
  }
  listEvents(jobId?: string) {
    return this.events.filter((e) => !jobId || e.jobId === jobId);
  }
}
