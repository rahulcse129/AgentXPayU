import { fmt, type Approval, type JobView, statusOf } from "@/lib/state";

const CHIP: Record<string, string> = {
  queued: "queued",
  running: "running",
  waiting: "waiting for approval",
  budget_limited: "budget-limited",
  done: "done",
  failed: "failed",
};

export function JobCard({ job, approval, running }: { job: JobView; approval: Approval | null; running: boolean }) {
  const status = statusOf(job, approval, running);
  const label = job.finished && job.limited ? "done · budget-limited" : CHIP[status];
  const hold = job.hold || job.holdInitial;
  const pct = hold ? Math.min(100, (job.spent / hold) * 100) : 0;
  const settled = job.stepsDone + job.dropped.length;

  return (
    <article className={`card job job-${status}`}>
      <header className="job-head">
        <div>
          <span className="job-id">{job.id}</span>
          <h2>{job.customer}</h2>
          <p className="muted small">{job.topic}</p>
        </div>
        <span className={`chip chip-${status}`}>{label}</span>
      </header>

      <div className="job-money">
        <div>
          <div className="label">Spent</div>
          <div className="big num">{fmt(job.spent)}</div>
        </div>
        <div className="right">
          <div className="label">Card hold</div>
          <div className="big num">{fmt(hold)}</div>
        </div>
      </div>
      <div className="meter" role="img" aria-label={`${fmt(job.spent)} of ${fmt(hold)} hold spent`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      {job.increments.length > 0 && (
        <p className="small increments">
          Hold raised {job.increments.map((i) => `${fmt(i.from)} → ${fmt(i.to)}`).join(", ")} after customer approval
        </p>
      )}

      <dl className="job-facts">
        <div>
          <dt>Steps</dt>
          <dd className="num">
            {job.stepsDone} done{job.dropped.length ? `, ${job.dropped.length} dropped` : ""} / {job.stepsTotal}
          </dd>
        </div>
        <div>
          <dt>Now buying</dt>
          <dd>{job.currentStep ? `${job.currentStep} from ${job.currentProvider}` : settled >= job.stepsTotal || job.finished ? "—" : "…"}</dd>
        </div>
        {job.captured !== null && (
          <div>
            <dt>Settled</dt>
            <dd className="num">
              captured {fmt(job.captured)}, released {fmt(job.released ?? 0)}
            </dd>
          </div>
        )}
      </dl>
    </article>
  );
}
