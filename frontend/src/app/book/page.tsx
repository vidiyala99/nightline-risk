"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import {
  fetchBookFinancials,
  fmtUsd,
  fmtLossRatio,
  lossBand,
  LOSS_BAND_META,
  type BookFinancials,
} from "@/lib/book";

/** Loss-ratio cell: percentage + a short band label, colored — color is never
 * the only signal (a11y). */
function LossRatio({ value }: { value: string | null }) {
  const band = lossBand(value);
  const meta = LOSS_BAND_META[band];
  return (
    <span className="flex items-center gap-xs" style={{ justifyContent: "flex-end" }}>
      <span className="font-mono" style={{ color: meta.color, fontVariantNumeric: "tabular-nums" }}>
        {fmtLossRatio(value)}
      </span>
      <span
        className="text-xs"
        style={{
          color: meta.color,
          border: `1px solid ${meta.color}`,
          borderRadius: "var(--radius-sm)",
          padding: "1px 6px",
          opacity: 0.85,
        }}
      >
        {meta.label}
      </span>
    </span>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="lc-meta-cell">
      <span className="lc-stat-label">{label}</span>
      <strong style={color ? { color } : undefined}>{value}</strong>
    </div>
  );
}

export default function BookFinancialsPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";

  const [data, setData] = useState<BookFinancials | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  // Broker-only money surface. Operators are venue-scoped — bounce to home.
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
        const d = await fetchBookFinancials();
        if (!cancelled) setData(d);
      } catch {
        if (!cancelled) setError("Couldn't load book financials.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, isBroker, reloadKey]);

  if (!isLoaded || loading || !isBroker) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
        <div className="lc-card" style={{ marginTop: "clamp(40px, 12vh, 120px)" }}>
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm" style={{ color: "var(--state-error)", margin: 0 }}>
              {error ?? "No data."}
            </p>
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

  const empty = data.policy_count === 0;

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            BROKER
            <span className="lc-eyebrow__sep" />
            BOOK
          </span>
          <h1 className="lc-display">
            Book <em>Financials</em>
          </h1>
          <p className="lc-sub">
            Written premium, commission revenue, and loss ratio across the in-force book.
          </p>
        </div>
        <div className="lc-hero__meta">
          <Kpi label="Written premium" value={fmtUsd(data.written_premium)} />
          <Kpi label="Earned premium" value={fmtUsd(data.earned_premium)} />
          <Kpi label="Commission" value={fmtUsd(data.commission_revenue)} />
          <Kpi
            label="Loss ratio"
            value={fmtLossRatio(data.loss_ratio)}
            color={LOSS_BAND_META[lossBand(data.loss_ratio)].color}
          />
        </div>
      </section>

      {empty ? (
        <div className="lc-card">
          <div className="lc-card__inner" style={{ textAlign: "center", padding: "var(--space-xl)" }}>
            <p className="text-sm text-muted" style={{ margin: 0 }}>
              No in-force policies yet — bind a quote to start the book.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Secondary stats line. */}
          <div className="flex gap-md mb-xl text-xs text-muted" style={{ flexWrap: "wrap" }}>
            <span>{data.policy_count} in-force {data.policy_count === 1 ? "policy" : "policies"}</span>
            <span>·</span>
            <span>incurred losses {fmtUsd(data.incurred_losses)}</span>
            <span>·</span>
            <span>{data.open_claim_count} open {data.open_claim_count === 1 ? "claim" : "claims"}</span>
          </div>

          {/* By coverage line */}
          <div className="lc-card mb-xl">
            <div className="lc-card__inner">
              <h2 className="text-sm font-semibold" style={{ margin: "0 0 var(--space-md)" }}>
                By coverage line
              </h2>
              <div style={{ overflowX: "auto" }}>
                <table className="fin-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Line</th>
                      <th style={{ textAlign: "right" }}>Written</th>
                      <th style={{ textAlign: "right" }}>Earned</th>
                      <th style={{ textAlign: "right" }}>Incurred</th>
                      <th style={{ textAlign: "right" }}>Loss ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_coverage_line.map((r) => (
                      <tr key={r.coverage_line}>
                        <td style={{ textAlign: "left", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                          {r.coverage_line.replace(/_/g, " ")}
                        </td>
                        <td className="font-mono num">{fmtUsd(r.written_premium)}</td>
                        <td className="font-mono num">{fmtUsd(r.earned_premium)}</td>
                        <td className="font-mono num">{fmtUsd(r.incurred_losses)}</td>
                        <td style={{ textAlign: "right" }}><LossRatio value={r.loss_ratio} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* By carrier */}
          <div className="lc-card">
            <div className="lc-card__inner">
              <h2 className="text-sm font-semibold" style={{ margin: "0 0 var(--space-md)" }}>
                By carrier
              </h2>
              <div style={{ overflowX: "auto" }}>
                <table className="fin-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Carrier</th>
                      <th style={{ textAlign: "right" }}>Policies</th>
                      <th style={{ textAlign: "right" }}>Written</th>
                      <th style={{ textAlign: "right" }}>Commission</th>
                      <th style={{ textAlign: "right" }}>Incurred</th>
                      <th style={{ textAlign: "right" }}>Loss ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_carrier.map((r) => (
                      <tr key={r.carrier_id}>
                        <td style={{ textAlign: "left" }}>{r.carrier_name}</td>
                        <td className="font-mono num">{r.policy_count}</td>
                        <td className="font-mono num">{fmtUsd(r.written_premium)}</td>
                        <td className="font-mono num">{fmtUsd(r.commission)}</td>
                        <td className="font-mono num">{fmtUsd(r.incurred_losses)}</td>
                        <td style={{ textAlign: "right" }}><LossRatio value={r.loss_ratio} /></td>
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
        .fin-table {
          width: 100%;
          border-collapse: collapse;
          font-size: var(--text-sm);
        }
        .fin-table th {
          font-size: var(--text-xs);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--text-muted);
          font-weight: 600;
          padding: 0 var(--space-md) var(--space-sm);
          white-space: nowrap;
        }
        .fin-table td {
          padding: var(--space-sm) var(--space-md);
          border-top: 1px solid var(--border-subtle);
          white-space: nowrap;
        }
        .fin-table .num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}
