import type { RunSummary } from "@/lib/protocol";
import { fmt } from "@/lib/state";

const short = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "—");

export function Reconciliation({ summary }: { summary: RunSummary }) {
  const rows = [...summary.jobs.map((j) => ({ id: `Job ${j.jobId}`, ...j })), { id: "Total", ...summary.totals }];
  return (
    <section className={`card recon ${summary.reconciled ? "passed" : "failed"}`} aria-label="Reconciliation">
      <div className="recon-head">
        <h3>Reconciliation</h3>
        <span className={`recon-verdict ${summary.reconciled ? "good" : "bad"}`}>
          {summary.reconciled ? "✓ Every dollar accounted for" : "✗ Mismatch"}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>Ledger paid</th>
            <th>
              Rail settled <span className="badge badge-simulated">SIM</span>
            </th>
            <th>
              Clearing redeemed <span className="badge badge-simulated">SIM</span>
            </th>
            <th>
              Airwallex captured <span className="badge badge-simulated">SIM</span>
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ok = r.ledgerPaid === r.railSettled && r.railSettled === r.clearingRedeemed && r.clearingRedeemed === r.captured;
            return (
              <tr key={r.id} className={r.id === "Total" ? "total" : ""}>
                <th scope="row">{r.id}</th>
                <td className="num">{fmt(r.ledgerPaid)}</td>
                <td className="num">{fmt(r.railSettled)}</td>
                <td className="num">{fmt(r.clearingRedeemed)}</td>
                <td className="num">{fmt(r.captured)}</td>
                <td className={ok ? "good" : "bad"}>{ok ? "✓" : "✗"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">
        Float {fmt(summary.totals.floatDeposited)} deposited, {fmt(summary.totals.floatWithdrawn)} withdrawn unused. Invariant check:{" "}
        {summary.violations.length ? summary.violations.join("; ") : "0 violations"}.
        {summary.llm && ` LLM: ${summary.llm.calls} calls, ${summary.llm.failures} failed${summary.llm.tripped ? `, switched off (${summary.llm.tripped})` : ""}.`}
      </p>
    </section>
  );
}

export function Receipts({ summary }: { summary: RunSummary }) {
  return (
    <section className="receipts" aria-label="Receipts">
      {summary.jobs.map((j) => {
        const saved = j.premiumOnly - j.captured;
        return (
          <article key={j.jobId} className="card receipt">
            <header className="receipt-head">
              <h3>
                Receipt · job {j.jobId} · {j.customer}
              </h3>
              <span className={`chip chip-${j.status === "completed" ? "done" : j.status}`}>{j.status === "completed" ? "done" : j.status.replace("_", "-")}</span>
            </header>
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Provider</th>
                  <th>List price</th>
                  <th>Paid</th>
                  <th>
                    Metal tx <span className="badge badge-simulated">SIM</span>
                  </th>
                  <th>
                    Clearing total <span className="badge badge-simulated">SIM</span>
                  </th>
                  <th>Policy reason</th>
                </tr>
              </thead>
              <tbody>
                {j.receipt.map((r, i) => (
                  <tr key={i} className={r.status === "refused" ? "refused" : ""}>
                    <td>{r.stepId}</td>
                    <td>{r.providerId}</td>
                    <td className="num">{fmt(r.listPrice)}</td>
                    <td className="num">{r.status === "refused" ? `refused (asked ${fmt(r.quoted)})` : fmt(r.paid)}</td>
                    <td className="mono" title={r.txHash ? `${r.txHash} (mock rail: not on any chain)` : undefined}>
                      {short(r.txHash)}
                    </td>
                    <td className="num">{r.clearingTotal !== undefined ? fmt(r.clearingTotal) : "—"}</td>
                    <td className="small">{r.why ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="receipt-foot">
              <div>
                <dt>Hold</dt>
                <dd className="num">
                  {fmt(j.holdInitial)}
                  {j.holdFinal !== j.holdInitial && ` → ${fmt(j.holdFinal)}`}
                </dd>
              </div>
              <div>
                <dt>Captured</dt>
                <dd className="num big">{fmt(j.captured)}</dd>
              </div>
              <div>
                <dt>Released</dt>
                <dd className="num">{fmt(j.released)}</dd>
              </div>
              <div>
                <dt>Premium-only, full plan</dt>
                <dd className="num">
                  {fmt(j.premiumOnly)} <span className="good">(saved {fmt(saved)})</span>
                </dd>
              </div>
            </dl>
            {j.dropped.length > 0 && <p className="small muted">Dropped to stay within the hold: {j.dropped.join(", ")}</p>}
            {j.report.length > 0 && (
              <details className="report">
                <summary>Report ({j.report.length} sections, written by the LLM behind mock-priced providers)</summary>
                {j.report.map((s) => (
                  <div key={s.stepId}>
                    <h4>
                      {s.stepId} <span className="muted small">({s.providerId})</span>
                    </h4>
                    {s.text.split(/\n\s*\n/).map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}
