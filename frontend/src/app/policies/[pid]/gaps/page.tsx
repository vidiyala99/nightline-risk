"use client";

/**
 * /policies/[pid]/gaps — coverage-gap remediation.
 *
 * The destination the broker's "Close coverage gap" exposure CTA routes to
 * (was the raw policy detail page). Answers three questions in one glance:
 *   1. What's missing  — the gaps, led visually because that's why you're here.
 *   2. How we close it — each gap carries its own "Add this coverage" action
 *      deep-linking the prefilled endorse flow (fix sits with the problem).
 *   3. What's covered  — current in-force lines, as muted supporting context.
 *
 * Severity is never color-only — every gap also carries a "Required line"
 * label. Premium is stated honestly (quoted at endorsement), not fabricated.
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, ShieldAlert, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import { PlacementApiError } from "@/lib/placement";
import { policiesApi, type CoverageGapReport } from "@/lib/policies";
import { SEVERITY_COLOR } from "@/lib/risk";

function fmtLimit(v: string | null): string {
  if (!v) return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default function CoverageGapsPage() {
  const params = useParams<{ pid: string }>();
  const router = useRouter();
  const pid = params?.pid;

  const [report, setReport] = useState<CoverageGapReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pid) return;
    setLoading(true);
    setError(null);
    policiesApi
      .getCoverageGaps(pid)
      .then(setReport)
      .catch((e) =>
        setError(e instanceof PlacementApiError ? e.message : "Failed to load coverage gaps"),
      )
      .finally(() => setLoading(false));
  }, [pid]);

  if (loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }
  if (error || !report) {
    return (
      <div className="submission-detail">
        <button type="button" className="link-button" onClick={() => router.back()}>
          <ArrowLeft size={14} /> Back
        </button>
        <div className="placement-page__error">{error ?? "Coverage gaps unavailable."}</div>
      </div>
    );
  }

  const { gaps, covered, summary } = report;
  const hasGaps = gaps.length > 0;

  return (
    <div className="submission-detail">
      <button type="button" className="link-button" onClick={() => router.back()}>
        <ArrowLeft size={14} /> Back
      </button>

      <PageHeader
        eyebrow={`Coverage review · ${report.policy_id}`}
        title={report.venue_id}
        subtitle="Required coverage check for this in-force policy"
        actions={
          <StatusPill tone={hasGaps ? "danger" : "success"}>
            {hasGaps
              ? `${summary.gap_count} gap${summary.gap_count === 1 ? "" : "s"}`
              : "Fully covered"}
          </StatusPill>
        }
      />

      {/* Summary strip — the headline read. */}
      <div className="submission-detail__summary">
        <div>
          <div className="submission-detail__summary-label">Required gaps</div>
          <div
            className="submission-detail__summary-value"
            style={{ color: hasGaps ? "var(--state-error)" : "var(--text-secondary)" }}
          >
            {summary.gap_count}
          </div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Lines in force</div>
          <div className="submission-detail__summary-value">{covered.length}</div>
        </div>
        <div>
          <div className="submission-detail__summary-label">Exposure</div>
          <div className="submission-detail__summary-value" style={{ fontSize: 12 }}>
            {hasGaps ? "Broker E&O — uncovered required line" : "None — required coverage complete"}
          </div>
        </div>
      </div>

      {/* 1. Gaps — led because it's the reason for the visit. Each row pairs the
          problem with its fix so there's no hunting for the next action. */}
      {hasGaps ? (
        <>
          <h2 className="submission-detail__section-title">
            Coverage gaps ({summary.gap_count})
          </h2>
          <div className="coverage-gap-list">
            {gaps.map((g) => (
              <div key={g.id} className="coverage-gap-card">
                <div className="coverage-gap-card__head">
                  <span
                    className="coverage-gap-card__dot"
                    style={{ background: SEVERITY_COLOR[g.severity] ?? "var(--state-error)" }}
                    aria-hidden
                  />
                  <div className="coverage-gap-card__title">
                    <span className="coverage-gap-card__name">{g.name}</span>
                    <span className="coverage-gap-card__tag">Required line</span>
                  </div>
                  <Link href={g.endorse_href} className="btn btn-primary btn-sm">
                    Add this coverage <ArrowRight size={14} />
                  </Link>
                </div>
                <p className="coverage-gap-card__reason">
                  <ShieldAlert size={14} style={{ color: "var(--state-error)", flexShrink: 0 }} />
                  {g.reason}
                </p>
                <div className="coverage-gap-card__meta">
                  Recommended limit{" "}
                  <span style={{ color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
                    {fmtLimit(g.recommended_limit)}
                  </span>
                  <span style={{ color: "var(--text-tertiary)" }}>
                    · final premium quoted at endorsement
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="policies-empty" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <CheckCircle2 size={16} style={{ color: "var(--accent-ink)" }} />
          No coverage gaps — every default-required line is in force on this policy.
        </div>
      )}

      {/* 3. Current coverage — supporting context, intentionally muted. */}
      <h2 className="submission-detail__section-title">Current coverage</h2>
      {covered.length ? (
        <div className="policies-table-wrap">
          <table className="policies-table">
            <thead>
              <tr>
                <th>Coverage line</th>
                <th>Per-occurrence limit</th>
              </tr>
            </thead>
            <tbody>
              {covered.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="policies-table__mono">{fmtLimit(c.limit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="policies-empty">No coverage lines on this policy.</div>
      )}
    </div>
  );
}
