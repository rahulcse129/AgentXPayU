"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
import { ENGINE_URL, type ControlAction, type Meta, type SessionMessage } from "@/lib/protocol";
import { EMPTY, fmt, reduce } from "@/lib/state";
import { EnvBanner, PageHeader, Sidebar, VIEWS, type View } from "@/components/Shell";
import { JobCard } from "@/components/JobCard";
import { Feed, RecentFeed } from "@/components/Feed";
import { ApprovalModal } from "@/components/ApprovalModal";
import { CardModal } from "@/components/CardModal";
import { Controls } from "@/components/Controls";
import { Proof } from "@/components/Proof";
import { Rails } from "@/components/Rails";
import { Receipts, Reconciliation } from "@/components/Settlement";

async function post(path: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${ENGINE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: boolean; message?: string };
  } catch {
    return { ok: false, message: `engine unreachable at ${ENGINE_URL}` };
  }
}

const isView = (s: string): s is View => VIEWS.some((v) => v.id === s);

export default function Dashboard() {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; message: string } | null>(null);
  const [view, setViewState] = useState<View>("overview");

  // The view lives in the URL hash, so a reload (or a shared link) keeps it.
  useEffect(() => {
    const fromHash = () => {
      const h = location.hash.slice(1);
      if (isView(h)) setViewState(h);
    };
    fromHash();
    addEventListener("hashchange", fromHash);
    return () => removeEventListener("hashchange", fromHash);
  }, []);
  const setView = useCallback((v: View) => {
    setViewState(v);
    history.replaceState(null, "", `#${v}`);
    scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const loadMeta = () =>
      fetch(`${ENGINE_URL}/api/meta`)
        .then((r) => r.json())
        .then((m: Meta) => setMeta(m))
        .catch(() => setMeta(null));
    loadMeta();
    const es = new EventSource(`${ENGINE_URL}/api/stream`);
    // Re-read mode and rails whenever the stream (re)connects: the engine may have started, or
    // restarted in another mode, after this page loaded.
    es.onopen = () => {
      setConnected(true);
      loadMeta();
    };
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => dispatch(JSON.parse(ev.data) as SessionMessage);
    return () => es.close();
  }, []);

  const flash = useCallback((t: { ok: boolean; message: string }) => {
    setToast(t);
    setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 5000);
  }, []);

  const run = async (scripted: boolean) => {
    const r = await post("/api/run", { scripted });
    if (!r.ok) flash({ ok: false, message: r.message ?? "Could not start." });
    else setView("overview");
  };
  const control = async (action: ControlAction) => {
    const r = await post("/api/control", { action });
    flash({ ok: r.ok, message: r.message ?? (r.ok ? "Done." : "Refused.") });
  };
  const answer = async (jobId: string, approve: boolean) => {
    await post(approve ? "/api/approve" : "/api/decline", { jobId });
  };

  const jobs = state.order.map((id) => state.jobs[id]!).filter(Boolean);
  const spent = jobs.reduce((a, j) => a + j.spent, 0);
  const refusals = state.feed.filter((f) => f.tone === "refusal").length;
  const summary = state.summary;

  const runStatus = state.error
    ? { text: "Failed", tone: "bad" }
    : summary
      ? summary.reconciled
        ? { text: "Reconciled", tone: "good" }
        : { text: "Mismatch", tone: "bad" }
      : state.running
        ? { text: "Running", tone: "accent" }
        : { text: "Finished", tone: "" };

  const actions = (
    <>
      {state.runId !== null && (
        <span className={`run-pill ${runStatus.tone}`}>
          Run {state.runId} · {runStatus.text}
        </span>
      )}
      <button className="btn" disabled={state.running} onClick={() => run(false)}>
        Run, faults by hand
      </button>
      <button className="btn primary" disabled={state.running} onClick={() => run(true)}>
        Run scripted demo
      </button>
    </>
  );

  return (
    <div className="shell">
      <EnvBanner meta={meta} />
      <div className="app">
        <Sidebar
          view={view}
          onView={setView}
          meta={meta}
          connected={connected}
          marks={{
            activity: state.feed.length ? { text: String(state.feed.length) } : undefined,
            settlement: summary ? (summary.reconciled ? { text: "✓", tone: "good" } : { text: "✗", tone: "bad" }) : undefined,
            proof: meta?.proof ? (meta.proof.passed ? { text: "✓", tone: "good" } : { text: "✗", tone: "bad" }) : undefined,
          }}
        />
        <main className="main">
          <PageHeader view={view} actions={actions} />
          {state.error && <p className="callout bad">Run failed: {state.error}</p>}

          {view === "overview" && (
            <>
              {summary && (
                <div className={`callout ${summary.reconciled ? "good" : "bad"}`}>
                  <span>
                    {summary.reconciled
                      ? `Run ${state.runId} finished: ${fmt(summary.totals.captured)} captured across ${summary.jobs.length} card holds, matching every rail to the cent.`
                      : `Run ${state.runId} finished with a mismatch: ${summary.violations.length} violation(s).`}
                  </span>
                  <button className="link-btn" onClick={() => setView("settlement")}>
                    View settlement →
                  </button>
                </div>
              )}

              <section className="stats" aria-label="Float">
                <div className="stat">
                  <span className="stat-label">Shared float</span>
                  <span className="stat-value num">{fmt(state.float)}</span>
                  <span className="stat-sub">USDZ deposited for the batch</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Reserve left</span>
                  <span className="stat-value num">{fmt(state.reserveLeft)}</span>
                  <span className="stat-sub">Granted to the job closest to finishing</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Spent across jobs</span>
                  <span className="stat-value num">{fmt(spent)}</span>
                  <span className="stat-sub">Paid to providers so far</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Refused</span>
                  <span className={`stat-value num ${refusals ? "bad-ink" : ""}`}>{refusals}</span>
                  <span className="stat-sub">Payments blocked by a lock</span>
                </div>
              </section>

              <section className="section" aria-label="Jobs">
                <div className="section-head">
                  <h2>Jobs</h2>
                  <span className="muted small">{jobs.length ? `${jobs.length} customers` : ""}</span>
                </div>
                {jobs.length ? (
                  <div className="jobs">
                    {jobs.map((j) => (
                      <JobCard key={j.id} job={j} approval={state.approval} running={state.running} />
                    ))}
                  </div>
                ) : (
                  <div className="card empty-state">
                    <p className="empty-title">No run yet</p>
                    <p className="muted">
                      Press <strong>Run scripted demo</strong>. Each customer places a card hold, and you approve or decline the hold increases.
                    </p>
                  </div>
                )}
              </section>

              <div className="two-col">
                <RecentFeed items={state.feed} limit={6} onAll={() => setView("activity")} />
                <Controls running={state.running} onControl={control} />
              </div>

              <Rails meta={meta} />
            </>
          )}

          {view === "activity" && (
            <div className="two-col wide-left">
              <Feed items={state.feed} jobs={state.order} />
              <Controls running={state.running} onControl={control} />
            </div>
          )}

          {view === "settlement" &&
            (summary ? (
              <>
                <Reconciliation summary={summary} />
                <Receipts summary={summary} />
              </>
            ) : (
              <div className="card empty-state">
                <p className="empty-title">{state.running ? "Run in progress" : "Nothing settled yet"}</p>
                <p className="muted">When a run finishes, each card hold is captured and the reconciliation and receipts appear here.</p>
              </div>
            ))}

          {view === "proof" && <Proof meta={meta} />}
        </main>
      </div>

      {toast && (
        <p className={`toast ${toast.ok ? "ok" : "bad"}`} role="status">
          {toast.message}
        </p>
      )}
      {state.cards[0] && !state.approval && <CardModal key={state.cards[0].holdId} card={state.cards[0]} queued={state.cards.length - 1} />}
      {state.approval && <ApprovalModal key={`${state.approval.jobId}-${state.approval.deadline}`} approval={state.approval} onAnswer={answer} />}
    </div>
  );
}
