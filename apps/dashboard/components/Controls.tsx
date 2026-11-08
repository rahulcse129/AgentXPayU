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

/** Faults to throw at a running batch. Starting a run lives in the page header. */
export function Controls({ running, onControl }: { running: boolean; onControl: (a: ControlAction) => void }) {
  return (
    <section className="card controls" aria-label="Inject faults">
      <div className="card-head">
        <h3>Inject faults</h3>
        <p className="muted small">
          {running
            ? "The scripted run already overruns B, slows the 1¢ model and sends a rogue. Add more here."
            : "Available while a run is in progress."}
        </p>
      </div>
      <div className="fault-buttons">
        {BUTTONS.map((b) => (
          <button key={b.action} className={`btn small-btn ${b.tone ?? ""}`} disabled={!running} onClick={() => onControl(b.action)}>
            {b.label}
          </button>
        ))}
      </div>
      <div className="mandate-test">
        <button
          className="btn small-btn bad"
          disabled={!running}
          onClick={() => onControl("mandate_test")}
          title="Deliberate test: turns OUR quote check off and sends the rogue to an unregistered address. Only the Metal mandate is left to refuse it; our check comes back on after the refusal."
        >
          Disable our quote check (mandate test)
        </button>
        <p className="muted small">Turns our own check off for one attempt, so only the Metal mandate stands between the rogue and the money.</p>
      </div>
    </section>
  );
}
