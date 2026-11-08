import type { Meta } from "@/lib/protocol";

export function Proof({ meta }: { meta: Meta | null }) {
  const p = meta?.proof;
  if (!p) {
    return (
      <section className="card proof">
        <h3>Simulation</h3>
        <p className="muted">No sim-report.json yet. Run npm run sim in the engine.</p>
      </section>
    );
  }
  return (
    <>
      <section className={`card proof ${p.passed ? "passed" : "failed"}`} aria-label="Simulation proof">
        <div className="card-head">
          <h3>Simulation</h3>
          <p className="muted small">Seeded random scenarios, checked after every run · {new Date(p.generatedAt).toLocaleString()}</p>
        </div>
        <p className="proof-badge">
          <span className="check" aria-hidden>
            {p.passed ? "✓" : "✗"}
          </span>
          {p.badge}
        </p>
        {p.clearingBadge && <p className="muted">{p.clearingBadge}</p>}
      </section>
      {meta?.sabotage && (
        <section className="card" aria-label="Sabotage results">
          <div className="card-head">
            <h3>Sabotage</h3>
            <p className="muted small">The same checks, run against engines broken on purpose. Each break must be caught.</p>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Broken engine</th>
                  <th>Result</th>
                  <th className="num">Runs flagged</th>
                </tr>
              </thead>
              <tbody>
                {meta.sabotage.results.map((r) => (
                  <tr key={r.name}>
                    <td className="strong">{r.name}</td>
                    <td>
                      <span className={`badge ${r.caught ? "badge-live" : "badge-bad"}`}>{r.caught ? "CAUGHT" : "MISSED"}</span>
                    </td>
                    <td className="num">
                      {r.flagged.toLocaleString()} of {r.runs.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
