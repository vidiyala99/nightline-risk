"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { Upload, AlertTriangle, ShieldCheck, TrendingUp, Calendar, Zap } from "lucide-react";
import { toastLoading, toastSuccess, toastError, toastDismiss } from "@/lib/toast";
import { authHeaders } from "@/lib/authFetch";
import { riskAttentionLine, FACTOR_TIER_COLOR, FACTOR_GLYPH } from "@/lib/risk";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const TIER_COLOR: Record<string, string> = {
  A: "var(--tier-a)",
  B: "var(--tier-b)",
  C: "var(--tier-c)",
  D: "var(--tier-d)",
};

const makeFallback = (venueId: string) => ({
  venue_id: venueId,
  current_capacity: 0,
  max_capacity: 500,
  premium_impact: 0,
  infrastructure: [],
  compliance_queue: [],
});

function SkeletonBlock({ width = "100%", height = "1rem", className = "" }: { width?: string; height?: string; className?: string }) {
  return (
    <div
      className={className}
      style={{
        width,
        height,
        background: "linear-gradient(90deg, var(--bg-surface, #FBF8F0) 25%, var(--bg-elevated, #FFFFFF) 50%, var(--bg-surface, #FBF8F0) 75%)",
        backgroundSize: "200% 100%",
        animation: "skeleton-scan 1.6s linear infinite",
        borderRadius: "var(--radius-sm, 4px)",
        opacity: 0.6,
      }}
    />
  );
}

function TerminalEmpty({ label, message }: { label: string; message: string }) {
  return (
    <div className="flex flex-col gap-sm p-sm" style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
      <div className="text-xs" style={{ color: "var(--accent-ink)", opacity: 0.7 }}>
        &gt; {label}
      </div>
      <div className="text-xs">{message}</div>
      <div className="text-xs" style={{ color: "var(--accent-ink)", animation: "cursor-blink 1.2s step-end infinite" }}>█</div>
    </div>
  );
}

