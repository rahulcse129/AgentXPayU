"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedItem, Tone } from "@/lib/state";

/** The description templates start with "[A] " / "[*] "; the job pill shows that instead. */
const strip = (s: string) => s.replace(/^\[[^\]]+\]\s*/, "");

const KINDS: { id: string; label: string; tones: Tone[] | null }[] = [
  { id: "all", label: "All", tones: null },
  { id: "decisions", label: "Decisions", tones: ["decision"] },
  { id: "refusals", label: "Refusals", tones: ["refusal"] },
  { id: "holds", label: "Holds", tones: ["hold"] },
  { id: "money", label: "Money", tones: ["money", "clearing", "reserve"] },
  { id: "faults", label: "Faults", tones: ["fault"] },
];

function Line({ f }: { f: FeedItem }) {
  return (
    <li className={`feed-item tone-${f.tone}`}>
      <span className="pill">{f.jobId ?? "·"}</span>
      <div>
        <p className="line">{f.phrased ?? strip(f.fact)}</p>
        {f.policy && (f.phrased || !f.fact.includes(f.policy)) && <p className="policy">policy: {f.policy}</p>}
        {f.phrased && <p className="policy">fact: {strip(f.fact)}</p>}
      </div>
    </li>
  );
}

/** The latest few lines, for the overview. */
export function RecentFeed({ items, limit, onAll }: { items: FeedItem[]; limit: number; onAll: () => void }) {
  const recent = items.slice(-limit);
  return (
    <section className="card feed" aria-label="Recent activity">
      <div className="card-head row">
        <h3>Recent activity</h3>
        <button className="link-btn" onClick={onAll}>
          View all {items.length ? `(${items.length})` : ""} →
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="muted empty">Start a run to see every decision, refusal and hold change as it happens.</p>
      ) : (
        <ol className="feed-list">
          {recent.map((f) => (
            <Line key={f.seq} f={f} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** The whole feed, filterable by kind and by job; follows new lines unless you scrolled up. */
export function Feed({ items, jobs }: { items: FeedItem[]; jobs: string[] }) {
  const [kind, setKind] = useState("all");
  const [job, setJob] = useState<string>("all");
  const list = useRef<HTMLOListElement>(null);
  const follow = useRef(true);

  const shown = useMemo(() => {
    const tones = KINDS.find((k) => k.id === kind)?.tones;
    return items.filter((f) => (!tones || tones.includes(f.tone)) && (job === "all" || f.jobId === job));
  }, [items, kind, job]);

  useEffect(() => {
    const el = list.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  const count = (tones: Tone[] | null) => items.filter((f) => !tones || tones.includes(f.tone)).length;

  return (
    <section className="card feed" aria-label="Reasoning feed">
      <div className="feed-tools">
        <div className="segmented" role="tablist" aria-label="Filter by kind">
          {KINDS.map((k) => (
            <button key={k.id} role="tab" aria-selected={kind === k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>
              {k.label} <span className="count">{count(k.tones)}</span>
            </button>
          ))}
        </div>
        <label className="select">
          <span className="sr-only">Job</span>
          <select value={job} onChange={(e) => setJob(e.target.value)}>
            <option value="all">All jobs</option>
            {jobs.map((j) => (
              <option key={j} value={j}>
                Job {j}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="muted empty">{items.length ? "Nothing matches this filter yet." : "Start a run to see every decision, refusal and hold change as it happens."}</p>
      ) : (
        <ol
          className="feed-list tall"
          ref={list}
          onScroll={(e) => {
            const el = e.currentTarget;
            follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {shown.map((f) => (
            <Line key={f.seq} f={f} />
          ))}
        </ol>
      )}
    </section>
  );
}
