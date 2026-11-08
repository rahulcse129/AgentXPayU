import type { RunSummary } from "@/lib/protocol";
import { fmt } from "@/lib/state";

const short = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : "—");

function SourceBadge({ source }: { source: "live" | "simulated" }) {
  return source === "live" ? <span className="badge badge-live">LIVE</span> : <span className="badge badge-simulated">SIM</span>;
}

const EXPLORER = "https://testnet.metalntwx.com/tx/";
const TxLink = ({ label, hash }: { label: string; hash?: string | null }) =>
  hash && /^0x[0-9a-fA-F]{64}$/.test(hash) ? (
    <a href={`${EXPLORER}${hash}`} target="_blank" rel="noopener noreferrer">
      {label} {short(hash)} ↗
    </a>
  ) : null;

/** Both locks every payment passed: our policy check, then the Metal mandate it was paid through. */
function Locks({ summary }: { summary: RunSummary }) {
  const m = summary.mandate;
  return (
    <div className="locks" aria-label="Payment locks">
      <span className="lock">
        <span className="good">✓</span> Policy check <span className="muted small">(price list + registered payee, every 402)</span>
      </span>
      <span className="lock-sep">·</span>
      {m ? (
        <span className="lock">
          <span className="good">✓</span> Metal mandate <SourceBadge source={m.source} />{" "}
          <span className="muted small">
            {m.payees} payees · cap {fmt(m.perPaymentCap)} · budget {fmt(m.budget)}
          </span>{" "}
          <TxLink label="bind" hash={m.bindTx} /> <TxLink label="revoke" hash={m.revokeTx} />
        </span>
      ) : (
        <span className="lock muted">Metal mandate: not used in this mode (x402 from the agent wallet)</span>
      )}
    </div>
  );
}

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
      <Locks summary={summary} />
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th />
            <th>Ledger paid</th>
            <th title={summary.rail.source === "live" ? "Each payment re-read from Metal testnet after the run" : "MockMetal's own settlement record"}>
              {summary.rail.source === "live" ? "Settled on chain" : "Rail settled"} <SourceBadge source={summary.rail.source} />
            </th>
            <th>
              Clearing redeemed <span className="badge badge-simulated">SIM</span>
            </th>
            <th>
              Airwallex captured <SourceBadge source={summary.holds.source} />
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
      </div>
      <p className="small muted">
        {summary.rail.source === "live" &&
          `Settled on chain: every payment re-read from ${summary.rail.network} after the run, USDZ sent from ${summary.rail.payer} to each provider. `}
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
            <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Provider</th>
                  <th>List price</th>
                  <th>Paid</th>
                  <th>
                    Metal tx <SourceBadge source={summary.rail.source} />
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
                    <td className="mono" title={r.txHash ? (r.txUrl ? r.txHash : `${r.txHash} (mock rail: not on any chain)`) : undefined}>
                      {r.txUrl ? (
                        <a href={r.txUrl} target="_blank" rel="noopener noreferrer">
                          {short(r.txHash)} ↗
                        </a>
                      ) : (
                        short(r.txHash)
                      )}
                    </td>
                    <td className="num">{r.clearingTotal !== undefined ? fmt(r.clearingTotal) : "—"}</td>
                    <td className="small">{r.why ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <dl className="receipt-foot">
              <div>
                <dt>Hold</dt>
                <dd className="num">
                  {fmt(j.holdInitial)}
                  {j.holdFinal !== j.holdInitial && ` → ${fmt(j.holdFinal)}`}
                </dd>
                {j.holdId && summary.holds.source === "live" && (
                  <dd className="mono small" title="Airwallex PaymentIntent, read back from Airwallex after the run">
                    Airwallex {j.holdId}
                  </dd>
                )}
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