function VenueNotFound({ venueId }: { venueId: string }) {
  const router = useRouter();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-xl p-xl" style={{ fontFamily: "var(--font-mono)" }}>
      <div className="text-center" style={{ maxWidth: 480 }}>
        <div className="text-xs uppercase tracking-wide mb-md" style={{ color: "var(--state-error)" }}>
          ERR // VENUE_NOT_FOUND
        </div>
        <div className="text-4xl font-bold mb-lg" style={{ color: "var(--state-error)" }}>
          {venueId.toUpperCase()}
        </div>
        <div className="text-sm mb-xl" style={{ color: "var(--text-muted)" }}>
          No venue record matched this identifier. It may not be onboarded yet or your account may not have access.
        </div>
        <div className="flex gap-md justify-center">
          <button className="btn btn-secondary" onClick={() => router.push("/venues")}>
            View All Venues
          </button>
          <button className="btn btn-secondary" onClick={() => router.push("/dashboard")}>
            Back to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

export default function VenueTerminalPage() {
  const { venueId } = useParams() as { venueId: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [liveState, setLiveState] = useState(makeFallback(venueId));
  // The fallback's 0/500 is a placeholder, not real occupancy — track whether a
  // /live read has actually succeeded so we never render it as live data.
  const [liveLoaded, setLiveLoaded] = useState(false);
  const [venueInfo, setVenueInfo] = useState<{ name: string } | null>(null);
  const [riskScore, setRiskScore] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [simulatingAlert, setSimulatingAlert] = useState(false);
  const [insightLoading, setInsightLoading] = useState(true);
  const [venueNotFound, setVenueNotFound] = useState(false);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  // Hard role gate: /terminal is the operator's floor surface. Brokers
  // get routed to the broker-appropriate detail view for the same venue.
  useEffect(() => {
    if (isLoaded && isSignedIn && role && role !== "venue_operator") {
      router.replace(`/risk-profile/${venueId}`);
    }
  }, [isLoaded, isSignedIn, role, venueId, router]);

  const handleUpload = async (itemId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadingId(itemId);
    setUploadError(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/compliance/${itemId}/upload`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);
      setLiveState((prev) => ({
        ...prev,
        compliance_queue: prev.compliance_queue.filter((item: any) => item.id !== itemId),
      }));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingId(null);
    }
  };

  const simulateAlert = async () => {
    setSimulatingAlert(true);
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const tid = toastLoading("Injecting simulated alert…");
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/alerts/simulate`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          zone: "dance_floor",
          event_type: "altercation",
          severity: "critical",
          confidence: 0.88,
          description: "Simulated altercation detected near dance floor.",
        }),
      });
      toastDismiss();
      if (res.ok) {
        toastSuccess("Alert injected — visible on the Alerts page.");
      } else {
        toastError("Simulation failed. Check backend logs.");
      }
      // Refresh live state panel
      const live = await fetch(`${API_URL}/api/venues/${venueId}/live`, { headers: authHeaders() });
      if (live.ok) { setLiveState(await live.json()); setLiveLoaded(true); }
    } catch {
      toastDismiss();
      toastError("Network error — backend may be down.");
    } finally {
      setSimulatingAlert(false);
    }
  };

  // Fetch venue info, risk score, and quote once on mount
  useEffect(() => {
    setInsightLoading(true);
    Promise.all([
      fetch(`${API_URL}/api/venues/${venueId}`),
      // risk-score + quote are venue-access gated — send the operator/broker token.
      fetch(`${API_URL}/api/venues/${venueId}/risk-score`, { headers: authHeaders() }),
      fetch(`${API_URL}/api/venues/${venueId}/quote`, { headers: authHeaders() }),
    ]).then(async ([venueRes, riskRes, quoteRes]) => {
      if (venueRes.status === 404) {
        setVenueNotFound(true);
        return;
      }
      if (venueRes.ok) setVenueInfo(await venueRes.json());
      if (riskRes.ok) setRiskScore(await riskRes.json());
      if (quoteRes.ok) setQuote(await quoteRes.json());
    }).catch(() => {}).finally(() => setInsightLoading(false));
  }, [venueId]);

  // Live state polling
  useEffect(() => {
    const fetchState = async () => {
      try {
        const res = await fetch(`${API_URL}/api/venues/${venueId}/live`, { headers: authHeaders() });
        if (res.ok) { setLiveState(await res.json()); setLiveLoaded(true); }
      } catch {
        // fallback stays
      }
    };
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [venueId]);

  // Deep-link from the Risk Profile "Operational" factor (#infrastructure).
  // The terminal loads async, so a plain hash can't catch the element — scroll
  // once the insurance grid (which holds the Infrastructure section) is in.
  useEffect(() => {
    if (insightLoading || typeof window === "undefined") return;
    if (window.location.hash !== "#infrastructure") return;
    const el = document.getElementById("infrastructure");
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, [insightLoading]);

  if (venueNotFound) return <VenueNotFound venueId={venueId} />;

  const displayName = venueInfo?.name ?? venueId.replace(/-/g, " ").toUpperCase();
  const capacityPercent = liveState.max_capacity > 0
    ? (liveState.current_capacity / liveState.max_capacity) * 100
    : 0;
  const capacityColor =
    capacityPercent >= 95 ? "var(--state-error)" :
    capacityPercent >= 80 ? "var(--state-warning)" :
    "var(--brand-primary)";

  return (
    <>
      <style>{`
        @keyframes skeleton-scan {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes cursor-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>

      <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>

        {/* Editorial header */}
        <section className="lc-hero" style={{ alignItems: "end" }}>
          <div>
            <span className="lc-eyebrow">
              LIVE TERMINAL
              <span className="lc-eyebrow__sep" />
              {venueId.toUpperCase()}
            </span>
            <h1 className="lc-display" style={{ fontSize: "clamp(2.25rem, 5vw, 3.75rem)" }}>
              {displayName}
            </h1>
            <p className="lc-sub">Real-time floor telemetry — capacity, infra and compliance, scored against your bound coverage.</p>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 14, flexWrap: "wrap" }}>
            {process.env.NODE_ENV === "development" && (
              <button
                onClick={simulateAlert}
                disabled={simulatingAlert}
                className="lc-chip"
                title="Dev only: inject a camera anomaly event"
                style={{ borderColor: "rgba(245,158,11,0.4)", color: "var(--state-warning)" }}
              >
                <Zap size={12} style={{ marginRight: 6, display: "inline" }} />
                {simulatingAlert ? "Injecting…" : "Simulate Alert"}
              </button>
            )}
            <div className="lc-card" style={{ minWidth: 160 }}>
              <div className="lc-card__inner" style={{ padding: "14px 18px", textAlign: "left" }}>
                <span className="lc-stat-label">Coverage</span>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <span className="live-dot" />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "1rem", fontWeight: 600, letterSpacing: "0.18em", color: "var(--accent-ink)" }}>LIVE</span>
                </div>
                <span className="lc-stat-foot" style={{ display: "block", marginTop: 4 }}>{quote?.renewal_date ?? "—"}</span>
              </div>
            </div>
          </div>
        </section>

        {/* Savings hero — operators only */}
        {isOperator && insightLoading ? (
          <div className="lc-card" style={{ margin: "var(--space-xl) 0" }}>
            <div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <SkeletonBlock width="180px" height="0.75rem" />
              <SkeletonBlock width="280px" height="3rem" />
              <SkeletonBlock width="340px" height="0.75rem" />
            </div>
          </div>
        ) : isOperator && quote && quote.savings_annual > 0 ? (
          <div className="lc-card" style={{ margin: "var(--space-xl) 0" }}>
            <div className="lc-card__inner">
              <span className="lc-stat-label">Nightline saves you</span>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
                <span className="lc-numeral lc-numeral--accent">${quote.savings_annual.toLocaleString()}</span>
                <span className="lc-stat-foot">/ yr</span>
              </div>
              <p className="lc-sub" style={{ fontSize: "0.85rem", marginTop: 10 }}>
                vs. market rate of <strong style={{ color: "var(--text-primary)" }}>${quote.market_rate_annual.toLocaleString()}</strong> — {quote.savings_pct}% discount through evidence-first underwriting.
              </p>
            </div>
          </div>
        ) : null}

        {/* Capacity Bar */}
        <div className="card mb-xl">
          <div className="flex justify-between items-center mb-sm">
            <span className="text-xs uppercase tracking-wide text-secondary font-mono">
              Live Occupancy
            </span>
            {liveLoaded ? (
              <span className="lc-num-data" style={{ color: capacityColor, fontSize: "1.5rem" }}>
                {liveState.current_capacity}
                <span className="text-lg font-normal text-secondary" style={{ fontWeight: 400 }}> / {liveState.max_capacity}</span>
              </span>
            ) : (
              <span className="text-xs font-mono text-secondary">Awaiting telemetry…</span>
            )}
          </div>
          {liveLoaded && (
            <div className="capacity-bar">
              <div className="capacity-fill" style={{ width: `${capacityPercent}%`, background: capacityColor }} />
            </div>
          )}
        </div>

        {/* Insurance Overview — skeleton while loading */}
        {insightLoading ? (
          <div className="grid grid-cols-2 gap-lg mb-xl">
            <div className="card highlight" style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
              <SkeletonBlock width="120px" height="0.75rem" />
              <SkeletonBlock width="80px" height="3rem" />
              <SkeletonBlock width="100%" height="0.5rem" />
              <SkeletonBlock width="100%" height="0.5rem" />
              <SkeletonBlock width="80%" height="0.5rem" />
            </div>
            <div className="flex flex-col gap-lg">
              <div className="card border-accent" style={{ display: "flex", flexDirection: "column", gap: "var(--space-md)" }}>
                <SkeletonBlock width="80px" height="0.75rem" />
                <SkeletonBlock width="160px" height="2.5rem" />
                <SkeletonBlock width="100%" height="0.5rem" />
                <SkeletonBlock width="100%" height="0.5rem" />
              </div>
              <div className="card" style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                <SkeletonBlock width="80px" height="0.75rem" />
                <SkeletonBlock width="100%" height="0.5rem" />
                <SkeletonBlock width="100%" height="0.5rem" />
                <SkeletonBlock width="100%" height="0.5rem" />
              </div>
            </div>
          </div>
        ) : riskScore && quote ? (
          <div className="grid grid-cols-2 gap-lg stagger-children">
            {/* Left column: Risk Profile + Compliance Queue */}
            <div className="flex flex-col gap-lg">
            <Link href={`/risk-profile/${venueId}`} style={{ textDecoration: "none" }}>
            <div className="card highlight" style={{ cursor: "pointer" }}>
              <div className="flex justify-between items-start mb-md">
                <div>
                  <div className="text-xs uppercase tracking-wide text-secondary font-mono mb-xs">Risk Profile</div>
                  <div className="flex items-baseline gap-sm">
                    <span className="lc-num-data lc-num-data--lg lc-num-data--success glow-text">{riskScore.total_score}</span>
                    <span className="text-secondary font-mono">/ 100</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-sm">
                  <div className="font-mono font-bold px-3 py-1 text-lg"
                    style={{ border: `1px solid ${TIER_COLOR[riskScore.tier] ?? "var(--text-muted)"}`, color: TIER_COLOR[riskScore.tier] ?? "var(--text-muted)", borderRadius: "var(--radius-sm)" }}>
                    TIER {riskScore.tier}
                  </div>
                  <div className="flex items-center gap-xs">
                    <ShieldCheck size={14} className="text-accent" />
                    <span className="text-xs font-mono text-secondary">{quote.current_carrier ?? "Nightline"}</span>
                  </div>
                </div>
              </div>
              {/* One-line attention summary — the full factor breakdown lives
                  on the Risk Profile page this card links to, not here. */}
              {(() => {
                const attn = riskAttentionLine(riskScore.factors);
                return (
                  <div className="flex items-center gap-sm font-mono font-bold" style={{ color: FACTOR_TIER_COLOR[attn.tier] }}>
                    <span aria-hidden>{FACTOR_GLYPH[attn.tier]}</span>
                    <span className="text-sm">{attn.text}</span>
                  </div>
                );
              })()}
              <p className="text-xs text-secondary mt-md font-mono">→ View full risk analysis</p>
            </div>
            </Link>

            {/* Compliance Queue — bottom of left column */}
            <section>
              <div className="lc-rule" style={(liveState.compliance_queue?.length ?? 0) > 0 ? { borderColor: "rgba(255,60,60,0.3)" } : undefined}>
                <span className="lc-rule__label">Compliance Queue</span>
                {(liveState.compliance_queue?.length ?? 0) > 0 && (
                  <span className="badge badge-error">URGENT</span>
                )}
                <div className="lc-rule__line" style={(liveState.compliance_queue?.length ?? 0) > 0 ? { background: "linear-gradient(90deg, rgba(255,60,60,0.4), transparent)" } : undefined} />
              </div>
              <div className="flex flex-col gap-lg">
                {(liveState.compliance_queue?.length ?? 0) === 0 ? (
                  <TerminalEmpty
                    label="Compliance"
                    message="No pending actions. You're all clear."
                  />
                ) : (
                  liveState.compliance_queue?.map((item: any) => (
                    <div key={item.id} className="card bento-card" style={{ borderColor: "rgba(255,60,60,0.25)" }}>
                      <div className="flex justify-between items-start mb-md gap-sm">
                        <h4 className="text-sm font-bold uppercase font-mono text-accent">{item.title ?? item.id}</h4>
                        {item.severity && (
                          <span className="text-xs font-mono uppercase" style={{ color: "var(--state-error)", letterSpacing: "0.08em" }}>{item.severity}</span>
                        )}
                      </div>
                      <p className="text-sm mb-xl text-secondary">{item.description}</p>
                      {isOperator && (
                        <div className="relative">
                          <input
                            type="file"
                            accept="video/*,image/*,application/pdf"
                            onChange={(e) => handleUpload(item.id, e)}
                            className="visually-hidden"
                            id={`upload-${item.id}`}
                          />
                          <label htmlFor={`upload-${item.id}`} className="btn btn-secondary">
                            <Upload size={16} />
                            {uploadingId === item.id ? "Uploading..." : "Upload Evidence"}
                          </label>
                        </div>
                      )}
                      {uploadError && uploadingId !== item.id && (
                        <p className="text-sm text-error mt-sm">{uploadError}</p>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
            </div>

            {/* Right column: Premium + Coverage + Infrastructure */}
            <div className="flex flex-col gap-lg">
              <div className="card border-accent">
                <div className="text-xs uppercase tracking-wide text-secondary font-mono mb-md">Premium</div>
                <div className="flex items-baseline gap-sm mb-xs">
                  <span className="lc-numeral lc-numeral--indigo" style={{ fontSize: "clamp(2.4rem, 5vw, 3.6rem)" }}>
                    ${quote.annual_premium?.toLocaleString()}
                  </span>
                  <span className="text-secondary text-xs">/ Year</span>
                </div>
                <div className="flex items-baseline gap-xs mb-md">
                  <span className="text-xl font-mono text-secondary">${quote.monthly_premium?.toLocaleString()}</span>
                  <span className="text-xs text-muted uppercase tracking-wide">/ Month</span>
                </div>
                {quote.savings_annual > 0 && (
                  <div className="p-sm mb-md rounded" style={{ background: "rgba(200,240,0,0.06)", border: "1px solid rgba(200,240,0,0.2)" }}>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-secondary uppercase">Market Rate</span>
                      <span className="text-xs font-mono text-secondary line-through">${quote.market_rate_annual?.toLocaleString()}/yr</span>
                    </div>
                    <div className="flex justify-between items-center mt-xs">
                      <span className="text-xs text-accent font-bold">{isOperator ? "You Save" : "Client Saves"}</span>
                      <span className="text-sm text-accent font-bold">${quote.savings_annual?.toLocaleString()}/yr ({quote.savings_pct}%)</span>
                    </div>
                  </div>
                )}
                <div className="flex gap-lg border-t border-subtle pt-sm">
                  <div className="flex items-center gap-xs">
                    <TrendingUp size={12} className="text-accent" />
                    <span className="text-xs font-mono text-secondary">{quote.tier} Tier Rate</span>
                  </div>
                  <div className="flex items-center gap-xs">
                    <Calendar size={12} className="text-secondary" />
                    <span className="text-xs font-mono text-secondary">Renewal {quote.renewal_date || "—"}</span>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="text-xs uppercase tracking-wide text-secondary font-mono mb-md">Coverage</div>
                <div className="flex flex-col gap-sm">
                  {Object.entries(quote.coverage_breakdown ?? {}).map(([key, val]: [string, any]) => (
                    <div key={key} className="flex justify-between items-center py-xs border-b border-subtle">
                      <span className="text-sm capitalize">{key.replace(/_/g, " ")}</span>
                      <span className={`text-xs font-mono font-bold uppercase ${val.included ? "text-accent" : "text-secondary"}`}>
                        {val.included ? "Included" : val.optional ? "Optional" : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <section id="infrastructure" style={{ scrollMarginTop: 80 }}>
                <div className="lc-rule">
                  <span className="lc-rule__label">Infrastructure Sync</span>
                  <div className="lc-rule__line" />
                </div>
                {liveState.infrastructure?.some((i: any) => i.is_degraded) && (
                  <div className="mb-md p-sm text-xs font-mono" style={{ background: "rgba(255,153,0,0.08)", border: "1px solid rgba(255,153,0,0.3)", borderRadius: "var(--radius-sm)", color: "var(--state-warning)" }}>
                    <AlertTriangle size={12} style={{ display: "inline", marginRight: 4 }} />
                    Degraded systems weaken your claims defense. Upload footage or repair feeds before your next event.
                  </div>
                )}
                <div className="flex flex-col gap-sm stagger-children">
                  {(liveState.infrastructure?.length ?? 0) === 0 ? (
                    <TerminalEmpty
                      label="Infrastructure"
                      message="No systems reporting. Check device connectivity."
                    />
                  ) : (
                    liveState.infrastructure?.map((item: any, i: number) => (
                      <div
                        key={i}
                        className={`flex justify-between items-center p-md border rounded ${item.is_degraded ? "border-warning bg-warning-dim text-warning" : "border-subtle"}`}
                      >
                        <span className="font-mono text-sm">{item.name}</span>
                        <span className={`font-mono text-sm ${item.is_degraded ? "text-warning" : "text-accent"}`}>
                          {item.status} {item.detail}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : null}

      </div>
    </>
  );
}
