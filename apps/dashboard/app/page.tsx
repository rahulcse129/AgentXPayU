"use client";
import { useCallback, useEffect, useReducer, useState } from "react";
import { ENGINE_URL, type ControlAction, type Meta, type SessionMessage } from "@/lib/protocol";
import { EMPTY, fmt, reduce } from "@/lib/state";
import { Header } from "@/components/Header";
import { JobCard } from "@/components/JobCard";
import { Feed } from "@/components/Feed";
import { ApprovalModal } from "@/components/ApprovalModal";
import { Controls } from "@/components/Controls";
import { Proof } from "@/components/Proof";
import { Receipts, Reconciliation } from "@/components/Settlement";

async function post(path: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${ENGINE_URL}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as { ok: boolean; message?: string };
  } catch (e) {
    return { ok: false, message: `engine unreachable at ${ENGINE_URL}` };
  }
}

export default function Dashboard() {
  const [state, dispatch] = useReducer(reduce, EMPTY);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/meta`)
      .then((r) => r.json())
      .then((m: Meta) => setMeta(m))
      .catch(() => setMeta(null));
    const es = new EventSource(`${ENGINE_URL}/api/stream`);
    es.onopen = () => setConnected(true);
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

  return (
    <main className="page">
      <Header meta={meta} connected={connected} />

      <section className="float-strip" aria-label="Float">
        <div>
          <span className="label">Shared float</span> <span className="num">{fmt(state.float)} USDZ</span>
        </div>
        <div>
          <span className="label">Reserve left</span> <span className="num">{fmt(state.reserveLeft)}</span>
        </div>
        <div>
          <span className="label">Spent across jobs</span> <span className="num">{fmt(spent)}</span>
        </div>
        <div className="muted small">{state.runId ? `Run ${state.runId}${state.running ? " · running" : " · finished"}` : "No run yet"}</div>
      </section>

      <section className="jobs">
        {jobs.length ? (
          jobs.map((j) => <JobCard key={j.id} job={j} approval={state.approval} running={state.running} />)
        ) : (
          <div className="card empty-jobs">
            <p className="big">Three customers, three card holds, one shared float.</p>
            <p className="muted">Press “Run scripted demo”. You will be asked to approve or decline hold increases.</p>
          </div>
        )}
      </section>

      <section className="split">
        <Feed items={state.feed} />
        <div className="side">
          <Controls running={state.running} onRun={run} onControl={control} toast={toast} />
          <Proof meta={meta} />
        </div>
      </section>

      {state.error && <p className="card bad">Run failed: {state.error}</p>}
      {state.summary && (
        <>
          <Reconciliation summary={state.summary} />
          <Receipts summary={state.summary} />
        </>
      )}

      {state.approval && <ApprovalModal key={`${state.approval.jobId}-${state.approval.deadline}`} approval={state.approval} onAnswer={answer} />}
    </main>
  );
}
