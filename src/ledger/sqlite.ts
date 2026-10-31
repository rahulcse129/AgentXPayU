/**
 * SQLite-backed ledger store using Node's built-in `node:sqlite` (Node >= 22.13).
 * The UNIQUE key on payments is the database-level guarantee behind "never paid twice".
 */
import { DatabaseSync } from "node:sqlite";
import { IdempotencyConflict, type HoldRow, type LedgerEvent, type LedgerStore, type PaymentRow } from "./ledger.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  key         TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL,
  step_id     TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount >= 0),
  pay_to      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','paid','failed','refused')),
  tx_hash     TEXT,
  reason      TEXT,
  attempts    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_job ON payments(job_id);
CREATE TABLE IF NOT EXISTS holds (
  job_id     TEXT PRIMARY KEY,
  hold_id    TEXT NOT NULL,
  authorized INTEGER NOT NULL,
  captured   INTEGER NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('authorized','captured','cancelled')),
  CHECK (captured <= authorized)
);
CREATE TABLE IF NOT EXISTS events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  job_id TEXT,
  type   TEXT NOT NULL,
  data   TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

const toPayment = (r: Row): PaymentRow => ({
  key: String(r.key),
  jobId: String(r.job_id),
  stepId: String(r.step_id),
  providerId: String(r.provider_id),
  amount: Number(r.amount),
  payTo: String(r.pay_to),
  status: r.status as PaymentRow["status"],
  txHash: r.tx_hash == null ? undefined : String(r.tx_hash),
  reason: r.reason == null ? undefined : String(r.reason),
  attempts: Number(r.attempts),
  createdAt: Number(r.created_at),
});

export class SqliteStore implements LedgerStore {
  private db: DatabaseSync;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  getPayment(key: string) {
    const r = this.db.prepare("SELECT * FROM payments WHERE key = ?").get(key) as Row | undefined;
    return r ? toPayment(r) : undefined;
  }

  insertPayment(p: PaymentRow) {
    try {
      this.db
        .prepare(
          `INSERT INTO payments (key, job_id, step_id, provider_id, amount, pay_to, status, tx_hash, reason, attempts, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(p.key, p.jobId, p.stepId, p.providerId, p.amount, p.payTo, p.status, p.txHash ?? null, p.reason ?? null, p.attempts, p.createdAt);
    } catch (e) {
      if (String(e).includes("UNIQUE")) throw new IdempotencyConflict(`duplicate payment key ${p.key}`);
      throw e;
    }
  }

  updatePayment(key: string, patch: Partial<PaymentRow>) {
    const cur = this.getPayment(key);
    if (!cur) throw new Error(`unknown payment ${key}`);
    const n = { ...cur, ...patch };
    this.db
      .prepare("UPDATE payments SET status = ?, tx_hash = ?, reason = ?, attempts = ? WHERE key = ?")
      .run(n.status, n.txHash ?? null, n.reason ?? null, n.attempts, key);
  }

  listPayments(jobId?: string) {
    const rows = (
      jobId
        ? this.db.prepare("SELECT * FROM payments WHERE job_id = ? ORDER BY created_at, key").all(jobId)
        : this.db.prepare("SELECT * FROM payments ORDER BY created_at, key").all()
    ) as Row[];
    return rows.map(toPayment);
  }

  getHold(jobId: string) {
    const r = this.db.prepare("SELECT * FROM holds WHERE job_id = ?").get(jobId) as Row | undefined;
    if (!r) return undefined;
    return {
      jobId: String(r.job_id),
      holdId: String(r.hold_id),
      authorized: Number(r.authorized),
      captured: Number(r.captured),
      status: r.status as HoldRow["status"],
    };
  }

  upsertHold(h: HoldRow) {
    this.db
      .prepare(
        `INSERT INTO holds (job_id, hold_id, authorized, captured, status) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET hold_id = excluded.hold_id, authorized = excluded.authorized,
           captured = excluded.captured, status = excluded.status`,
      )
      .run(h.jobId, h.holdId, h.authorized, h.captured, h.status);
  }

  appendEvent(e: Omit<LedgerEvent, "seq">) {
    const res = this.db
      .prepare("INSERT INTO events (at, job_id, type, data) VALUES (?, ?, ?, ?)")
      .run(e.at, e.jobId, e.type, JSON.stringify(e.data));
    return { ...e, seq: Number(res.lastInsertRowid) };
  }

  listEvents(jobId?: string) {
    const rows = (
      jobId
        ? this.db.prepare("SELECT * FROM events WHERE job_id = ? ORDER BY seq").all(jobId)
        : this.db.prepare("SELECT * FROM events ORDER BY seq").all()
    ) as Row[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: Number(r.at),
      jobId: r.job_id == null ? null : String(r.job_id),
      type: String(r.type),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
    }));
  }

  close() {
    this.db.close();
  }
}
