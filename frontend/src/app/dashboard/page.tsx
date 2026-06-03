"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import OnboardingCard from "@/components/OnboardingCard";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole, useTenantId, useAuth } from "@/contexts/AuthContext";
import { Building2, LogOut, ArrowUpRight, WifiOff, AlertTriangle, CheckSquare, ArrowRight, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { Grid } from "@/components/layout/Grid";
import { authHeaders } from "@/lib/authFetch";
import { StatStrip } from "@/components/ui/StatStrip";
import { StatTile } from "@/components/ui/StatTile";
import { SearchInput } from "@/components/ui/SearchInput";
import { TierBadge, Tier as UiTier } from "@/components/ui/TierBadge";
import { useBreakpoint, useMounted } from "@/hooks/useBreakpoint";
import { riskAttentionLine, FACTOR_TIER_COLOR, FACTOR_GLYPH, factorLabel, getFactorTier } from "@/lib/risk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface PortfolioVenue {
  id: string;
  name: string;
  venue_type: string;
  address: string;
  capacity: number;
  current_capacity: number | null;
  renewal_date: string;
  current_carrier: string;
  tier: string;
  total_score: number;
  open_incidents: number;
  compliance_actions: number;
  has_degraded_infra: boolean;
}

interface LiveState {
  current_capacity: number;
  max_capacity: number;
  infrastructure?: Array<{ name: string; status: string; is_degraded?: boolean }>;
  compliance_queue?: Array<unknown>;
  premium_impact?: number;
}

interface RiskScore {
  venue_id: string;
  total_score: number;
  tier: string;
  factors: Record<string, { score: number; weight: number }>;
}

interface CoverageLine { included?: boolean; optional?: boolean; description?: string }
interface PremiumQuote {
  venue_id: string;
  venue_type: string;
  tier: string;
  annual_premium: number;
  monthly_premium: number;
  market_rate_annual?: number;
  savings_annual?: number;
  savings_pct?: number;
  renewal_date?: string;
  coverage_breakdown?: Record<string, CoverageLine>;
  // Present when the venue has an in-force policy — the real bound premium,
  // which supersedes the indicative estimate above for insured operators.
  policy?: {
    annual_premium: string;
    monthly_premium: string;
    policy_number: string | null;
    status: string;
    effective_date: string;
    expiration_date: string;
    coverage_lines: string[];
  } | null;
}

interface Stats { venues: number; incidents: number; compliance: number; claims?: number; }

const TIER_COLOR: Record<string, string> = {
  A: "var(--tier-a)",
  B: "var(--tier-b)",
  C: "var(--tier-c)",
  D: "var(--tier-d)",
};

// ---- Operator report feed types + components (module-scope, not per-render) --

interface FeedRow {
  incident_id: string;
  summary: string;
  occurred_at: string;
  status: string;
  proposal_state: string | null;
  claim_status: string | null;
}

// Operator home surfaces only what's *live*. A report drops off once its incident is
// closed AND its claim journey is finished (or never started) — closed-and-done belongs in
// the Incidents archive, not the home feed. A closed incident with a claim still in flight
// stays, so "existing claims" remain visible.
const TERMINAL_INCIDENT = new Set(["closed", "closed_archived"]);
const TERMINAL_CLAIM = new Set(["closed_paid", "closed_denied", "closed_dropped"]);
const TERMINAL_PROPOSAL = new Set(["paid", "denied", "rejected_by_broker"]);
function isActiveReport(r: FeedRow): boolean {
  const incidentActive = !TERMINAL_INCIDENT.has(r.status);
  const claimActive = !!r.claim_status && !TERMINAL_CLAIM.has(r.claim_status);
  const proposalActive = !!r.proposal_state && !TERMINAL_PROPOSAL.has(r.proposal_state);
  return incidentActive || claimActive || proposalActive;
}

function reportSteps(r: FeedRow) {
  const ps = r.proposal_state ?? "";
  return [
    { label: "Reported", lit: true },
    { label: "Sent", lit: !!r.proposal_state },
    { label: "Approved", lit: ["approved", "filed_with_carrier", "paid", "denied"].includes(ps) },
    { label: "Filed", lit: ["filed_with_carrier", "paid", "denied"].includes(ps) || !!r.claim_status },
    { label: "Resolved", lit: ["paid", "denied"].includes(ps) || ["closed_paid", "closed_denied", "closed_dropped"].includes(r.claim_status ?? "") },
  ];
}

function ReportFeedRow({ r }: { r: FeedRow }) {
  const steps = reportSteps(r);
  const branch = r.proposal_state === "rejected_by_broker" ? "Declined by broker"
    : r.proposal_state === "needs_more_info" ? "Info requested" : null;
  // Current step = the furthest-along lit step. Spoken to screen readers via the
  // row's aria-label; the ●/○ glyph row is decorative (aria-hidden).
  const currentIdx = steps.map((s) => s.lit).lastIndexOf(true);
  const current = steps[currentIdx]?.label ?? "Reported";
  const dateLabel = (() => {
    const d = new Date(r.occurred_at);
    return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  })();
  return (
    <Link
      href={`/incidents/${r.incident_id}`}
      className="lc-card"
      style={{ textDecoration: "none", display: "block" }}
      aria-label={`${r.summary} — status: ${current}${branch ? `, ${branch}` : ""}`}
    >
      {/* Two-column row: content left, occurred-date + affordance right — gives the
          row a scannable right edge instead of trailing whitespace. */}
      <div className="lc-card__inner" style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="text-sm" title={r.summary} style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.summary}
          </span>
          <div className="flex items-center" aria-hidden="true" style={{ gap: 8, flexWrap: "wrap" }}>
            {steps.map((s, i) => {
              const isCurrent = i === currentIdx;
              return (
                <span key={s.label} className="text-xs" style={{
                  color: s.lit ? "var(--accent-ink)" : "var(--text-muted)",
                  fontWeight: isCurrent ? 700 : 400,
                }}>
                  {s.lit ? "● " : "○ "}{s.label}{isCurrent ? " · now" : ""}
                </span>
              );
            })}
            {branch && <span className="text-xs" style={{ color: branch === "Info requested" ? "var(--state-warning)" : "var(--state-error)" }}>· {branch}</span>}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
          {dateLabel && <span className="text-xs text-muted" style={{ fontFamily: "var(--font-mono)" }}>{dateLabel}</span>}
          <ArrowRight size={15} className="text-muted" aria-hidden="true" />
        </div>
      </div>
    </Link>
  );
}

