"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Download, Lock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePageBack } from "@/components/layout/BackNavContext";
import { fetchLossRun, downloadLossRunCsv, type LossRun } from "@/lib/lossRun";
import { fmtUsd } from "@/lib/book";
import { toastError } from "@/lib/toast";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export default function LossRunPage() {
  const { venueId } = useParams<{ venueId: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();

  const [data, setData] = useState<LossRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !venueId) return;
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchLossRun(venueId);
        if (!cancelled) setData(d);
      } catch (e: unknown) {
        if (cancelled) return;
        // 403 → not your venue (calm permissions state); anything else → error.
        const status = (e as { status?: number })?.status;
        if (status === 403) setDenied(true);
        else setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isLoaded, isSignedIn, venueId]);

  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadLossRunCsv(venueId);
    } catch {
      toastError("Couldn't export the loss run. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  // Single contextual back, rendered once by AppShell (see BackNavContext).
  usePageBack("Back to risk profile", () => router.push(`/risk-profile/${venueId}`));

  if (!isLoaded || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  if (denied) {
    return (
      <div className="page-loading" role="alert" style={{ flexDirection: "column", gap: "var(--space-md)", textAlign: "center", padding: "var(--space-xl)" }}>
        <Lock size={26} aria-hidden="true" style={{ color: "var(--text-secondary)" }} />
        <p className="text-sm text-secondary" style={{ margin: 0 }}>You don&apos;t have access to this venue&apos;s loss run.</p>
        <Link href="/dashboard" className="btn btn-secondary" style={{ minHeight: 44 }}>Go to dashboard</Link>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="page-loading" role="alert" style={{ flexDirection: "column", gap: "var(--space-md)", textAlign: "center", padding: "var(--space-xl)" }}>
        <p className="text-sm" style={{ color: "var(--state-error)", margin: 0 }}>Couldn&apos;t load the loss run.</p>
        <button type="button" className="btn btn-secondary" style={{ minHeight: 44 }} onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }

  const s = data.summary;
  const empty = s.claim_count === 0;

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">BROKER<span className="lc-eyebrow__sep" />LOSS RUN</span>
          <h1 className="lc-display">Loss <em>Run</em></h1>
          <p className="lc-sub">Full claims history for {venueId} — reserves, paid, and incurred by coverage line.</p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell"><span className="lc-stat-label">Claims</span><strong>{s.claim_count}</strong></div>
          <div className="lc-meta-cell"><span className="lc-stat-label">Open</span><strong style={s.open_count > 0 ? { color: "var(--state-warning)" } : undefined}>{s.open_count}</strong></div>
          <div className="lc-meta-cell"><span className="lc-stat-label">Incurred</span><strong>{fmtUsd(s.total_incurred)}</strong></div>
        </div>
      </section>

      <div className="flex items-center justify-between mb-xl" style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}>
        <div className="flex gap-md text-xs text-muted" style={{ flexWrap: "wrap" }}>
          <span>reserves {fmtUsd(s.total_reserve)}</span><span>·</span>
          <span>paid {fmtUsd(s.total_paid)}</span><span>·</span>
          <span>recoveries {fmtUsd(s.total_recoveries)}</span>
        </div>
        {!empty && (
          <button type="button" className="btn btn-secondary flex items-center gap-xs" style={{ minHeight: 44 }} onClick={handleDownload} disabled={downloading}>
            <Download size={14} aria-hidden="true" /> {downloading ? "Exporting…" : "Download CSV"}
          </button>
        )}
      </div>

      {empty ? (
        <div className="lc-card">
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>No claims on file for this venue — a clean loss run.</p>
          </div>
        </div>
      ) : (
        <>
          {/* By coverage line */}
          <div className="lc-card mb-xl">
            <div className="lc-card__inner">
              <h2 className="text-sm font-semibold" style={{ margin: "0 0 var(--space-md)" }}>By coverage line</h2>
              <div style={{ overflowX: "auto" }}>
                <table className="lr-table">
                  <thead><tr><th style={{ textAlign: "left" }}>Line</th><th>Claims</th><th>Reserve</th><th>Paid</th><th>Incurred</th></tr></thead>
                  <tbody>
                    {data.by_coverage_line.map((r) => (
                      <tr key={r.coverage_line}>
                        <td style={{ textAlign: "left", textTransform: "uppercase", letterSpacing: "0.04em" }}>{r.coverage_line.replace(/_/g, " ")}</td>
                        <td className="num">{r.claim_count}</td>
                        <td className="num font-mono">{fmtUsd(r.reserve)}</td>
                        <td className="num font-mono">{fmtUsd(r.paid)}</td>
                        <td className="num font-mono">{fmtUsd(r.incurred)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Claims history */}
          <div className="lc-card">
            <div className="lc-card__inner">
              <h2 className="text-sm font-semibold" style={{ margin: "0 0 var(--space-md)" }}>Claims history</h2>
              <div style={{ overflowX: "auto" }}>
                <table className="lr-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Date of loss</th>
                      <th style={{ textAlign: "left" }}>Claim</th>
                      <th style={{ textAlign: "left" }}>Line</th>
                      <th style={{ textAlign: "left" }}>Status</th>
                      <th>Reserve</th>
                      <th>Paid</th>
                      <th>Incurred</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.claims.map((c) => (
                      <tr key={c.claim_id}>
                        <td style={{ textAlign: "left" }} className="font-mono">{fmtDate(c.date_of_loss)}</td>
                        <td style={{ textAlign: "left" }}>{c.carrier_claim_number ?? c.claim_id}</td>
                        <td style={{ textAlign: "left", textTransform: "uppercase" }}>{c.coverage_line.replace(/_/g, " ")}</td>
                        <td style={{ textAlign: "left" }}>{c.status.replace(/_/g, " ")}</td>
                        <td className="num font-mono">{fmtUsd(c.current_reserve)}</td>
                        <td className="num font-mono">{fmtUsd(c.indemnity_paid)}</td>
                        <td className="num font-mono">{fmtUsd(c.total_incurred)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      <style jsx>{`
        .lr-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
        .lr-table th { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em;
          color: var(--text-muted); font-weight: 600; padding: 0 var(--space-md) var(--space-sm); text-align: right; white-space: nowrap; }
        .lr-table td { padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--border-subtle); text-align: right; white-space: nowrap; }
        .lr-table .num { text-align: right; font-variant-numeric: tabular-nums; }
      `}</style>
    </div>
  );
}
