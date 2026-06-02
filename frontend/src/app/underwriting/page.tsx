"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useIsCarrier } from "@/contexts/AuthContext";
import { TierBadge, Tier as UiTier } from "@/components/ui/TierBadge";
import {
  fetchUnderwritingQueue,
  fmtMoney,
  lineLabel,
  type QueueRow,
} from "@/lib/underwriting";

function Row({ row, onOpen }: { row: QueueRow; onOpen: (qid: string) => void }) {
  const suggested = row.suggested_premium_breakdown?.total ?? null;
  return (
    <button
      type="button"
      className="wq-row"
      onClick={() => onOpen(row.quote_id)}
      aria-label={`Underwrite submission for ${row.venue_name}, risk tier ${row.risk.tier}`}
    >
      <span
        className="font-display"
        style={{
          fontWeight: 600,
          flex: 1,
          minWidth: 0,
          fontSize: "var(--text-sm)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.venue_name}
      </span>
      <span
        className="text-xs text-muted hide-on-phone"
        style={{ flexShrink: 0, fontFamily: "var(--font-mono)" }}
      >
        {row.coverage_lines.map(lineLabel).join(" · ") || "—"}
      </span>
      <span className="flex items-center" style={{ gap: 6, flexShrink: 0 }}>
        <TierBadge tier={row.risk.tier as UiTier} />
        <span className="font-mono text-muted" style={{ fontSize: "var(--text-sm)" }}>
          {row.risk.total_score}
        </span>
      </span>
      <span
        className="font-mono"
        style={{ flexShrink: 0, fontSize: "var(--text-sm)", minWidth: 92, textAlign: "right" }}
        title="Engine-suggested annual premium"
      >
        {suggested != null ? fmtMoney(suggested) : "—"}
      </span>
    </button>
  );
}

export default function UnderwritingQueuePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const isCarrier = useIsCarrier();
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  // Carrier-only desk. Brokers/operators are bounced to their own home.
  useEffect(() => {
    if (isLoaded && isSignedIn && !isCarrier) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isCarrier, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isCarrier) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await fetchUnderwritingQueue();
        if (!cancelled) setRows(data);
      } catch {
        // A thrown fetch (network / CORS-less 5xx) must not spin forever.
        if (!cancelled) setError("Couldn't load the underwriting queue.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, isCarrier, reloadKey]);

  const open = (qid: string) => router.push(`/underwriting/${qid}`);

  if (!isLoaded || loading || !isCarrier) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
        <div className="lc-card" style={{ marginTop: "clamp(40px, 12vh, 120px)" }}>
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm" style={{ color: "var(--state-error)", margin: 0 }}>{error}</p>
            <button
              type="button"
              className="btn btn-secondary"
              style={{ marginTop: "var(--space-md)", minHeight: 44 }}
              onClick={() => setReloadKey((k) => k + 1)}
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            CARRIER
            <span className="lc-eyebrow__sep" />
            UNDERWRITING DESK
          </span>
          <h1 className="lc-display">
            Underwriting <em>Desk</em>
          </h1>
          <p className="lc-sub">
            Broker submissions awaiting a decision. The pricing engine suggests a premium for each —
            quote at terms or decline.
          </p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Awaiting decision</span>
            <strong style={{ color: rows.length > 0 ? "var(--state-warning)" : undefined }}>
              {String(rows.length).padStart(2, "0")}
            </strong>
          </div>
        </div>
      </section>

      {rows.length === 0 ? (
        <div className="lc-card">
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              Desk clear — no submissions awaiting an underwriting decision.
            </p>
          </div>
        </div>
      ) : (
        <div className="lc-card mb-xl">
          <div className="lc-card__inner">
            <div
              className="flex items-center justify-between mb-md"
              style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}
            >
              <div className="flex items-center" style={{ gap: "var(--space-sm)" }}>
                <h2 className="text-sm font-semibold" style={{ margin: 0 }}>
                  Awaiting decision
                </h2>
                <span className="text-xs text-muted">venue · coverage · risk · suggested premium</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
              {rows.map((r) => (
                <Row key={r.quote_id} row={r} onOpen={open} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
