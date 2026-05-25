"use client";

import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRole, useTenantId, useAuth } from "@/contexts/AuthContext";
import { Building2, LogOut, MapPin, ArrowUpRight, WifiOff, Search, AlertTriangle, CheckSquare, Activity } from "lucide-react";
import Link from "next/link";
import { Grid } from "@/components/layout/Grid";
import { authHeaders } from "@/lib/authFetch";
import { StatStrip } from "@/components/ui/StatStrip";
import { StatTile } from "@/components/ui/StatTile";
import { TierBadge, Tier as UiTier } from "@/components/ui/TierBadge";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface PortfolioVenue {
  id: string;
  name: string;
  venue_type: string;
  address: string;
  capacity: number;
  current_capacity: number;
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
}

interface Stats { venues: number; incidents: number; compliance: number; }

const TIER_COLOR: Record<string, string> = {
  A: "var(--tier-a)",
  B: "var(--tier-b)",
  C: "var(--tier-c)",
  D: "var(--tier-d)",
};

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
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

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
          const [liveRes, riskRes, quoteRes, incidentsRes] = await Promise.all([
            fetch(`${API_URL}/api/venues/${venueId}/live`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/risk-score`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/quote`, { headers: authHeaders() }),
            fetch(`${API_URL}/api/venues/${venueId}/incidents?status=open`, { headers: authHeaders() }),
          ]);
          const incidentCount = incidentsRes.ok ? (await incidentsRes.json()).length : 0;
          if (cancelled) return;
          if (liveRes.ok) {
            const state = await liveRes.json();
            setLiveState(state);
            setStats({
              venues: totalVenueCount,
              incidents: incidentCount,
              compliance: state.compliance_queue?.length || 0,
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

  const handleSignOut = () => { signOut(); router.push("/login"); };

  if (!isSignedIn || loading) {
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
  const atCapacity = portfolioVenues.filter(v => v.capacity > 0 && v.current_capacity / v.capacity >= 0.9).length;
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

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      {/* HERO */}
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
              label="Compliance"
              value={stats.compliance.toString().padStart(2, "0")}
              tier={stats.compliance > 0 ? "b" : "neutral"}
            />
          </StatStrip>
        )}
      </section>

      {/* TICKER — portfolio-wide signal; hidden for operator (single venue) */}
      {isBroker && (
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
          </div>
        </div>
      )}

      {/* RISK + QUOTE — secondary policy row */}
      {(riskScore || quote) && (
        <div className="lc-rule">
          <span className="lc-rule__label">Your policy</span>
          <div className="lc-rule__line" />
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: riskScore && quote ? "repeat(auto-fit, minmax(min(360px, 100%), 1fr))" : "1fr",
        gap: "var(--space-lg)",
      }}>
        {riskScore && (
          <Link href={`/risk-profile/${venueId}`} style={{ textDecoration: "none" }}>
            <div className="lc-card"><div className="lc-card__inner">
              <div className="flex justify-between items-start mb-md">
                <span className="lc-stat-label">Risk Profile</span>
                <span className="lc-tier" style={{ color: TIER_COLOR[riskScore.tier] }}>Tier {riskScore.tier}</span>
              </div>
              <div className="flex items-baseline gap-sm" style={{ marginBottom: 24 }}>
                <span className="lc-num-data lc-num-data--lg" style={{ color: TIER_COLOR[riskScore.tier] }}>{riskScore.total_score}</span>
                <span className="text-muted" style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>/ 100</span>
              </div>
              <div className="flex flex-col gap-md">
                {Object.entries(riskScore.factors).map(([key, data]) => (
                  <div key={key} style={{ display: "grid", gridTemplateColumns: "minmax(0, 9rem) minmax(0, 1fr) 2.5rem", alignItems: "center", gap: 14 }}>
                    <span className="lc-stat-label" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{key.replace(/_/g, " ")}</span>
                    <div className="lc-bar"><div className="lc-bar__fill" style={{ width: `${data.score}%`, ['--bar-color' as string]: TIER_COLOR[riskScore.tier] }} /></div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", textAlign: "right", color: "var(--text-secondary)" }}>{data.score}</span>
                  </div>
                ))}
              </div>
              <span className="lc-link" style={{ marginTop: 22 }}>Full analysis <ArrowUpRight size={13} /></span>
            </div></div>
          </Link>
        )}

        {quote && (() => {
          const selectedVenue = portfolioVenues.find((v) => v.id === venueId);
          const renewalDate = quote.renewal_date ?? selectedVenue?.renewal_date;
          const carrier = selectedVenue?.current_carrier;
          const savingsPct = Math.max(0, Math.min(100, Math.round(quote.savings_pct ?? 0)));
          const coverageEntries = quote.coverage_breakdown ? Object.entries(quote.coverage_breakdown) : [];
          return (
            <div className="lc-card"><div className="lc-card__inner">
              <div className="flex justify-between items-start mb-md">
                <span className="lc-stat-label">Premium Quote</span>
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
  const capPct = v.capacity > 0 ? v.current_capacity / v.capacity : 0;
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  // Default selection: first row, biased toward most urgent
  useEffect(() => {
    if (visible.length === 0) { setSelectedId(null); return; }
    if (selectedId && visible.some(v => v.id === selectedId)) return;
    const sorted = [...visible].sort((a, b) => {
      const order = { tonight: 0, watchlist: 1, standing: 2 } as const;
      return order[a._bucket] - order[b._bucket] || a.total_score - b.total_score;
    });
    setSelectedId(sorted[0]?.id ?? null);
  }, [visible, selectedId]);

  const selected = visible.find(v => v.id === selectedId) ?? null;

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

        <div className="lc-search" style={{ flex: "0 1 280px", marginLeft: 18 }}>
          <Search size={14} />
          <input
            placeholder="Search venues, types, addresses…"
            value={searchQuery}
            onChange={e => onSearch(e.target.value)}
          />
        </div>

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

      <div className="lc-triage">
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
                <TriageRow
                  key={v.id}
                  venue={v}
                  selected={v.id === selectedId}
                  onSelect={() => setSelectedId(v.id)}
                />
              ))}
            </React.Fragment>
          ))}
        </div>

        <aside className="lc-triage__preview">
          {selected ? <TriagePreview venue={selected} /> : (
            <div className="lc-triage__empty">
              <span className="lc-stat-label">Select a venue</span>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function TriageRow({
  venue,
  selected,
  onSelect,
}: {
  venue: PortfolioVenue & { _bucket: Bucket; _daysToRenew: number | null };
  selected: boolean;
  onSelect: () => void;
}) {
  const tierColor = TIER_COLOR[venue.tier] || "#8b8fa8";
  const capPct = venue.capacity > 0 ? (venue.current_capacity / venue.capacity) * 100 : 0;
  const capCritical = capPct >= 95;
  const incidentsHot = venue.open_incidents > 0;
  const renewalSoon = venue._daysToRenew != null && venue._daysToRenew <= 14;

  return (
    <div
      className="lc-triage__row"
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
    >
      <span
        className="lc-triage__dot"
        data-filled={venue._bucket === "tonight" ? "true" : "false"}
        style={{ color: tierColor, background: tierColor }}
      />
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
          {venue.venue_type.replace(/_/g, " ")} · {venue.current_capacity}/{venue.capacity.toLocaleString()}
          {capCritical && <span style={{ color: "var(--state-error)", marginLeft: 6 }}>· {Math.round(capPct)}%</span>}
        </div>
      </div>
      <div className="lc-triage__row-meta">
        <span className="conf" style={{ color: tierColor }}>{venue.total_score}</span>
        <div className="date" style={{ color: renewalSoon ? "var(--state-warning)" : undefined }}>
          {venue._daysToRenew != null
            ? venue._daysToRenew < 0 ? `${Math.abs(venue._daysToRenew)}d past` : `${venue._daysToRenew}d`
            : <TierBadge tier={venue.tier as UiTier} />}
        </div>
      </div>
    </div>
  );
}

function TriagePreview({ venue }: { venue: PortfolioVenue & { _bucket: Bucket; _daysToRenew: number | null } }) {
  const tierColor = TIER_COLOR[venue.tier] || "#8b8fa8";
  const capPct = venue.capacity > 0 ? (venue.current_capacity / venue.capacity) * 100 : 0;
  const capColor = capPct >= 95 ? "var(--state-error)" : capPct >= 80 ? "var(--state-warning)" : "var(--tier-a)";

  return (
    <>
      <div className="lc-triage__preview-head">
        <span className="lc-stat-label" style={{ color: tierColor, display: "block", marginBottom: 8 }}>{venue.venue_type.replace(/_/g, " ")}</span>
        <h3>{venue.name}</h3>
        <div className="lc-triage__preview-meta" style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          {venue.address && <><MapPin size={11} /> {venue.address}</>}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 4 }}>
        <span className="lc-num-data lc-num-data--lg" style={{ color: tierColor }}>{venue.total_score}</span>
        <span className="text-muted" style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>/ 100</span>
        <span className="lc-tier" style={{ color: tierColor, marginLeft: "auto" }}>Tier {venue.tier}</span>
      </div>

      <div style={{ marginTop: 14, marginBottom: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span className="lc-stat-label">Live capacity</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.74rem", color: capColor }}>
            {venue.current_capacity} <span style={{ color: "var(--text-tertiary)" }}>/ {venue.capacity.toLocaleString()}</span>
            <span style={{ marginLeft: 8, color: "var(--text-tertiary)" }}>{Math.round(capPct)}%</span>
          </span>
        </div>
        <div className="lc-bar"><div className="lc-bar__fill" style={{ width: `${Math.min(100, capPct)}%`, ['--bar-color' as string]: capColor }} /></div>
      </div>

      <div className="lc-triage__preview-section">
        <h4>Open signals</h4>
        <dl style={{ display: "grid", gap: 2 }}>
          <div className="lc-triage__kv"><dt>Incidents</dt><dd style={{ color: venue.open_incidents > 0 ? "var(--state-error)" : "var(--text-secondary)" }}>{venue.open_incidents.toString().padStart(2, "0")} open</dd></div>
          <div className="lc-triage__kv"><dt>Compliance</dt><dd style={{ color: venue.compliance_actions > 0 ? "var(--brand-secondary)" : "var(--text-secondary)" }}>{venue.compliance_actions.toString().padStart(2, "0")} action{venue.compliance_actions === 1 ? "" : "s"}</dd></div>
          <div className="lc-triage__kv"><dt>Infrastructure</dt><dd style={{ color: venue.has_degraded_infra ? "var(--state-warning)" : "var(--state-success)" }}>{venue.has_degraded_infra ? "Degraded" : "Operational"}</dd></div>
        </dl>
      </div>

      <div className="lc-triage__preview-section">
        <h4>Policy</h4>
        <dl style={{ display: "grid", gap: 2 }}>
          <div className="lc-triage__kv"><dt>Carrier</dt><dd>{venue.current_carrier || "—"}</dd></div>
          <div className="lc-triage__kv">
            <dt>Renews</dt>
            <dd style={{ color: venue._daysToRenew != null && venue._daysToRenew <= 14 ? "var(--state-warning)" : undefined }}>
              {venue.renewal_date}
              {venue._daysToRenew != null && (
                <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-tertiary)" }}>
                  ({venue._daysToRenew < 0 ? `${Math.abs(venue._daysToRenew)}d past` : `in ${venue._daysToRenew}d`})
                </span>
              )}
            </dd>
          </div>
        </dl>
      </div>

      <div className="lc-triage__actions">
        <Link href={`/risk-profile/${venue.id}`} className="lc-triage__btn" data-tone="approve">
          <Activity size={13} /> Risk Profile <ArrowUpRight size={12} />
        </Link>
        <Link href={`/incidents?venue=${encodeURIComponent(venue.id)}`} className="lc-triage__btn">
          <AlertTriangle size={13} /> Incidents
        </Link>
        <Link href={`/compliance?venue=${encodeURIComponent(venue.id)}`} className="lc-triage__btn">
          <CheckSquare size={13} /> Compliance
        </Link>
      </div>
    </>
  );
}
