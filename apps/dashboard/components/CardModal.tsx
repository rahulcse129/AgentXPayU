"use client";
/**
 * The customer places their card hold in Airwallex Drop-in. Card details go from Airwallex's own
 * form straight to Airwallex: this page and our server never see them. The engine waits until
 * Airwallex reports the PaymentIntent as REQUIRES_CAPTURE before the job starts.
 *
 * Airwallex.js (@airwallex/components-sdk 1.36.0): init({ env: 'demo', enabledElements: ['payments'] }),
 * createElement('dropIn', { intent_id, client_secret, currency, autoCapture: false,
 * authorizationType: 'pre_auth', methods: ['card'] }), element.on('success' | 'error').
 */
import { useEffect, useRef, useState } from "react";
import { fmt, type CardRequest } from "@/lib/state";

let sdk: Promise<typeof import("@airwallex/components-sdk")> | null = null;
/** Load and initialise Airwallex.js once, in the browser only. */
function airwallex() {
  sdk ??= import("@airwallex/components-sdk").then(async (m) => {
    await m.init({ env: "demo", enabledElements: ["payments"], locale: "en" });
    return m;
  });
  return sdk;
}

type Phase = "loading" | "ready" | "submitted" | "error";

export function CardModal({ card, queued }: { card: CardRequest; queued: number }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let element: { destroy(): void } | null = null;
    let cancelled = false;
    setPhase("loading");
    setError(null);
    (async () => {
      try {
        const { createElement } = await airwallex();
        const el = await createElement("dropIn", {
          intent_id: card.holdId,
          client_secret: card.clientSecret,
          currency: card.currency,
          // A hold, not a charge: Margin captures only what the job spends, later.
          autoCapture: false,
          authorizationType: "pre_auth",
          methods: ["card"],
        });
        if (cancelled || !el) return el?.destroy();
        element = el;
        el.on("ready", () => setPhase("ready"));
        el.on("success", () => setPhase("submitted"));
        el.on("error", (e: unknown) => {
          const detail = (e as { detail?: { error?: { message?: string } } })?.detail?.error?.message;
          setError(detail ?? "Airwallex could not authorize this card.");
          setPhase("error");
        });
        if (mountRef.current) {
          el.mount(mountRef.current);
          // 'ready' did not fire in our sandbox runs; once mounted, Drop-in shows its own loading state.
          setPhase((p) => (p === "loading" ? "ready" : p));
        }
      } catch (e) {
        if (!cancelled) {
          setError(`Could not load Airwallex Drop-in: ${String(e)}`);
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      element?.destroy();
    };
  }, [card.holdId, card.clientSecret, card.currency]);

  const left = Math.max(0, Math.ceil((card.deadline - now) / 1000));

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card-modal" role="dialog" aria-modal="true" aria-labelledby="card-title">
        <p className="label">
          {card.customer} · job {card.jobId} · Airwallex <span className="badge badge-live">LIVE</span>
          {queued > 0 && <span className="muted"> · {queued} more customer{queued > 1 ? "s" : ""} after this</span>}
        </p>
        <h2 id="card-title">
          Approve a card hold of <span className="num">{fmt(card.amount)}</span>
        </h2>
        <p className="muted small">
          This places a hold, not a charge. Margin captures only what the job actually spends and releases the rest. Your card details go
          directly to Airwallex.
        </p>
        <div ref={mountRef} className="dropin" />
        {phase === "loading" && <p className="muted small">Loading Airwallex Drop-in…</p>}
        {phase === "submitted" && <p className="good">Card authorized. Waiting for Airwallex to confirm the hold…</p>}
        {phase === "error" && <p className="bad">{error}</p>}
        <p className="small muted">
          Sandbox test card: 4035 5010 0000 0008 · any future expiry · any CVC. Intent <span className="mono">{card.holdId}</span> ·{" "}
          {left}s left
        </p>
      </div>
    </div>
  );
}
