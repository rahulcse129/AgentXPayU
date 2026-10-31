"use client";
import { useEffect, useRef } from "react";
import type { FeedItem } from "@/lib/state";

/** The description templates start with "[A] " / "[*] "; the job pill shows that instead. */
const strip = (s: string) => s.replace(/^\[[^\]]+\]\s*/, "");

export function Feed({ items }: { items: FeedItem[] }) {
  const end = useRef<HTMLLIElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [items.length]);

  return (
    <section className="card feed" aria-label="Reasoning feed">
      <h3>Reasoning feed</h3>
      {items.length === 0 ? (
        <p className="muted empty">Start a run to see every decision, refusal and hold change as it happens.</p>
      ) : (
        <ol>
          {items.map((f) => (
            <li key={f.seq} className={`feed-item tone-${f.tone}`}>
              <span className="pill">{f.jobId ?? "·"}</span>
              <div>
                <p className="line">{f.phrased ?? strip(f.fact)}</p>
                {f.policy && (f.phrased || !f.fact.includes(f.policy)) && <p className="policy">policy: {f.policy}</p>}
                {f.phrased && <p className="policy">fact: {strip(f.fact)}</p>}
              </div>
            </li>
          ))}
          <li ref={end} aria-hidden />
        </ol>
      )}
    </section>
  );
}
