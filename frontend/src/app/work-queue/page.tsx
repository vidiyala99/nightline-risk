"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Proposal {
  id: string;
  packet_id: string;
  venue_id: string;
  state: string;
  proposed_at: string;
  recommendation_snapshot?: {
    should_file?: boolean;
    confidence?: number;
    expected_payout?: { median_usd?: number };
  } | null;
}

async function fetchBucket(status: string, sort?: string): Promise<Proposal[]> {
  const q = new URLSearchParams({ status });
  if (sort) q.set("sort", sort);
  const res = await fetch(`${API_URL}/api/claim-proposals?${q.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function Row({ p, onOpen }: { p: Proposal; onOpen: (id: string) => void }) {
  const s = p.recommendation_snapshot;
  // A proposal can predate the recommendation snapshot; show "—" rather than a
  // misleading 0% / ~$0.
  const conf = s?.confidence != null ? Math.round(s.confidence * 100) : null;
  const median = s?.expected_payout?.median_usd;
  return (
    <button
      type="button"
      className="wq-row"
      onClick={() => onOpen(p.packet_id)}
      aria-label={`Review proposal for ${p.venue_id}${conf != null ? `, confidence ${conf} percent` : ""}`}
    >
      <span
        className="font-display"
        style={{
          fontWeight: 600,
          flex: 1,
          fontSize: "var(--text-sm)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {p.venue_id}
      </span>
      <span
        className={s?.should_file ? "badge badge-warning" : "badge badge-info"}
        style={{ flexShrink: 0 }}
      >
        {s?.should_file ? "File" : "Review"}
      </span>
      <span className="font-mono text-muted" style={{ flexShrink: 0, fontSize: "var(--text-sm)" }}>
        {conf != null ? `${conf}%` : "—"}
      </span>
      <span className="font-mono" style={{ flexShrink: 0, fontSize: "var(--text-sm)" }}>
        {median != null ? `~$${Number(median).toLocaleString()}` : "—"}
      </span>
    </button>
  );
}

interface SectionProps {
  title: string;
  hint: string;
  rows: Proposal[];
  onOpen: (id: string) => void;
  tone?: "urgent" | "neutral";
}

function Section({ title, hint, rows, onOpen, tone = "neutral" }: SectionProps) {
  const chipColor = tone === "urgent" ? "var(--state-warning)" : "var(--text-muted)";
  const chipBorder = tone === "urgent" ? "var(--state-warning)" : "var(--border-subtle)";
  return (
    <div className="lc-card mb-xl">
      <div className="lc-card__inner">
        <div
          className="flex items-center justify-between mb-md"
          style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}
        >
          <div className="flex items-center" style={{ gap: "var(--space-sm)" }}>
            <h2 className="text-sm font-semibold" style={{ margin: 0 }}>
              {title}
            </h2>
            <span className="text-xs text-muted">{hint}</span>
          </div>
          {rows.length > 0 && (
            <span
              className="text-xs font-mono"
              style={{
                color: chipColor,
                border: `1px solid ${chipBorder}`,
                borderRadius: "var(--radius-sm)",
                padding: "2px 8px",
              }}
            >
              {rows.length}
            </span>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted" style={{ margin: 0 }}>
            Nothing here.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            {rows.map((p) => (
              <Row key={p.id} p={p} onOpen={onOpen} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkQueuePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";
  const [toDecide, setToDecide] = useState<Proposal[]>([]);
  const [awaiting, setAwaiting] = useState<Proposal[]>([]);
  const [ready, setReady] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  // Broker-only decision surface (persona-correct). Operators are scoped to
  // status screens; bounce them to their dashboard rather than render a
  // broker-framed queue.
  useEffect(() => {
    if (isLoaded && isSignedIn && !isBroker) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isBroker, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isBroker) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [decide, info, appr] = await Promise.all([
          fetchBucket("pending_broker_review", "priority"),
          fetchBucket("needs_more_info"),
          fetchBucket("approved"),
        ]);
        if (cancelled) return;
        setToDecide(decide);
        // endpoint returns newest-first; awaiting wants oldest-first
        setAwaiting([...info].reverse());
        setReady(appr);
      } catch {
        // A thrown fetch (network error, or a 5xx whose error response carries
        // no CORS header) must NOT leave the page spinning forever — surface a
        // retryable error instead of an infinite spinner.
        if (!cancelled) setError("Couldn't load the work queue.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, isBroker, reloadKey]);

  const open = (packetId: string) => router.push(`/underwriter/${packetId}`);

  if (!isLoaded || loading || !isBroker) {
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
            BROKER
            <span className="lc-eyebrow__sep" />
            WORK QUEUE
          </span>
          <h1 className="lc-display">
            Work <em>Queue</em>
          </h1>
          <p className="lc-sub">
            Triage and decide — highest priority first; aging items surface automatically.
          </p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">To decide</span>
            <strong
              style={{ color: toDecide.length > 0 ? "var(--state-warning)" : undefined }}
            >
              {String(toDecide.length).padStart(2, "0")}
            </strong>
          </div>
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Awaiting info</span>
            <strong>{String(awaiting.length).padStart(2, "0")}</strong>
          </div>
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Ready to file</span>
            <strong>{String(ready.length).padStart(2, "0")}</strong>
          </div>
        </div>
      </section>

      {toDecide.length === 0 && awaiting.length === 0 && ready.length === 0 ? (
        <div className="lc-card">
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>Queue clear — nothing to decide right now.</p>
          </div>
        </div>
      ) : (
        <>
          <Section
            title="To decide"
            hint="pending broker review · value + urgency"
            rows={toDecide}
            onOpen={open}
            tone="urgent"
          />
          <Section
            title="Awaiting info"
            hint="you asked the operator · oldest first"
            rows={awaiting}
            onOpen={open}
          />
          <Section
            title="Ready to file"
            hint="approved · confirm FNOL"
            rows={ready}
            onOpen={open}
          />
        </>
      )}
    </div>
  );
}
