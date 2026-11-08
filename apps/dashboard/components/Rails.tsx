import type { Meta, RailStatus } from "@/lib/protocol";

const LABEL: Record<RailStatus["source"], string> = {
  live: "LIVE",
  simulated: "SIMULATED",
  off: "OFF",
  "not built": "NOT BUILT",
};

/** Which rails are real in this engine, and what each one does. */
export function Rails({ meta }: { meta: Meta | null }) {
  return (
    <section className="card" aria-label="Rails">
      <div className="card-head">
        <h3>Rails</h3>
        <p className="muted small">What is real in this engine. Every number on screen carries the same label.</p>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Rail</th>
              <th>Status</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {(meta?.rails ?? []).map((r) => (
              <tr key={r.rail}>
                <td className="strong">{r.rail}</td>
                <td>
                  <span className={`badge badge-${r.source.replace(" ", "-")}`}>{LABEL[r.source]}</span>
                </td>
                <td className="muted">{r.detail}</td>
              </tr>
            ))}
            {!meta && (
              <tr>
                <td colSpan={3} className="muted">
                  Waiting for the engine…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
