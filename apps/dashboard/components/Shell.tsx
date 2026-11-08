/**
 * App shell: environment banner, left navigation, page header. The layout follows the familiar
 * payments-console pattern (dark sidebar, one task per view) with Margin's own brand.
 */
import type { ReactNode } from "react";
import type { Meta } from "@/lib/protocol";

export type View = "overview" | "activity" | "settlement" | "proof";

export const VIEWS: { id: View; label: string; title: string; blurb: string }[] = [
  { id: "overview", label: "Overview", title: "Overview", blurb: "Three customers, three card holds, one shared float." },
  { id: "activity", label: "Activity", title: "Activity", blurb: "Every decision, refusal and hold change, as it happens." },
  { id: "settlement", label: "Settlement", title: "Settlement", blurb: "Each hold captured for exactly what was spent, reconciled against every rail." },
  { id: "proof", label: "Proof", title: "Proof", blurb: "Seeded runs and broken engines, checked by the same invariants." },
];

const ICON: Record<View, ReactNode> = {
  overview: <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  settlement: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />,
  proof: <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5" />,
};

export function EnvBanner({ meta }: { meta: Meta | null }) {
  if (!meta) return <div className="env-banner">Connecting to the Margin engine…</div>;
  const live = meta.rails.filter((r) => r.source === "live").map((r) => r.rail);
  return (
    <div className="env-banner" role="note">
      {live.length ? (
        <>
          Test environment: <strong>{live.join(", ")}</strong> {live.length === 1 ? "is" : "are"} live on sandbox and testnet. No real money moves.
        </>
      ) : (
        <>Simulated environment: every rail is simulated. Start a live engine to use the Airwallex sandbox and Metal testnet.</>
      )}
    </div>
  );
}

export function Sidebar({
  view,
  onView,
  meta,
  connected,
  marks,
}: {
  view: View;
  onView: (v: View) => void;
  meta: Meta | null;
  connected: boolean;
  /** Small counters or ticks shown next to nav items. */
  marks: Partial<Record<View, { text: string; tone?: "good" | "bad" | "warn" }>>;
}) {
  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <span className="sb-logo" aria-hidden>
          M
        </span>
        <div>
          <div className="sb-name">Margin</div>
          <div className="sb-sub">Inference sourcing agent</div>
        </div>
      </div>
      <nav className="sb-nav" aria-label="Views">
        {VIEWS.map((v) => {
          const m = marks[v.id];
          return (
            <button key={v.id} className={`sb-item ${view === v.id ? "active" : ""}`} aria-current={view === v.id ? "page" : undefined} onClick={() => onView(v.id)}>
              <svg viewBox="0 0 24 24" aria-hidden>
                {ICON[v.id]}
              </svg>
              <span>{v.label}</span>
              {m && <span className={`sb-mark ${m.tone ?? ""}`}>{m.text}</span>}
            </button>
          );
        })}
      </nav>
      <div className="sb-foot">
        {/* Never claim a mode before the engine has said which rails are live. */}
        <span className={`mode mode-${meta?.mode ?? "loading"}`}>Mode: {meta ? meta.mode.toUpperCase() : "…"}</span>
        <span className={`conn ${connected ? "ok" : "bad"}`}>{connected ? "Engine connected" : "Engine offline"}</span>
      </div>
    </aside>
  );
}

export function PageHeader({ view, actions }: { view: View; actions: ReactNode }) {
  const v = VIEWS.find((x) => x.id === view)!;
  return (
    <header className="page-head">
      <div>
        <h1>{v.title}</h1>
        <p className="muted">{v.blurb}</p>
      </div>
      <div className="page-actions">{actions}</div>
    </header>
  );
}