function OperatorReportFeed({ venueId, complianceDue }: { venueId: string; complianceDue: number }) {
  const [rows, setRows] = useState<FeedRow[]>([]);
  useEffect(() => {
    if (!venueId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/incident-status-feed`, { headers: authHeaders() });
      if (res.ok && !cancelled) { const d = await res.json(); setRows(Array.isArray(d) ? d : []); }
    })();
    return () => { cancelled = true; };
  }, [venueId]);

  // Home shows only live reports; closed-and-done incidents live in the Incidents archive.
  const activeRows = rows.filter(isActiveReport);
  const infoRequested = activeRows.filter((r) => r.proposal_state === "needs_more_info").length;
  const needsYou = complianceDue + infoRequested;
  // Claims currently in flight (entered the journey, not resolved) — gets its own
  // navigable doorway to /claims, mirroring the compliance tile.
  const claimsInFlight = activeRows.filter((r) => r.proposal_state != null || r.claim_status != null).length;

  return (
    <>
      {/* Summary band — "Needs you" + "Claims in flight" side by side (each keeps
          its own label so action vs tracking stays distinct); stacks on narrow. */}
      {(needsYou > 0 || claimsInFlight > 0) && (
        <div className="mb-lg flex" style={{ gap: "var(--space-2xl)", flexWrap: "wrap", alignItems: "flex-start" }}>
          {needsYou > 0 && (
            <section aria-label="Needs you">
              <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Needs you · {needsYou}</div>
              <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
                {complianceDue > 0 && (
                  <Link href="/compliance" className="lc-card" style={{ flex: "0 1 240px", textDecoration: "none", display: "block" }}>
                    <div className="lc-card__inner" style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "14px 18px" }}>
                      <span className="font-mono" style={{ fontSize: "1.25rem", color: "var(--accent-ink)" }}>{complianceDue}</span>
                      <span className="text-xs text-muted">compliance items due</span>
                    </div>
                  </Link>
                )}
                {infoRequested > 0 && (
                  <Link href="/incidents" className="lc-card" style={{ flex: "0 1 240px", textDecoration: "none", display: "block" }}>
                    <div className="lc-card__inner" style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "14px 18px" }}>
                      <span className="font-mono" style={{ fontSize: "1.25rem", color: "var(--state-warning)" }}>{infoRequested}</span>
                      <span className="text-xs text-muted">incidents need info</span>
                    </div>
                  </Link>
                )}
              </div>
            </section>
          )}
          {claimsInFlight > 0 && (
            <section aria-label="Claims">
              <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Claims · in flight</div>
              <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
                <Link href="/claims" className="lc-card" style={{ flex: "0 1 240px", textDecoration: "none", display: "block" }}>
                  <div className="lc-card__inner" style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "14px 18px" }}>
                    <span className="font-mono" style={{ fontSize: "1.25rem", color: "var(--accent-ink)" }}>{claimsInFlight}</span>
                    <span className="text-xs text-muted">claims in flight · track →</span>
                  </div>
                </Link>
              </div>
            </section>
          )}
        </div>
      )}
      {activeRows.length > 0 && (
        <section className="mb-lg" aria-label="Your reports">
          <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Your reports — what happened next</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            {activeRows.slice(0, 8).map((r) => <ReportFeedRow key={r.incident_id} r={r} />)}
          </div>
          {activeRows.length > 8 && (
            <Link href="/incidents" className="text-xs" style={{ display: "inline-block", marginTop: "var(--space-sm)", color: "var(--accent-ink)", textDecoration: "none" }}>
              +{activeRows.length - 8} more in Incidents →
            </Link>
          )}
        </section>
      )}
    </>
  );
}

// ---- Broker triage (hoisted so Link subtree isn't remounted on state update) -

// Hoisted out of BrokerTriageStrip so it isn't re-created (and its <Link>
// subtree remounted) on every state update.
function TriageCell({ n, label, href }: { n: number; label: string; href: string }) {
  if (n <= 0) return null;
  return (
    <Link href={href} className="lc-card" style={{ flex: 1, minWidth: 150, textDecoration: "none", minHeight: 44, display: "block" }}>
      <div className="lc-card__inner">
        <div className="font-mono" style={{ fontSize: "1.25rem", color: "var(--accent-ink)" }}>{n}</div>
        <div className="text-xs text-muted">{label}</div>
      </div>
    </Link>
  );
}

function BrokerTriageStrip({ expiringRenewals }: { expiringRenewals: number }) {
  const [pending, setPending] = useState(0);
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    (async () => {
      const [p, r] = await Promise.all([
        fetch(`${API_URL}/api/claim-proposals?status=pending_broker_review`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/policy-requests`, { headers: authHeaders() }),
      ]);
      if (p.ok) { const d = await p.json(); setPending(Array.isArray(d) ? d.length : 0); }
      if (r.ok) {
        const d = await r.json();
        const open = Array.isArray(d) ? d.filter((x: { status: string }) => ["requested", "pending", "open"].includes(x.status)).length : 0;
        setRequests(open);
      }
    })();
  }, []);
  const total = pending + expiringRenewals + requests;
  if (total === 0) return null;
  return (
    <section className="mb-lg" aria-label="Needs you">
      <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Needs you · {total}</div>
      <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
        <TriageCell n={pending} label="proposals to decide" href="/work-queue" />
        <TriageCell n={expiringRenewals} label="renewals expiring (60d)" href="/renewals" />
        <TriageCell n={requests} label="open requests" href="/policy-requests" />
      </div>
    </section>
  );
}

interface VenueSummary { id: string; name: string; }

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="lc-shell min-h-screen page-loading"><div className="loading-spinner" /></div>}>
      <DashboardPageInner />
    </Suspense>
  );
}

function DashboardPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signOut, isSignedIn, isLoaded, user } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const bp = useBreakpoint();
  const mounted = useMounted();
  const isPhone = mounted && (bp === "xs" || bp === "sm");
  const extraIdsKey = (user?.extra_venue_ids ?? []).join(",");
  const [loading, setLoading] = useState(true);
  const [portfolioVenues, setPortfolioVenues] = useState<PortfolioVenue[]>([]);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [riskScore, setRiskScore] = useState<RiskScore | null>(null);
  const [quote, setQuote] = useState<PremiumQuote | null>(null);
  const [stats, setStats] = useState<Stats>({ venues: 0, incidents: 0, compliance: 0 });
  const [searchQuery, setSearchQuery] = useState("");

  const venueParam = searchParams.get("venue");
  const selectedVenueId = venueParam ?? tenantId ?? null;
  const [venuesList, setVenuesList] = useState<VenueSummary[]>([]);

  const isBroker = role === "broker" || role === "admin";

  const filteredPortfolioVenues = searchQuery.trim()
    ? portfolioVenues.filter(v => {
        const q = searchQuery.toLowerCase();
        return v.name.toLowerCase().includes(q)
          || v.address?.toLowerCase().includes(q)
          || v.venue_type?.toLowerCase().includes(q);
      })
    : portfolioVenues;

  useEffect(() => {
    if (isBroker || !tenantId) return;
    let cancelled = false;
    const primaryId = tenantId;
    async function loadList() {
      const ids: string[] = [primaryId, ...(extraIdsKey ? extraIdsKey.split(",") : [])];
      const results = await Promise.all(
        ids.map(async (id): Promise<VenueSummary | null> => {
          try {
            const res = await fetch(`${API_URL}/api/venues/${id}`, { headers: authHeaders() });
            if (!res.ok) return null;
            const data = await res.json();
            return { id, name: data.name ?? id };
          } catch { return null; }
        })
      );
      if (cancelled) return;
      setVenuesList(results.filter((v): v is VenueSummary => v != null));
    }
    loadList();
    return () => { cancelled = true; };
  }, [isBroker, tenantId, extraIdsKey]);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  // The carrier persona has no portfolio/venue dashboard — its home is the
  // underwriting desk. Bounce a signed-in carrier there. (admin keeps the
  // broker dashboard; only the dedicated carrier role redirects.)
  useEffect(() => {
    if (isLoaded && isSignedIn && role === "carrier") router.replace("/underwriting");
  }, [isLoaded, isSignedIn, role, router]);

  useEffect(() => {
    let cancelled = false;
    async function fetchDashboard() {
      try {
        if (isBroker) {
          // Live "Book" shows the underwritten book only; the 300 real prospect
          // venues live in /venues (filterable) so they don't flood this view.
          const res = await fetch(`${API_URL}/api/portfolio?source=book`, { headers: authHeaders() });
          if (res.ok) {
            const venues: PortfolioVenue[] = await res.json();
            if (cancelled) return;
            setPortfolioVenues(venues);
            setStats({
              venues: venues.length,
              incidents: venues.reduce((s, v) => s + v.open_incidents, 0),
              compliance: venues.reduce((s, v) => s + v.compliance_actions, 0),
            });
          }
        } else {
          const venueId = selectedVenueId;
          if (!venueId) {
            setStats({ venues: 0, incidents: 0, compliance: 0 });
            setRiskScore(null); setQuote(null); setLiveState(null);
            return;
          }
          const totalVenueCount = Math.max(venuesList.length, 1);
          const [liveRes, riskRes, quoteRes, incidentsRes, feedRes] = await Promise.all([
            fetch(`${API_URL}/api/venues/${venueId}/live`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/risk-score`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/quote`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/incidents?status=open`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/incident-status-feed`, { headers: authHeaders() }),
          ]);
          const incidentCount = incidentsRes.ok ? (await incidentsRes.json()).length : 0;
          // Open claims = incidents that entered the claim journey and aren't resolved.
          let claimsInFlight = 0;
          if (feedRes.ok) {
            const feed: FeedRow[] = await feedRes.json();
            claimsInFlight = (Array.isArray(feed) ? feed : [])
              .filter((r) => (r.proposal_state != null || r.claim_status != null) && isActiveReport(r))
              .length;
          }
          if (cancelled) return;
          if (liveRes.ok) {
            const state = await liveRes.json();
            setLiveState(state);
            setStats({
              venues: totalVenueCount,
              incidents: incidentCount,
              compliance: state.compliance_queue?.length || 0,
              claims: claimsInFlight,
            });
          } else {
            setStats((s) => ({ ...s, venues: totalVenueCount, incidents: incidentCount }));
          }
          setRiskScore(riskRes.ok ? await riskRes.json() : null);
          setQuote(quoteRes.ok ? await quoteRes.json() : null);
        }
      } catch (error) {
        console.error("Dashboard fetch failed:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchDashboard();
    const onFocus = () => fetchDashboard();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.removeEventListener("focus", onFocus); };
  }, [isBroker, selectedVenueId, venuesList.length]);

  const handleSignOut = () => { signOut(); router.push("/"); };

  if (!isSignedIn || loading) {
    return <div className="lc-shell min-h-screen page-loading"><div className="loading-spinner" /></div>;
  }

  // Carrier has no dashboard — it's being redirected to the underwriting desk.
  // Render the spinner (not the "No Venue" empty state) while the effect fires.
  if (role === "carrier") {
    return <div className="lc-shell min-h-screen page-loading"><div className="loading-spinner" /></div>;
  }

  if (!isBroker && !tenantId) {
    return (
      <div className="lc-shell min-h-screen p-xl">
        <div className="flex flex-col items-center justify-center" style={{ minHeight: "60vh" }}>
          <Building2 size={48} className="text-muted mb-lg" />
          <h2 className="text-xl mb-sm">No Venue Assigned</h2>
          <p className="text-muted mb-lg">Contact your administrator to get venue access</p>
          <button onClick={handleSignOut} className="btn btn-secondary"><LogOut size={18} /> Sign Out</button>
        </div>
      </div>
    );
  }

  const now = new Date();
  const session = now.getHours() >= 20 || now.getHours() < 4 ? "EVENING SESSION"
    : now.getHours() >= 17 ? "PRE-DOORS"
    : now.getHours() >= 12 ? "AFTERNOON SESSION"
    : "MORNING SESSION";
  const dateStamp = now.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase();
  const timeStamp = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  // Derived metrics for the ticker
  const avgScore = portfolioVenues.length
    ? Math.round(portfolioVenues.reduce((s, v) => s + v.total_score, 0) / portfolioVenues.length)
    : null;
  const atCapacity = portfolioVenues.filter(v => v.current_capacity != null && v.capacity > 0 && v.current_capacity / v.capacity >= 0.9).length;
  const degraded = portfolioVenues.filter(v => v.has_degraded_infra).length;
  const tierCounts = portfolioVenues.reduce<Record<string, number>>((acc, v) => {
    acc[v.tier] = (acc[v.tier] ?? 0) + 1; return acc;
  }, {});

  // Ticker items (duplicated for seamless scroll)
  const tickerCore: React.ReactNode[] = isBroker ? [
    <span className="lc-ticker__item" key="t1"><b>PORTFOLIO</b> {stats.venues} venues</span>,
    <span className="lc-ticker__item" key="t2"><b>AVG RISK</b> <span className={avgScore && avgScore >= 70 ? "up" : "down"}>{avgScore ?? "—"}</span>/100</span>,
    <span className="lc-ticker__item" key="t3"><b>OPEN INCIDENTS</b> <span className="down">{stats.incidents}</span></span>,
    <span className="lc-ticker__item" key="t4"><b>COMPLIANCE QUEUE</b> {stats.compliance}</span>,
    <span className="lc-ticker__item" key="t5"><b>AT CAPACITY</b> <span className={atCapacity > 0 ? "down" : "dim"}>{atCapacity}</span></span>,
    <span className="lc-ticker__item" key="t6"><b>DEGRADED INFRA</b> <span className={degraded > 0 ? "down" : "dim"}>{degraded}</span></span>,
    <span className="lc-ticker__item" key="t7"><b>TIER A</b> <span className="up">{tierCounts.A ?? 0}</span> · <b>B</b> {tierCounts.B ?? 0} · <b>C</b> <span className="down">{tierCounts.C ?? 0}</span> · <b>D</b> <span className="down">{tierCounts.D ?? 0}</span></span>,
    <span className="lc-ticker__item" key="t8"><b>EVIDENCE-FIRST UNDERWRITING</b> <span className="dim">v2.10</span></span>,
  ] : [
    <span className="lc-ticker__item" key="o1"><b>{venuesList.find(v => v.id === selectedVenueId)?.name ?? "VENUE"}</b></span>,
    <span className="lc-ticker__item" key="o2"><b>RISK</b> <span className="up">{riskScore?.total_score ?? "—"}</span>/100 · Tier {riskScore?.tier ?? "—"}</span>,
    <span className="lc-ticker__item" key="o3"><b>QUOTE</b> ${quote?.annual_premium?.toLocaleString() ?? "—"}/yr</span>,
    <span className="lc-ticker__item" key="o4"><b>CAPACITY</b> {liveState?.current_capacity ?? 0}/{liveState?.max_capacity ?? 0}</span>,
    <span className="lc-ticker__item" key="o5"><b>OPEN INCIDENTS</b> <span className={stats.incidents > 0 ? "down" : "dim"}>{stats.incidents}</span></span>,
    <span className="lc-ticker__item" key="o6"><b>COMPLIANCE</b> {stats.compliance}</span>,
  ];
  const tickerItems = [
    ...tickerCore,
    ...tickerCore.map((node, i) =>
      React.isValidElement(node) ? React.cloneElement(node, { key: `dup-${i}` }) : node
    ),
  ];

  // Phone-width broker view mirrors the React Native BrokerPortfolioScreen
  // (identity → 3 KPIs → 2 CTAs), in lieu of the desktop marketing hero.
  // Operators on phone still see the original hero — their single-venue
  // layout is already compact enough.
  const showMobileBroker = isPhone && isBroker;
  const tonightCount = portfolioVenues.filter(v => {
    const capPct = v.current_capacity != null && v.capacity > 0 ? v.current_capacity / v.capacity : 0;
    return v.open_incidents > 0 || v.has_degraded_infra || capPct >= 0.9 || v.compliance_actions > 0;
  }).length;

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      {!isBroker && tenantId && (
        <div style={{ paddingTop: "var(--space-lg)" }}>
          <OnboardingCard venueId={tenantId} />
        </div>
      )}
      {showMobileBroker && (
        <section className="lc-book-mobile">
          <div className="lc-book-mobile__identity">
            <span className="lc-book-mobile__name">{user?.name ?? "Broker"}</span>
            <span className="lc-book-mobile__role">BROKER · NIGHTLINE RISK</span>
          </div>

          <div className="lc-book-mobile__stats">
            <StatTile label="Total Venues" value={stats.venues.toString().padStart(2, "0")} tier="neutral" />
            <StatTile label="Open Incidents" value={stats.incidents.toString().padStart(2, "0")} tier={stats.incidents > 0 ? "d" : "neutral"} />
            <StatTile label="Compliance" value={stats.compliance.toString().padStart(2, "0")} tier={stats.compliance > 0 ? "b" : "neutral"} />
          </div>

          <div className="lc-book-mobile__actions">
            <Link href="/renewals" className="lc-action-tile">
              <span>RENEWALS DUE</span>
              <ArrowRight size={16} aria-hidden />
            </Link>
            <Link href="/policy-requests" className="lc-action-tile">
              <span>POLICY REQUESTS</span>
              <ArrowRight size={16} aria-hidden />
            </Link>
          </div>

          <div className="lc-book-mobile__kpi">
            <span className="lc-book-mobile__kpi-text">
              THE BOOK · {String(stats.venues).padStart(2, "0")} VENUES
            </span>
            {tonightCount > 0 && (
              <span className="lc-book-mobile__kpi-hi">{tonightCount} NEED EYES</span>
            )}
          </div>
        </section>
      )}

      {/* HERO — hidden on phone for brokers (replaced by lc-book-mobile above) */}
      {!showMobileBroker && (
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            {session}
            <span className="lc-eyebrow__sep" />
            {dateStamp} · {timeStamp}
            <span className="lc-eyebrow__sep" />
            {isBroker ? "BROKER · PORTFOLIO" : "OPERATOR · VENUE"}
          </span>
          <h1 className="lc-display">
            {isBroker
              ? <>The room is <em>louder</em><br/>than the model.</>
              : <>Your shift, <em>defended</em><br/>by evidence.</>}
          </h1>
          <p className="lc-sub">
            {isBroker
              ? "Live risk, capacity and compliance across your nightlife portfolio — priced from operational reality, not paperwork."
              : "Operational telemetry from your floor becomes underwriter-grade evidence. Lower premiums, faster claims, fewer surprises."}
          </p>
        </div>

        {isBroker ? (
          <StatStrip className="lc-hero__meta">
            <StatTile
              label="Venues"
              value={stats.venues.toString().padStart(2, "0")}
              tier="neutral"
            />
            <StatTile
              label="Open Incidents"
              value={stats.incidents.toString().padStart(2, "0")}
              tier={stats.incidents > 0 ? "c" : "neutral"}
            />
            <StatTile
              label="Compliance"
              value={stats.compliance.toString().padStart(2, "0")}
              tier={stats.compliance > 0 ? "b" : "neutral"}
            />
            <StatTile
              label="Avg Risk"
              value={avgScore ?? "—"}
              unit="/100"
              tier={avgScore != null && avgScore >= 80 ? "a" : avgScore != null && avgScore >= 60 ? "c" : avgScore != null ? "d" : "neutral"}
            />
          </StatStrip>
        ) : (
          <StatStrip className="lc-hero__meta">
            <StatTile
              label="Your Venues"
              value={stats.venues.toString().padStart(2, "0")}
              tier="neutral"
            />
            <StatTile
              label="Open Incidents"
              value={stats.incidents.toString().padStart(2, "0")}
              tier={stats.incidents > 0 ? "d" : "neutral"}
            />
            <StatTile
              label="Open Claims"
              value={(stats.claims ?? 0).toString().padStart(2, "0")}
              tier={(stats.claims ?? 0) > 0 ? "b" : "neutral"}
            />
            <StatTile
              label="Compliance"
              value={stats.compliance.toString().padStart(2, "0")}
              tier={stats.compliance > 0 ? "b" : "neutral"}
            />
          </StatStrip>
        )}
      </section>
      )}

      {/* TICKER — portfolio-wide signal; hidden for operator (single venue),
          and hidden on phone-broker (the compact header replaces it) */}
      {isBroker && !showMobileBroker && (
        <div className="lc-ticker" aria-hidden>
          <div className="lc-ticker__track">{tickerItems}</div>
        </div>
      )}

      {/* Venue switcher */}
      {!isBroker && venuesList.length > 1 && (
        <div style={{ marginBottom: "var(--space-xl)" }}>
          <span className="lc-stat-label" style={{ display: "block", marginBottom: 10 }}>Viewing</span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {venuesList.map((v) => (
              <button
                key={v.id}
                className="lc-chip"
                data-active={v.id === selectedVenueId}
                onClick={() => {
                  if (v.id !== selectedVenueId) {
                    setLoading(true);
                    router.replace(`/dashboard?venue=${encodeURIComponent(v.id)}`);
                  }
                }}
                title={v.name}
              >{v.name}</button>
            ))}
          </div>
        </div>
      )}

      {/* BROKER: needs-you triage strip */}
      {isBroker && (() => {
        const expiringRenewals = portfolioVenues.filter((v) => {
          if (!v.renewal_date) return false;
          const d = new Date(v.renewal_date).getTime() - Date.now();
          return d >= 0 && d <= 60 * 24 * 60 * 60 * 1000;
        }).length;
        return <BrokerTriageStrip expiringRenewals={expiringRenewals} />;
      })()}

      {/* BROKER: triage console */}
      {isBroker && (
        <BrokerTriage
          venues={filteredPortfolioVenues}
          totalCount={portfolioVenues.length}
          searchQuery={searchQuery}
          onSearch={setSearchQuery}
        />
      )}

      {/* OPERATOR: empty state */}
      {!isBroker && !riskScore && !quote && (
        <div className="lc-rule"><span className="lc-rule__label">Setup</span><div className="lc-rule__line" /></div>
      )}
      {!isBroker && !riskScore && !quote && (
        <Link href="/venues" style={{ textDecoration: "none" }}>
          <div className="lc-card"><div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="lc-stat-label">No venue data yet</span>
            <h2 className="lc-display" style={{ fontSize: "2rem", margin: 0 }}>Set up <em>your venue</em></h2>
            <p className="text-muted" style={{ maxWidth: 480 }}>
              Add your venue details to generate a risk profile and premium quote.
            </p>
            <span className="lc-link" style={{ marginTop: 12 }}>Go to Venues <ArrowUpRight size={14} /></span>
          </div></div>
        </Link>
      )}

      {/* OPERATOR: first-run nudge — venue exists but no incidents logged yet */}
      {!isBroker && (riskScore || quote) && stats.incidents === 0 && (
        <>
          <div className="lc-rule"><span className="lc-rule__label">First run</span><div className="lc-rule__line" /></div>
          <div className="lc-card"><div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span className="lc-stat-label">Your venue is set up</span>
            <p className="text-muted" style={{ maxWidth: 480, margin: 0 }}>
              Log your first incident to see how evidence shapes your risk score and premium.
            </p>
            <Link
              href="/incidents"
              style={{
                alignSelf: "flex-start", marginTop: 6,
                display: "inline-flex", alignItems: "center", gap: "0.4rem",
                padding: "0.55rem 1rem", fontWeight: 600, fontSize: "0.9rem",
                color: "var(--text-inverse)", background: "var(--brand-primary)",
                border: "1.5px solid var(--border-strong)", boxShadow: "var(--shadow-md)", textDecoration: "none",
              }}
            >
              Log your first incident <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </div></div>
        </>
      )}

      {/* OPERATOR: needs-you strip + report feed */}
      {!isBroker && tenantId && (
        <OperatorReportFeed
          venueId={(selectedVenueId ?? tenantId)!}
          complianceDue={liveState?.compliance_queue?.length ?? 0}
        />
      )}

      {/* OPERATOR: jump straight to this venue's profile (its risk profile) —
          not the venue roster, which is for managing/adding venues. */}
      {!isBroker && tenantId && (
        <div className="mb-lg">
          <Link href={`/risk-profile/${selectedVenueId ?? tenantId}`} className="lc-link text-xs">
            View venue profile <ArrowUpRight size={12} aria-hidden="true" />
          </Link>
        </div>
      )}

      {/* OPERATOR: "On The Floor" — live state is hero, policy is secondary */}
      {!isBroker && (riskScore || quote || liveState) && (
        <OperatorFloor
          riskScore={riskScore}
          quote={quote}
          liveState={liveState}
          venueId={selectedVenueId ?? tenantId}
          portfolioVenues={portfolioVenues}
          timeStamp={timeStamp}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------
   OPERATOR FLOOR — at 9pm the manager doesn't want to read coverage
   line items, they want to know: am I full, are my cameras up, can I
   keep the door open. Live state is the hero; policy is secondary.
   ---------------------------------------------------------------------- */

interface OperatorFloorProps {
  riskScore: RiskScore | null;
  quote: PremiumQuote | null;
  liveState: LiveState | null;
  venueId: string | null;
  portfolioVenues: PortfolioVenue[];
  timeStamp: string;
}

function OperatorFloor({ riskScore, quote, liveState, venueId, portfolioVenues, timeStamp }: OperatorFloorProps) {
  const capPct = liveState && liveState.max_capacity > 0
    ? (liveState.current_capacity / liveState.max_capacity) * 100
    : 0;
  const capColor = capPct >= 95 ? "var(--state-error)" : capPct >= 80 ? "var(--state-warning)" : "var(--tier-a)";
  const capMood = capPct >= 95 ? "At capacity"
    : capPct >= 80 ? "Filling fast"
    : capPct >= 50 ? "Healthy flow"
    : capPct > 0 ? "Quiet floor"
    : "Doors closed";

  const degradedCount = liveState?.infrastructure?.filter(i => i.is_degraded).length ?? 0;
  const totalInfra = liveState?.infrastructure?.length ?? 0;

  return (
    <>
      <div className="lc-rule">
        <span className="lc-rule__label">On the floor</span>
        <div className="lc-rule__line" />
        {liveState && (
          <span className="lc-stat-foot" style={{ color: degradedCount > 0 ? "var(--state-warning)" : "var(--state-success)" }}>
            {totalInfra > 0 ? `${totalInfra - degradedCount}/${totalInfra} systems operational` : ""}
          </span>
        )}
      </div>

      {/* LIVE STATUS — full-width hero, this is what a venue manager opens the app for */}
      {liveState && (
        <div className="lc-card" style={{ marginBottom: "var(--space-lg)" }}>
          <div className="lc-card__inner">
            <div className="flex justify-between items-start mb-md" style={{ gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 999,
                  background: "var(--state-error)",
                  boxShadow: "0 0 10px var(--state-error)",
                  animation: "status-pulse 1.5s ease-in-out infinite",
                }} />
                <span className="lc-stat-label" style={{ color: "var(--state-error)" }}>Live · {timeStamp}</span>
              </div>
              <span className="lc-stat-foot" style={{ fontStyle: "italic", color: capColor }}>{capMood}</span>
            </div>

            <div style={{
              display: "grid",
              gridTemplateColumns: "minmax(0, 1.2fr) minmax(0, 1fr)",
              gap: "var(--space-2xl)",
              alignItems: "end",
            }} className="op-floor-live">
              <div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 8 }}>
                  <span style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 500,
                    fontStyle: "italic",
                    fontSize: "clamp(3.5rem, 9vw, 6.5rem)",
                    lineHeight: 0.95,
                    letterSpacing: "-0.03em",
                    color: capColor,
                    fontVariantNumeric: "lining-nums tabular-nums",
                  }}>{liveState.current_capacity}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "1rem", color: "var(--text-tertiary)" }}>
                    / {liveState.max_capacity}
                  </span>
                  <span style={{
                    marginLeft: "auto",
                    fontFamily: "var(--font-mono)",
                    fontSize: "1.1rem",
                    color: capColor,
                    fontVariantNumeric: "tabular-nums",
                  }}>{Math.round(capPct)}%</span>
                </div>
                <div className="lc-bar" style={{ height: 6 }}>
                  <div className="lc-bar__fill" style={{
                    width: `${Math.min(100, capPct)}%`,
                    ['--bar-color' as string]: capColor,
                  }} />
                </div>
                <span className="lc-stat-foot" style={{ display: "block", marginTop: 10 }}>
                  Capacity tracked in real-time from your door-count and venue sensors.
                </span>
              </div>

              <div>
                <span className="lc-stat-label" style={{ display: "block", marginBottom: 12 }}>Infrastructure</span>
                <div className="lc-infra">
                  {liveState.infrastructure?.map((item, i) => (
                    <div key={i} className="lc-infra__cell" data-state={item.is_degraded ? "warn" : "ok"}>
                      <span>{item.name.replace(/_/g, " ").replace(/\[.*?\]/g, "").trim()}</span>
                      <span className="lc-infra__dot" />
                    </div>
                  ))}
                  {(!liveState.infrastructure || liveState.infrastructure.length === 0) && (
                    <span className="lc-stat-foot">No infrastructure telemetry yet.</span>
                  )}
                </div>
              </div>
            </div>

            {/* Coverage consequence — the part only an insurance OS would tell you:
                translate live state into what it means for risk/evidence/claims. */}
            {(() => {
              const degraded = (liveState.infrastructure ?? [])
                .filter((i) => i.is_degraded)
                .map((i) => i.name.replace(/_/g, " ").replace(/\[.*?\]/g, "").trim());
              const lines: { tone: "error" | "warning" | "success"; text: string }[] = [];
              if (capPct >= 95) {
                lines.push({ tone: "error", text: "At capacity — exceeding it is a recordable compliance & liability event that lifts your risk score." });
              } else if (capPct >= 80) {
                lines.push({ tone: "warning", text: "Approaching capacity — a breach becomes a compliance event on your loss record." });
              }
              if (degraded.length > 0) {
                lines.push({ tone: "warning", text: `${degraded.join(", ")} down — incidents in ${degraded.length > 1 ? "these zones" : "this zone"} won't have video/sensor evidence, which weakens any claim. Restore to protect your coverage.` });
              }
              if (lines.length === 0) {
                lines.push({ tone: "success", text: "Evidence capture is green across the floor — every zone is recording, so any incident stays defensible." });
              }
              const toneColor: Record<string, string> = { error: "var(--state-error)", warning: "var(--state-warning)", success: "var(--accent-ink)" };
              return (
                <div style={{ marginTop: "var(--space-md)", borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-md)", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div className="text-xs uppercase tracking-wide text-muted">What this means for your coverage</div>
                  {lines.map((l, i) => (
                    <div key={i} className="flex items-start gap-xs text-sm" style={{ color: toneColor[l.tone], lineHeight: 1.5 }}>
                      {l.tone === "success"
                        ? <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
                        : <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />}
                      <span>{l.text}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* RISK + QUOTE — secondary policy row */}
      {(riskScore || quote) && (
        <div className="lc-rule">
          <span className="lc-rule__label">Risk &amp; policy</span>
          <div className="lc-rule__line" />
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: riskScore && quote ? "repeat(auto-fit, minmax(min(360px, 100%), 1fr))" : "1fr",
        gap: "var(--space-lg)",
        // Top-align so the shorter Risk Profile card hugs its content instead of
        // stretching into a hollow card beside the taller Premium Quote.
        alignItems: "start",
      }}>
        {riskScore && (
          <Link href={`/risk-profile/${venueId}`} style={{ textDecoration: "none" }}>
            <div className="lc-card"><div className="lc-card__inner">
              <div className="flex justify-between items-start mb-md">
                <span className="lc-stat-label">Risk Profile</span>
                <span className="lc-tier" style={{ color: TIER_COLOR[riskScore.tier] }}>Tier {riskScore.tier}</span>
              </div>
              <div className="flex items-baseline gap-sm" style={{ marginBottom: 14 }}>
                <span className="lc-num-data lc-num-data--lg" style={{ color: TIER_COLOR[riskScore.tier] }}>{riskScore.total_score}</span>
                <span className="text-muted" style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>/ 100</span>
              </div>
              {/* Attention headline + compact factor bars: shows WHAT drives the score
                  (balances the card vs the policy column). Full advice on /risk-profile. */}
              {(() => {
                const attn = riskAttentionLine(riskScore.factors);
                return (
                  <div className="flex items-center gap-sm" style={{ color: FACTOR_TIER_COLOR[attn.tier], fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.85rem" }}>
                    <span aria-hidden>{FACTOR_GLYPH[attn.tier]}</span>
                    <span>{attn.text}</span>
                  </div>
                );
              })()}
              <div style={{ marginTop: "var(--space-md)", display: "flex", flexDirection: "column", gap: 7 }}>
                {Object.entries(riskScore.factors)
                  .map(([k, v]) => [k, typeof v === "number" ? v : v.score] as const)
                  .sort((a, b) => a[1] - b[1])
                  .map(([k, s]) => {
                    const c = FACTOR_TIER_COLOR[getFactorTier(s)];
                    return (
                      <div key={k} className="flex items-center gap-sm" style={{ fontSize: "0.76rem" }}>
                        <span className="text-secondary" title={factorLabel(k)} style={{ flex: "0 0 104px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{factorLabel(k)}</span>
                        <div style={{ flex: 1, height: 5, borderRadius: 3, background: "var(--bg-elevated)", overflow: "hidden" }} aria-hidden="true">
                          <div style={{ width: `${Math.max(0, Math.min(100, s))}%`, height: "100%", background: c, borderRadius: 3 }} />
                        </div>
                        <span className="font-mono" style={{ flex: "0 0 26px", textAlign: "right", color: c, fontVariantNumeric: "tabular-nums" }}>{Math.round(s)}</span>
                      </div>
                    );
                  })}
              </div>
              <span className="lc-link" style={{ marginTop: 18 }}>Full analysis <ArrowUpRight size={13} /></span>
            </div></div>
          </Link>
        )}

        {quote && (() => {
          const selectedVenue = portfolioVenues.find((v) => v.id === venueId);
          const renewalDate = quote.renewal_date ?? selectedVenue?.renewal_date;
          const carrier = selectedVenue?.current_carrier;

          // Insured operator → show the ACTUAL bound policy, not the indicative
          // estimate. The "vs market / you save" framing is prospect-only.
          const pol = quote.policy;
          if (pol) {
            const annual = Number(pol.annual_premium);
            const monthly = Number(pol.monthly_premium);
            return (
              <div className="lc-card"><div className="lc-card__inner">
                <div className="flex justify-between items-start mb-md">
                  <span className="lc-stat-label">Your Policy</span>
                  <span className="lc-tier" style={{ color: TIER_COLOR[quote.tier] }}>{quote.venue_type.replace(/_/g, " ")}</span>
                </div>
                <div className="flex items-baseline gap-sm" style={{ marginBottom: 8 }}>
                  <span className="lc-numeral lc-numeral--indigo">${Math.round(annual).toLocaleString()}</span>
                  <span className="lc-stat-foot" style={{ fontSize: "0.9rem" }}>/ year</span>
                </div>
                <span className="lc-stat-foot">${Math.round(monthly).toLocaleString()} / month · annualized</span>
                <div style={{ height: 1, background: "var(--border-subtle)", margin: "20px 0 14px" }} />
                {pol.policy_number && (
                  <div className="lc-cov-row"><span className="lc-cov-row__name">Policy</span><span className="lc-cov-row__check font-mono" data-included="true">{pol.policy_number}</span></div>
                )}
                <div className="lc-cov-row"><span className="lc-cov-row__name">Status</span><span className="lc-cov-row__check" data-included="true" style={{ textTransform: "capitalize" }}>{pol.status.replace(/_/g, " ")}</span></div>
                <div className="lc-cov-row" style={{ borderBottom: 0 }}><span className="lc-cov-row__name">Term</span><span className="lc-cov-row__check font-mono">{pol.effective_date} → {pol.expiration_date}</span></div>
                {pol.coverage_lines.length > 0 && (
                  <>
                    <div style={{ height: 1, background: "var(--border-subtle)", margin: "16px 0 8px" }} />
                    <span className="lc-stat-label">Coverage lines</span>
                    <div style={{ marginTop: 8 }}>
                      {pol.coverage_lines.map((c) => (
                        <div key={c} className="lc-cov-row"><span className="lc-cov-row__name" style={{ textTransform: "uppercase" }}>{c.replace(/_/g, " ")}</span><span className="lc-cov-row__check" data-included="true">✓ bound</span></div>
                      ))}
                    </div>
                  </>
                )}
                <Link href="/coverage" className="lc-link" style={{ marginTop: 18, display: "inline-flex" }}>View coverage <ArrowUpRight size={13} /></Link>
              </div></div>
            );
          }

          const savingsPct = Math.max(0, Math.min(100, Math.round(quote.savings_pct ?? 0)));
          const coverageEntries = quote.coverage_breakdown ? Object.entries(quote.coverage_breakdown) : [];
          return (
            <div className="lc-card"><div className="lc-card__inner">
              <div className="flex justify-between items-start mb-md">
                <span className="lc-stat-label">Indicative premium</span>
                <span className="lc-tier" style={{ color: TIER_COLOR[quote.tier] }}>{quote.venue_type.replace(/_/g, " ")}</span>
              </div>
              <div className="flex items-baseline gap-sm" style={{ marginBottom: 8 }}>
                <span className="lc-numeral lc-numeral--indigo">${quote.annual_premium.toLocaleString()}</span>
                <span className="lc-stat-foot" style={{ fontSize: "0.9rem" }}>/ year</span>
              </div>
              <span className="lc-stat-foot">${quote.monthly_premium.toLocaleString()} / month · annualized</span>

              {quote.market_rate_annual != null && (
                <>
                  <div style={{ height: 1, background: "var(--border-subtle)", margin: "20px 0 14px" }} />
                  <div className="lc-cov-row">
                    <span className="lc-cov-row__name">vs. market rate</span>
                    <span className="lc-cov-row__check" data-included="false">${quote.market_rate_annual.toLocaleString()}/yr</span>
                  </div>
                  {quote.savings_annual != null && quote.savings_annual > 0 && (
                    <>
                      <div className="lc-cov-row" style={{ borderBottom: 0, paddingBottom: 4 }}>
                        <span className="lc-cov-row__name">you save</span>
                        <span className="lc-cov-row__check">${quote.savings_annual.toLocaleString()}/yr ({savingsPct}%)</span>
                      </div>
                      <div className="lc-savings-bar" aria-hidden style={{ marginTop: 4 }}>
                        <div className="lc-savings-bar__fill" style={{ width: `${savingsPct}%` }} />
                      </div>
                    </>
                  )}
                </>
              )}

              {coverageEntries.length > 0 && (
                <>
                  <div style={{ height: 1, background: "var(--border-subtle)", margin: "20px 0 8px" }} />
                  <span className="lc-stat-label">Coverage included</span>
                  <div style={{ marginTop: 8 }}>
                    {coverageEntries.map(([key, line]) => {
                      const label = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                      const isIncluded = line.included === true;
                      return (
                        <div key={key} className="lc-cov-row">
                          <span className="lc-cov-row__name">{label}</span>
                          <span className="lc-cov-row__check" data-included={isIncluded ? "true" : "false"}>
                            {isIncluded ? "✓ included" : "+ add-on"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {(renewalDate || carrier) && (
                <>
                  <div style={{ height: 1, background: "var(--border-subtle)", margin: "16px 0 6px" }} />
                  <p className="lc-stat-foot" style={{ marginTop: 4 }}>
                    {renewalDate && <>Renews {renewalDate}</>}
                    {renewalDate && carrier && " · "}
                    {carrier && <>with {carrier}</>}
                  </p>
                </>
              )}
            </div></div>
          );
        })()}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------
   BROKER TRIAGE — the dashboard is a working surface, not a marketing
   page. Rows are scannable; the preview pane is where the underwriter
   thinks. Buckets sort the book by what needs attention right now.
   ---------------------------------------------------------------------- */

type Bucket = "tonight" | "watchlist" | "standing";
type Filter = "all" | Bucket | "renewals";

function classifyVenue(v: PortfolioVenue): Bucket {
  const capPct = v.current_capacity != null && v.capacity > 0 ? v.current_capacity / v.capacity : 0;
  const acute = v.open_incidents > 0 || v.has_degraded_infra || capPct >= 0.9 || v.compliance_actions > 0;
  if (acute) return "tonight";
  if (v.tier === "C" || v.tier === "D") return "watchlist";
  return "standing";
}

function daysUntil(dateStr?: string): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

const BUCKET_LABEL: Record<Bucket, string> = {
  tonight: "Tonight",
  watchlist: "Watchlist",
  standing: "Standing",
};

interface BrokerTriageProps {
  venues: PortfolioVenue[];
  totalCount: number;
  searchQuery: string;
  onSearch: (q: string) => void;
}

function BrokerTriage({ venues, totalCount, searchQuery, onSearch }: BrokerTriageProps) {
  const [filter, setFilter] = useState<Filter>("all");

  const tagged = useMemo(
    () => venues.map(v => ({ ...v, _bucket: classifyVenue(v), _daysToRenew: daysUntil(v.renewal_date) })),
    [venues],
  );

  const visible = useMemo(() => {
    if (filter === "all") return tagged;
    if (filter === "renewals") return tagged.filter(v => v._daysToRenew != null && v._daysToRenew <= 30 && v._daysToRenew >= -7);
    return tagged.filter(v => v._bucket === filter);
  }, [tagged, filter]);

  // Counts for chip labels (computed against the search-filtered set, not the bucket-filtered set)
  const counts = useMemo(() => ({
    all: tagged.length,
    tonight: tagged.filter(v => v._bucket === "tonight").length,
    watchlist: tagged.filter(v => v._bucket === "watchlist").length,
    standing: tagged.filter(v => v._bucket === "standing").length,
    renewals: tagged.filter(v => v._daysToRenew != null && v._daysToRenew <= 30 && v._daysToRenew >= -7).length,
  }), [tagged]);

  // Group rows when filter === "all" so the underwriter sees urgency structure
  const grouped: Array<{ bucket: Bucket; items: typeof visible }> = useMemo(() => {
    if (filter !== "all") return [{ bucket: "tonight", items: visible }];
    const order: Bucket[] = ["tonight", "watchlist", "standing"];
    return order
      .map(bucket => ({
        bucket,
        items: visible
          .filter(v => v._bucket === bucket)
          .sort((a, b) => a.total_score - b.total_score),
      }))
      .filter(g => g.items.length > 0);
  }, [visible, filter]);

  return (
    <>
      <div className="lc-triage__head">
        <span className="lc-triage__title">The Book</span>
        <span className="lc-triage__kpi">
          {searchQuery.trim() ? <><b>{visible.length}</b> / {totalCount}</> : <><b>{String(totalCount).padStart(2, "0")}</b> venues</>}
          {counts.tonight > 0 && <> · <span className="lc-triage__kpi-hi">{counts.tonight} need eyes</span></>}
        </span>

        <SearchInput
          value={searchQuery}
          onChange={onSearch}
          placeholder="Search venues, types, addresses…"
          style={{ flex: "0 1 280px", marginLeft: 18 }}
        />

        <div className="lc-triage__chips">
          <button className="lc-triage__chip" data-active={filter === "all"} onClick={() => setFilter("all")}>
            All · {counts.all}
          </button>
          <button className="lc-triage__chip" data-active={filter === "tonight"} onClick={() => setFilter("tonight")}>
            Tonight · {counts.tonight}
          </button>
          <button className="lc-triage__chip" data-active={filter === "watchlist"} onClick={() => setFilter("watchlist")}>
            Watchlist · {counts.watchlist}
          </button>
          <button className="lc-triage__chip" data-active={filter === "renewals"} onClick={() => setFilter("renewals")}>
            Renewals 30d · {counts.renewals}
          </button>
        </div>
      </div>

      <div className="lc-triage lc-triage--book">
        <div className="lc-triage__list">
          {visible.length === 0 ? (
            <div className="lc-triage__empty">
              <span className="lc-stat-label">No venues match this view</span>
              <p className="text-muted" style={{ maxWidth: 260, fontSize: "0.85rem" }}>
                {searchQuery.trim() ? `Nothing matches "${searchQuery}".` : "Try a different filter."}
              </p>
            </div>
          ) : grouped.map(group => (
            <React.Fragment key={group.bucket}>
              <div className="lc-triage__group-head" data-critical={group.bucket === "tonight"}>
                <span className="lc-triage__group-label lc-stat-label">{BUCKET_LABEL[group.bucket]}</span>
                <span className="lc-stat-foot">{String(group.items.length).padStart(2, "0")}</span>
              </div>
              {group.items.map(v => (
                <TriageRow key={v.id} venue={v} />
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </>
  );
}

function TriageRow({
  venue,
}: {
  venue: PortfolioVenue & { _bucket: Bucket; _daysToRenew: number | null };
}) {
  const tierColor = TIER_COLOR[venue.tier] || "var(--text-tertiary)";
  const capPct = venue.current_capacity != null && venue.capacity > 0 ? (venue.current_capacity / venue.capacity) * 100 : 0;
  const capCritical = capPct >= 95;
  const incidentsHot = venue.open_incidents > 0;
  const renewalSoon = venue._daysToRenew != null && venue._daysToRenew <= 14;

  return (
    <Link
      href={`/risk-profile/${venue.id}`}
      className="lc-triage__row"
      data-bucket={venue._bucket}
      style={{ borderLeftColor: tierColor }}
      aria-label={`Open risk profile for ${venue.name}`}
    >
      <div style={{ minWidth: 0 }}>
        <div className="lc-triage__row-title" style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{venue.name}</span>
          {incidentsHot && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "var(--font-mono)", fontStyle: "normal", fontSize: "0.62rem", color: "var(--state-error)", letterSpacing: "0.08em" }}>
              <AlertTriangle size={9} /> {venue.open_incidents}
            </span>
          )}
          {venue.compliance_actions > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "var(--font-mono)", fontStyle: "normal", fontSize: "0.62rem", color: "var(--brand-secondary)", letterSpacing: "0.08em" }}>
              <CheckSquare size={9} /> {venue.compliance_actions}
            </span>
          )}
          {venue.has_degraded_infra && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontFamily: "var(--font-mono)", fontStyle: "normal", fontSize: "0.62rem", color: "var(--state-warning)", letterSpacing: "0.08em" }}>
              <WifiOff size={9} /> DEG
            </span>
          )}
        </div>
        <div className="lc-triage__row-sub">
          {venue.venue_type.replace(/_/g, " ")} · {venue.current_capacity != null ? `${venue.current_capacity}/${venue.capacity.toLocaleString()}` : `${venue.capacity.toLocaleString()} cap`}
          {capCritical && <span style={{ color: "var(--state-error)", marginLeft: 6 }}>· {Math.round(capPct)}%</span>}
        </div>
      </div>
      <div className="lc-triage__row-meta">
        <span className="conf" style={{ color: tierColor }}>{venue.total_score}</span>
        <div className="lc-triage__row-tierline">
          <TierBadge tier={venue.tier as UiTier} />
          {venue._daysToRenew != null && (
            <span className="date" style={{ color: renewalSoon ? "var(--state-warning)" : undefined }}>
              {venue._daysToRenew < 0 ? `${Math.abs(venue._daysToRenew)}d past` : `${venue._daysToRenew}d`}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
