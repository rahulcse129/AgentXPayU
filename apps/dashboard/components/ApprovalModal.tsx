"use client";
import { useEffect, useState } from "react";
import { fmt, type Approval } from "@/lib/state";

export function ApprovalModal({ approval, onAnswer }: { approval: Approval; onAnswer: (jobId: string, approve: boolean) => Promise<void> }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((approval.deadline - now) / 1000));
  const answer = async (yes: boolean) => {
    setBusy(true);
    try {
      await onAnswer(approval.jobId, yes);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <p className="label">
          {approval.customer} · job {approval.jobId}
        </p>
        <h2 id="approval-title">
          Raise hold from <span className="num">{fmt(approval.current)}</span> to <span className="num">{fmt(approval.newTotal)}</span>?
        </h2>
        <p className="muted">Why: {approval.reason}. Nothing is spent past {fmt(approval.current)} unless you approve and the card issuer accepts.</p>
        <div className="countdown" aria-live="polite">
          <span className="num">{left}s</span> left · no answer counts as a decline
          <div className="meter thin">
            <span style={{ width: `${(left / 30) * 100}%` }} />
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" disabled={busy} onClick={() => answer(false)}>
            Decline
          </button>
          <button className="btn primary" disabled={busy} onClick={() => answer(true)} autoFocus>
            Approve {fmt(approval.newTotal)}
          </button>
        </div>
      </div>
    </div>
  );
}
