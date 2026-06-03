"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { fetchCarrierDetail, type CarrierDetail } from "@/lib/carriers";
import { fmtUsd, fmtLossRatio, lossBand, LOSS_BAND_META } from "@/lib/book";

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="lc-meta-cell">
      <span className="lc-stat-label">{label}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-xs font-mono"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-sm)",
        padding: "2px 8px",
        color: "var(--text-secondary)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
      }}
    >
      {children}
    </span>
  );
}

export default function CarrierDetailPage() {
  const { cid } = useParams<{ cid: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";

  const [data, setData] = useState<CarrierDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  // Carrier book is a broker surface — operators never place coverage.
  useEffect(() => {
    if (isLoaded && isSignedIn && !isBroker) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isBroker, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isBroker || !cid) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchCarrierDetail(cid);
        if (!cancelled) setData(d);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, isBroker, cid]);

  if (!isLoaded || loading || !isBroker) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  if (error || !data) {
    return (
      <div className="page-loading" role="alert" style={{ flexDirection: "column", gap: "var(--space-md)", textAlign: "center", padding: "var(--space-xl)" }}>
        <p className="text-sm" style={{ color: "var(--state-error)", margin: 0 }}>Couldn&apos;t load this carrier.</p>
        <button type="button" className="btn btn-secondary" style={{ minHeight: 44 }} onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }

  const a = data.appetite ?? {};
  const band = lossBand(data.book.loss_ratio);

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <Link href="/book" className="flex items-center gap-xs text-secondary text-sm" style={{ textDecoration: "none", padding: "16px 0 0", minHeight: 44 }}>
        <ArrowLeft size={14} aria-hidden="true" /> Back to financials
      </Link>

      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            BROKER<span className="lc-eyebrow__sep" />CARRIER
          </span>
          <h1 className="lc-display">{data.name}</h1>
          <p className="lc-sub">
            {data.market_type?.toUpperCase()}
            {data.am_best_rating ? ` · A.M. Best ${data.am_best_rating}` : ""}
            {data.naic_code ? ` · NAIC ${data.naic_code}` : ""}
            {data.contact_email ? ` · ${data.contact_email}` : ""}
          </p>
        </div>
        <div className="lc-hero__meta">
          <Kpi label="Written premium" value={fmtUsd(data.book.written_premium)} />
          <Kpi label="Commission" value={fmtUsd(data.book.commission)} />
          <Kpi label="Loss ratio" value={fmtLossRatio(data.book.loss_ratio)} color={LOSS_BAND_META[band].color} />
        </div>
      </section>

      {/* Appetite */}
      <div className="lc-card mb-xl">
        <div className="lc-card__inner">
          <h2 className="text-sm font-semibold" style={{ margin: "0 0 var(--space-md)" }}>Appetite</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
            <div>
              <div className="text-xs text-muted mb-xs">Venue types</div>
              <div className="flex gap-xs" style={{ flexWrap: "wrap" }}>
                {(a.venue_types && a.venue_types.length > 0)
                  ? a.venue_types.map((t) => <Tag key={t}>{t.replace(/_/g, " ")}</Tag>)
                  : <span className="text-xs text-muted">Any</span>}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted mb-xs">Coverage lines written</div>
              <div className="flex gap-xs" style={{ flexWrap: "wrap" }}>
                {(a.coverage_lines && a.coverage_lines.length > 0)
                  ? a.coverage_lines.map((l) => <Tag key={l}>{l}</Tag>)
                  : <span className="text-xs text-muted">Any</span>}
              </div>
            </div>
            <div className="text-xs text-secondary">
              Max venue capacity: <span className="font-mono">{a.max_capacity != null ? a.max_capacity.toLocaleString() : "—"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Policies placed with this carrier */}
      <div className="lc-card">
        <div className="lc-card__inner">
          <h2 className="text-sm font-semibold" style={{ margin: "0 0 var(--space-md)" }}>
            In-force policies ({data.book.policy_count})
          </h2>
          {data.policies.length === 0 ? (
            <p className="text-sm text-muted" style={{ margin: 0 }}>No in-force policies placed with this carrier.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="cr-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Policy</th>
                    <th style={{ textAlign: "left" }}>Venue</th>
                    <th style={{ textAlign: "left" }}>Status</th>
                    <th>Premium</th>
                    <th style={{ textAlign: "left" }}>Term</th>
                  </tr>
                </thead>
                <tbody>
                  {data.policies.map((p) => (
                    <tr key={p.policy_id}>
                      <td style={{ textAlign: "left" }}>
                        <Link href={`/policies/${p.policy_id}`} style={{ color: "var(--accent-ink)", textDecoration: "none" }}>
                          {p.policy_number ?? p.policy_id}
                        </Link>
                      </td>
                      <td style={{ textAlign: "left" }}>{p.venue_id}</td>
                      <td style={{ textAlign: "left" }}>{p.status.replace(/_/g, " ")}</td>
                      <td className="num font-mono">{fmtUsd(p.annual_premium)}</td>
                      <td style={{ textAlign: "left" }} className="font-mono text-muted">{p.effective_date} → {p.expiration_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .cr-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
        .cr-table th { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em;
          color: var(--text-muted); font-weight: 600; padding: 0 var(--space-md) var(--space-sm); text-align: right; white-space: nowrap; }
        .cr-table td { padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--border-subtle); text-align: right; white-space: nowrap; }
        .cr-table .num { text-align: right; font-variant-numeric: tabular-nums; }
      `}</style>
    </div>
  );
}
