import type { Meta, RailStatus } from "@/lib/protocol";

const LABEL: Record<RailStatus["source"], string> = {
  live: "LIVE",
  simulated: "SIMULATED",
  off: "OFF",
  "not built": "NOT BUILT",
};

export function Header({ meta, connected }: { meta: Meta | null; connected: boolean }) {
  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden>
          M
        </span>
        <div>
          <h1>Margin</h1>
          <p className="muted">Buys every AI step at the best price that fits the customer&apos;s hold.</p>
        </div>
      </div>
      <div className="header-right">
        <span className={`mode mode-${meta?.mode ?? "mock"}`}>MODE: {(meta?.mode ?? "mock").toUpperCase()}</span>
        <span className={`conn ${connected ? "ok" : "bad"}`}>{connected ? "engine connected" : "engine offline"}</span>
      </div>
      <ul className="rails" aria-label="Rails">
        {(meta?.rails ?? []).map((r) => (
          <li key={r.rail} title={r.detail}>
            <span className="rail-name">{r.rail}</span>
            <span className={`badge badge-${r.source.replace(" ", "-")}`}>{LABEL[r.source]}</span>
          </li>
        ))}
      </ul>
    </header>
  );
}
