"use client";
import type { ControlAction } from "@/lib/protocol";

const BUTTONS: { action: ControlAction; label: string; tone?: "bad" }[] = [
  { action: "overrun_b", label: "Trigger overrun (job B ×4)" },
  { action: "slow_lite", label: "Slow down 1¢ model" },
  { action: "rogue_overquote", label: "Rogue provider: overquote", tone: "bad" },
  { action: "rogue_wrong_payee", label: "Rogue provider: wrong payee", tone: "bad" },
  { action: "rogue_junk", label: "Rogue provider: junk", tone: "bad" },
  { action: "rogue_honest", label: "Rogue provider: honest" },
];

export function Controls({
  running,
  onRun,
  onControl,
  toast,
}: {
  running: boolean;
  onRun: (scripted: boolean) => void;
  onControl: (a: ControlAction) => void;
  toast: { ok: boolean; message: string } | null;
}) {
  return (
    <section className="card controls" aria-label="Demo controls">
      <h3>Demo controls</h3>
      <div className="run-buttons">
        <button className="btn primary" disabled={running} onClick={() => onRun(true)}>
          Run scripted demo
        </button>
        <button className="btn" disabled={running} onClick={() => onRun(false)}>
          Run, faults by hand
        </button>
      </div>
      <p className="small muted">Scripted: B overruns ×4 and the 1¢ model slows at round 2, C overruns at round 3, the rogue overquotes. You answer every hold increase.</p>
      <div className="fault-buttons">
        {BUTTONS.map((b) => (
          <button key={b.action} className={`btn small-btn ${b.tone ?? ""}`} disabled={!running} onClick={() => onControl(b.action)}>
            {b.label}
          </button>
        ))}
        <button className="btn small-btn" onClick={() => onControl("mandate_test")} title="Needs Metal mandates (§5.3), not built yet">
          Disable our quote check (mandate test) · not built
        </button>
      </div>
      {toast && (
        <p className={`toast ${toast.ok ? "ok" : "bad"}`} role="status">
          {toast.message}
        </p>
      )}
    </section>
  );
}
