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
 *
 * "Paper & Ink" — migrated to ds/ primitives; explicit colours on every text
 * element. PageHeader/StatusPill replaced inline.
 */
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, ShieldAlert, CheckCircle2 } from "lucide-react";
import { usePageBack } from "@/components/layout/BackNavContext";
import { PlacementApiError } from "@/lib/placement";
import { policiesApi, type CoverageGapReport } from "@/lib/policies";
import { SEVERITY_COLOR } from "@/lib/risk";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Badge } from "@/components/ds/badge";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

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

  // Single contextual back, rendered once by AppShell (see BackNavContext).
  usePageBack("Back", () => router.back());

  if (loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }
  if (error || !report) {
    return (
      <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] py-10">
        <div role="alert" className="rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error ?? "Coverage gaps unavailable."}
        </div>
      </div>
    );
  }

  const { gaps, covered, summary } = report;
  const hasGaps = gaps.length > 0;

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-start justify-between gap-4 py-10">
        <div>
          <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
            <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
            Coverage review · {report.policy_id}
          </span>
          <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
            {report.venue_id}
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            Required coverage check for this in-force policy
          </p>
        </div>
        <Badge variant={hasGaps ? "destructive" : "success"}>
          {hasGaps
            ? `${summary.gap_count} gap${summary.gap_count === 1 ? "" : "s"}`
            : "Fully covered"}
        </Badge>
      </section>

      {/* ── summary strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Required gaps</div>
          <div className={`mt-1 text-lg font-semibold ${hasGaps ? "text-destructive" : "text-foreground"}`}>
            {summary.gap_count}
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Lines in force</div>
          <div className="mt-1 text-lg font-semibold text-foreground">{covered.length}</div>
        </div>
        <div className="col-span-2 rounded-xl border border-border bg-card p-4 sm:col-span-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Exposure</div>
          <div className="mt-1 text-sm text-foreground">
            {hasGaps ? "Broker E&O — uncovered required line" : "None — required coverage complete"}
          </div>
        </div>
      </div>

      {/* 1. Gaps — led because it's the reason for the visit. */}
      {hasGaps ? (
        <>
          <h2 className="mb-3 mt-10 text-base font-semibold text-foreground">
            Coverage gaps ({summary.gap_count})
          </h2>
          <div className="flex flex-col gap-3">
            {gaps.map((g) => (
              <Card key={g.id} className="gap-3 p-5">
                <div className="flex items-start gap-3">
                  <span
                    className="mt-1.5 size-2.5 shrink-0 rounded-full"
                    style={{ background: SEVERITY_COLOR[g.severity] ?? "var(--state-error)" }}
                    aria-hidden
                  />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold text-foreground">{g.name}</span>
                    <Badge variant="muted">Required line</Badge>
                  </div>
                  <Button asChild size="sm" className="border border-foreground/15">
                    <Link href={g.endorse_href}>Add this coverage <ArrowRight className="size-3.5" /></Link>
                  </Button>
                </div>
                <p className="flex items-start gap-2 text-sm text-muted-foreground">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0 text-destructive" />
                  {g.reason}
                </p>
                <div className="text-xs text-muted-foreground">
                  Recommended limit{" "}
                  <span className="tabular-nums text-foreground">{fmtLimit(g.recommended_limit)}</span>
                  <span className="text-muted-foreground/70"> · final premium quoted at endorsement</span>
                </div>
              </Card>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-6 flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          <CheckCircle2 size={16} className="text-[#5A6E00]" />
          No coverage gaps — every default-required line is in force on this policy.
        </div>
      )}

      {/* 3. Current coverage — supporting context, intentionally muted. */}
      <h2 className="mb-3 mt-10 text-base font-semibold text-foreground">Current coverage</h2>
      {covered.length ? (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Coverage line</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Per-occurrence limit</th>
              </tr>
            </thead>
            <tbody>
              {covered.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-foreground">{c.name}</td>
                  <td className="px-4 py-3 font-mono text-foreground">{fmtLimit(c.limit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">No coverage lines on this policy.</div>
      )}
    </div>
  );
}
