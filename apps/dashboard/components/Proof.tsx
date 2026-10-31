import type { Meta } from "@/lib/protocol";

export function Proof({ meta }: { meta: Meta | null }) {
  const p = meta?.proof;
  if (!p) {
    return (
      <section className="card proof">
        <h3>Proof</h3>
        <p className="muted">No sim-report.json yet. Run npm run sim in the engine.</p>
      </section>
    );
  }
  return (
    <section className={`card proof ${p.passed ? "passed" : "failed"}`} aria-label="Simulation proof">
      <h3>Proof</h3>
      <p className="proof-badge">
        <span className="check" aria-hidden>
          {p.passed ? "✓" : "✗"}
        </span>
        {p.badge}
      </p>
      {p.clearingBadge && <p className="small muted">{p.clearingBadge}</p>}
      <p className="small muted">Seeded random scenarios, checked after every run · {new Date(p.generatedAt).toLocaleString()}</p>
      {meta?.sabotage && (
        <details>
          <summary>Sabotage results: do the checks catch a broken engine?</summary>
          <ul className="sabotage">
            {meta.sabotage.results.map((r) => (
              <li key={r.name}>
                <span className={r.caught ? "good" : "bad"}>{r.caught ? "CAUGHT" : "MISSED"}</span> {r.name}: {r.flagged.toLocaleString()} of {r.runs.toLocaleString()} runs flagged
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
