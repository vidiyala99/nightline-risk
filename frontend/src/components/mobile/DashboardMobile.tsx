"use client";

/**
 * DashboardMobile — 1:1 web port of the React Native operator DashboardScreen
 * (mobile/src/screens/DashboardScreen.tsx). Rendered ONLY on phones behind an
 * `isPhone` branch in dashboard/page.tsx; the desktop dashboard is untouched.
 *
 * Sections mirror the native screen exactly: hero → 3 stat cards → On the floor
 * → Claims in flight → Your reports (claim-journey steps) → Risk Profile → Policy.
 * Core data (risk/quote/live/stats) comes in as props from the page (already
 * fetched); the incident-status feed — the one piece the desktop page doesn't
 * hold — is fetched here, exactly like the RN screen.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { authHeaders } from "@/lib/authFetch";
import { riskAttentionLine, FACTOR_GLYPH, FACTOR_TIER_COLOR } from "@/lib/risk";
import { MobileExposure } from "./MobileExposure";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const TIER_COLOR: Record<string, string> = {
  A: "var(--tier-a)",
  B: "var(--tier-b)",
  C: "var(--tier-c)",
  D: "var(--tier-d)",
};
function tierColor(t: string | undefined): string {
  return TIER_COLOR[(t ?? "").toUpperCase()] ?? "var(--text-tertiary)";
}

interface FeedRow {
  incident_id: string;
  summary: string;
  occurred_at: string;
  status: string;
  proposal_state: string | null;
  claim_status: string | null;
}

const TERMINAL_INCIDENT = new Set(["closed", "closed_archived"]);
const TERMINAL_CLAIM = new Set(["closed_paid", "closed_denied", "closed_dropped"]);
const TERMINAL_PROPOSAL = new Set(["paid", "denied", "rejected_by_broker"]);

function isActiveReport(r: FeedRow): boolean {
  const incidentActive = !TERMINAL_INCIDENT.has(r.status);
  const claimActive = !!r.claim_status && !TERMINAL_CLAIM.has(r.claim_status);
  const proposalActive = !!r.proposal_state && !TERMINAL_PROPOSAL.has(r.proposal_state);
  return incidentActive || claimActive || proposalActive;
}

function reportSteps(r: FeedRow): Array<{ label: string; lit: boolean }> {
  const ps = r.proposal_state ?? "";
  return [
    { label: "Reported", lit: true },
    { label: "Sent", lit: !!r.proposal_state },
    { label: "Approved", lit: ["approved", "filed_with_carrier", "paid", "denied"].includes(ps) },
    { label: "Filed", lit: ["filed_with_carrier", "paid", "denied"].includes(ps) || !!r.claim_status },
    {
      label: "Resolved",
      lit:
        ["paid", "denied"].includes(ps) ||
        ["closed_paid", "closed_denied", "closed_dropped"].includes(r.claim_status ?? ""),
    },
  ];
}

function renewalLabel(expiration: string): string {
  const exp = new Date(expiration).getTime();
  if (Number.isNaN(exp)) return "in force";
  const days = Math.ceil((exp - Date.now()) / 86400000);
  if (days < 0) return "expired";
  if (days === 0) return "renews today";
  if (days <= 60) return `renews in ${days} day${days === 1 ? "" : "s"}`;
  return `renews ${new Date(expiration).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

interface Props {
  userName?: string | null;
  venueId: string | null;
  risk: any;
  quote: any;
  live: any;
  stats: { venues?: number; incidents?: number; compliance?: number } | null;
}

export function DashboardMobile({ userName, venueId, risk, quote, live, stats }: Props) {
  const [feed, setFeed] = useState<FeedRow[]>([]);

  useEffect(() => {
    if (!venueId) return;
    let active = true;
    fetch(`${API_URL}/api/venues/${venueId}/incident-status-feed`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => active && setFeed(Array.isArray(rows) ? rows : []))
      .catch(() => active && setFeed([]));
    return () => {
      active = false;
    };
  }, [venueId]);

  const tier = risk?.tier ?? "—";
  const score = risk?.total_score ?? 0;
  const factors: Record<string, any> = risk?.factors ?? {};
  const tColor = tierColor(tier);

  const activeReports = feed.filter(isActiveReport);
  const claimsInFlight = activeReports.filter((r) => r.proposal_state != null || r.claim_status != null).length;
  const infoRequested = activeReports.filter((r) => r.proposal_state === "needs_more_info").length;

  const boundPolicy = quote?.policy ?? null;

  const cap = live?.current_capacity ?? 0;
  const maxCap = live?.max_capacity ?? 0;
  const capPct = maxCap > 0 ? Math.min(100, Math.round((cap / maxCap) * 100)) : 0;
  const infra: Array<{ name: string; status?: string; is_degraded?: boolean }> = live?.infrastructure ?? [];
  const showFloor = maxCap > 0 || infra.length > 0;

  const venueCount = stats?.venues ?? 1;

  if (!risk && !quote && !live) {
    return <div className="m-center">Loading your venue…</div>;
  }

  return (
    <div className="m-screen">
      {/* Hero */}
      <div className="m-hero">
        <h1 className="m-hero__title">
          Operational <span className="accent">Defense</span>
        </h1>
        <p className="m-hero__subtitle">Your operational data — your defense against premium hikes</p>
      </div>

      {/* Stats */}
      <div className="m-stats">
        <Link href="/venues" className="m-stat">
          <span className="m-stat__value">{venueCount}</span>
          <span className="m-stat__label">{venueCount === 1 ? "Your Venue" : "Your Venues"}</span>
        </Link>
        <Link href="/incidents" className="m-stat">
          <span className="m-stat__value" data-tone={(stats?.incidents ?? 0) > 0 ? "error" : undefined}>
            {stats?.incidents ?? 0}
          </span>
          <span className="m-stat__label">Open Incidents</span>
        </Link>
        <Link href="/compliance" className="m-stat">
          <span className="m-stat__value" data-tone={(stats?.compliance ?? 0) > 0 ? "error" : undefined}>
            {stats?.compliance ?? 0}
          </span>
          <span className="m-stat__label">Compliance</span>
        </Link>
      </div>

      {/* Ask the Copilot — operator-only conversational intelligence (web parity) */}
      <Link href="/copilot" className="m-cta">
        <span className="m-cta__text">
          <span className="m-cta__label">Ask the Copilot</span>
          <span className="m-cta__sub">Grounded answers about your risk &amp; coverage</span>
        </span>
        <span className="m-cta__arrow" aria-hidden>
          →
        </span>
      </Link>

      {/* What needs your attention — exposure triage feed (web parity) */}
      <MobileExposure />

      {/* On the floor */}
      {showFloor && (
        <div className="m-card">
          <span className="m-eyebrow">On the floor</span>
          {maxCap > 0 && (
            <>
              <div className="m-floor-cap">
                <span className="m-floor-cap__value">
                  {cap}
                  <span className="m-floor-cap__max"> / {maxCap}</span>
                </span>
                <span className="m-floor-cap__pct">{capPct}%</span>
              </div>
              <div className="m-floor-track">
                <div
                  className="m-floor-fill"
                  style={{
                    width: `${capPct}%`,
                    background: capPct >= 90 ? "var(--state-error)" : capPct >= 70 ? "var(--state-warning)" : "var(--brand-primary)",
                  }}
                />
              </div>
            </>
          )}
          {infra.length > 0 && (
            <div className="m-infra-grid">
              {infra.map((item, i) => {
                const degraded = item.is_degraded || (item.status && item.status !== "ok" && item.status !== "operational");
                return (
                  <div key={`${item.name}-${i}`} className="m-infra-chip">
                    <span className="m-infra-dot" style={{ background: degraded ? "var(--state-error)" : "var(--state-success)" }} />
                    <span className="m-infra-name">{item.name}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Claims in flight */}
      {(claimsInFlight > 0 || infoRequested > 0) && (
        <div className="m-flight">
          {claimsInFlight > 0 && (
            <Link href="/claims" className="m-flight__cell">
              <span className="m-flight__num">{claimsInFlight}</span>
              <span className="m-flight__label">claims in flight · track →</span>
            </Link>
          )}
          {infoRequested > 0 && (
            <Link href="/claims" className="m-flight__cell m-flight__cell--warn">
              <span className="m-flight__num">{infoRequested}</span>
              <span className="m-flight__label">need info →</span>
            </Link>
          )}
        </div>
      )}

      {/* Your reports */}
      {activeReports.length > 0 && (
        <div className="m-card">
          <span className="m-eyebrow">Your reports — what happened next</span>
          {activeReports.slice(0, 6).map((r) => {
            const steps = reportSteps(r);
            const currentIdx = steps.map((s) => s.lit).lastIndexOf(true);
            const branch =
              r.proposal_state === "rejected_by_broker"
                ? "Declined"
                : r.proposal_state === "needs_more_info"
                  ? "Info requested"
                  : null;
            return (
              <Link
                key={r.incident_id}
                href={`/incidents/${r.incident_id}`}
                className="m-report"
              >
                <span className="m-report__summary">{r.summary}</span>
                <span className="m-report__steps">
                  {steps.map((s, i) => (
                    <span key={s.label} className="m-report__step" data-lit={s.lit} data-current={i === currentIdx}>
                      {s.lit ? "● " : "○ "}
                      {s.label}
                      {i === currentIdx ? " · now" : ""}
                    </span>
                  ))}
                  {branch && (
                    <span
                      className="m-report__step"
                      style={{ color: branch === "Info requested" ? "var(--state-warning)" : "var(--state-error)" }}
                    >
                      · {branch}
                    </span>
                  )}
                </span>
              </Link>
            );
          })}
        </div>
      )}

      {/* Risk profile */}
      {risk && (
        <Link href={venueId ? `/risk-profile/${venueId}` : "/dashboard"} className="m-card">
          <span className="m-eyebrow">Risk profile</span>
          <div className="m-risk-head">
            <span className="m-tier-badge" style={{ color: tColor }}>
              Tier {tier}
            </span>
            <span className="m-score">
              <span className="m-score__value" style={{ color: tColor }}>
                {score}
              </span>
              <span className="m-score__max"> / 100</span>
            </span>
          </div>
          {Object.keys(factors).length > 0 &&
            (() => {
              const attn = riskAttentionLine(factors);
              const color = FACTOR_TIER_COLOR[attn.tier];
              return (
                <span className="m-attn">
                  <span className="m-attn__glyph" style={{ color }}>
                    {FACTOR_GLYPH[attn.tier]}
                  </span>
                  <span className="m-attn__text" style={{ color }}>
                    {attn.text}
                  </span>
                </span>
              );
            })()}
          <span className="m-tap-hint">Tap for full risk analysis →</span>
        </Link>
      )}

      {/* Policy / premium */}
      {boundPolicy ? (
        <Link href="/coverage" className="m-card m-quote">
          <div className="m-quote__head">
            <span className="m-eyebrow" style={{ marginBottom: 0 }}>
              Your policy · in force
            </span>
            <span className="m-tier-badge" style={{ color: "var(--accent-ink)" }}>
              {boundPolicy.status.replace(/_/g, " ").toUpperCase()}
            </span>
          </div>
          <span className="m-quote__type">
            {(quote?.venue_type ?? "").replace(/_/g, " ").toUpperCase()} · {boundPolicy.policy_number ?? "PENDING NUMBER"}
          </span>
          <div className="m-quote__amount">${Math.round(Number(boundPolicy.annual_premium)).toLocaleString()}</div>
          <div className="m-quote__sub">/ year</div>
          <div className="m-quote__lines">{boundPolicy.coverage_lines.map((l: string) => l.toUpperCase()).join(" · ") || "—"}</div>
          <div className="m-quote__cta">{renewalLabel(boundPolicy.expiration_date)} · view coverage →</div>
        </Link>
      ) : quote ? (
        <div className="m-card m-quote">
          <div className="m-quote__head">
            <span className="m-eyebrow" style={{ marginBottom: 0 }}>
              Indicative premium
            </span>
            <span className="m-tier-badge" style={{ color: tierColor(quote.tier) }}>
              {quote.tier} Tier
            </span>
          </div>
          <span className="m-quote__type">{(quote.venue_type ?? "").replace(/_/g, " ").toUpperCase()}</span>
          <div className="m-quote__amount">${quote.annual_premium?.toLocaleString() ?? "—"}</div>
          <div className="m-quote__sub">/ year · indicative, subject to carrier quote</div>
          <div className="m-quote__monthly">
            ${quote.monthly_premium?.toLocaleString() ?? "—"}
            <span className="m-quote__monthly-sub"> / month</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
