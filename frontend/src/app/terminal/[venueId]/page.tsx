"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { Upload, AlertTriangle, ShieldCheck, DollarSign, TrendingUp, Calendar, Zap } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const TIER_COLOR: Record<string, string> = {
  A: "var(--brand-primary)",
  B: "var(--brand-secondary)",
  C: "var(--state-warning)",
  D: "var(--brand-tertiary)",
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
        background: "linear-gradient(90deg, var(--bg-surface, #111) 25%, var(--bg-elevated, #1a1a1a) 50%, var(--bg-surface, #111) 75%)",
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
      <div className="text-xs" style={{ color: "var(--brand-primary)", opacity: 0.7 }}>
        &gt; {label}
      </div>
      <div className="text-xs">{message}</div>
      <div className="text-xs" style={{ color: "var(--brand-primary)", animation: "cursor-blink 1.2s step-end infinite" }}>█</div>
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
    try {
      await fetch(`${API_URL}/api/venues/${venueId}/events/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{
          event_id: `CAM-${Date.now()}`,
          event_type: "camera_metadata",
          timestamp: new Date().toISOString(),
          payload: { camera_id: "camera-rear-bar", anomaly_score: 0.85, clip_duration: 90 },
        }]),
      });
      const res = await fetch(`${API_URL}/api/venues/${venueId}/live`);
      if (res.ok) setLiveState(await res.json());
    } finally {
      setSimulatingAlert(false);
    }
  };

  // Fetch venue info, risk score, and quote once on mount
  useEffect(() => {
    setInsightLoading(true);
    Promise.all([
      fetch(`${API_URL}/api/venues/${venueId}`),
      fetch(`${API_URL}/api/venues/${venueId}/risk-score`),
      fetch(`${API_URL}/api/venues/${venueId}/quote`),
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
        const res = await fetch(`${API_URL}/api/venues/${venueId}/live`);
        if (res.ok) setLiveState(await res.json());
      } catch {
        // fallback stays
      }
    };
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [venueId]);

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

      <div className="theme-venue min-h-screen p-xl">

        {/* Savings hero — operators only */}
        {isOperator && insightLoading ? (
          <div className="flex items-center gap-lg mb-xl p-lg" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)" }}>
            <div className="flex flex-col gap-sm flex-1">
              <SkeletonBlock width="180px" height="0.75rem" />
              <SkeletonBlock width="260px" height="2.5rem" />
              <SkeletonBlock width="340px" height="0.75rem" />
            </div>
          </div>
        ) : isOperator && quote && quote.savings_annual > 0 ? (
          <div className="flex items-center gap-lg mb-xl p-lg" style={{ background: "rgba(212,255,0,0.05)", border: "1px solid rgba(212,255,0,0.2)", borderRadius: "var(--radius-lg)" }}>
            <div>
              <div className="text-xs uppercase tracking-wide text-secondary mb-xs">Third Space saves you</div>
              <div className="text-4xl font-bold glow-text">${quote.savings_annual.toLocaleString()}<span className="text-xl text-secondary font-normal">/yr</span></div>
              <div className="text-xs font-mono text-secondary mt-xs">vs. market rate of ${quote.market_rate_annual.toLocaleString()} — {quote.savings_pct}% discount through evidence-first underwriting</div>
            </div>
          </div>
        ) : null}

        <header className="page-header mb-xl">
          <div>
            <div className="text-xs text-secondary uppercase tracking-wide mb-xs">
              Live Terminal
            </div>
            <h1 className="glow-text">{displayName}</h1>
          </div>
          <div className="flex items-center gap-md">
{process.env.NODE_ENV === "development" && (
              <button
                onClick={simulateAlert}
                disabled={simulatingAlert}
                className="btn btn-secondary btn-sm flex items-center gap-xs"
                title="Dev only: inject a camera anomaly event"
              >
                <Zap size={14} style={{ color: "var(--state-warning)" }} />
                {simulatingAlert ? "Injecting..." : "Simulate Alert"}
              </button>
            )}
            <div className="card p-md text-center" style={{ minWidth: "120px" }}>
              <div className="text-xs uppercase tracking-wide text-secondary mb-xs">Coverage</div>
              <div className="text-xl font-bold text-accent font-mono flex items-center justify-center gap-xs live-pulse">
                <span className="live-dot" />
                LIVE
              </div>
              <div className="text-xs text-secondary font-mono">{quote?.renewal_date ?? "—"}</div>
            </div>
          </div>
        </header>

        {/* Capacity Bar */}
        <div className="card mb-xl">
          <div className="flex justify-between items-center mb-sm">
            <span className="text-xs uppercase tracking-wide text-secondary font-mono">
              Live Occupancy
            </span>
            <span className="text-2xl font-bold font-mono" style={{ color: capacityColor }}>
              {liveState.current_capacity}
              <span className="text-lg font-normal text-secondary"> / {liveState.max_capacity}</span>
            </span>
          </div>
          <div className="capacity-bar">
            <div className="capacity-fill" style={{ width: `${capacityPercent}%`, background: capacityColor }} />
          </div>
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
                    <span className="text-5xl font-bold glow-text">{riskScore.total_score}</span>
                    <span className="text-secondary font-mono">/ 100</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-sm">
                  <div className="font-mono font-bold px-3 py-1 text-lg"
                    style={{ border: `1px solid ${TIER_COLOR[riskScore.tier] ?? "var(--brand-primary)"}`, color: TIER_COLOR[riskScore.tier] ?? "var(--brand-primary)", borderRadius: "var(--radius-sm)" }}>
                    TIER {riskScore.tier}
                  </div>
                  <div className="flex items-center gap-xs">
                    <ShieldCheck size={14} className="text-accent" />
                    <span className="text-xs font-mono text-secondary">{quote.current_carrier ?? "Third Space"}</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-sm">
                {Object.entries(riskScore.factors as Record<string, { score: number }>).map(([key, data]) => (
                  <div key={key} className="flex items-center gap-md">
                    <span className="text-xs uppercase tracking-wide text-secondary" style={{ width: "140px" }}>{key.replace(/_/g, " ")}</span>
                    <div className="flex-1 capacity-bar bg-dark">
                      <div className="capacity-fill" style={{ width: `${data.score}%`, background: TIER_COLOR[riskScore.tier] ?? "var(--brand-primary)" }} />
                    </div>
                    <span className="text-xs font-mono text-secondary" style={{ width: "32px", textAlign: "right" }}>{data.score}</span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-secondary mt-md font-mono">→ View full risk analysis</p>
            </div>
            </Link>

            {/* Compliance Queue — bottom of left column */}
            <section>
              <div className="flex justify-between items-center border-b border-subtle pb-md mb-md" style={{ borderColor: (liveState.compliance_queue?.length ?? 0) > 0 ? "rgba(255,60,60,0.3)" : undefined }}>
                <h3 className="text-lg font-semibold uppercase font-display">Compliance Queue</h3>
                {(liveState.compliance_queue?.length ?? 0) > 0 && (
                  <span className="badge badge-error">URGENT</span>
                )}
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
                      <h4 className="text-sm font-bold uppercase mb-md font-mono text-accent">{item.id}</h4>
                      <p className="text-sm mb-xl text-secondary">{item.description}</p>
                      {isOperator && (
                        <div className="relative">
                          <input
                            type="file"
                            accept="video/*,image/*"
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
                  <DollarSign size={22} className="text-accent" />
                  <span className="text-4xl font-bold text-primary glow-text">{quote.annual_premium?.toLocaleString()}</span>
                  <span className="text-secondary text-xs">/ Year</span>
                </div>
                <div className="flex items-baseline gap-xs mb-md">
                  <span className="text-xl font-mono text-secondary">${quote.monthly_premium?.toLocaleString()}</span>
                  <span className="text-xs text-muted uppercase tracking-wide">/ Month</span>
                </div>
                {quote.savings_annual > 0 && (
                  <div className="p-sm mb-md rounded" style={{ background: "rgba(212,255,0,0.06)", border: "1px solid rgba(212,255,0,0.2)" }}>
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

              <section>
                <div className="border-b border-subtle pb-md mb-lg">
                  <h3 className="text-lg font-semibold uppercase font-display">Infrastructure Sync</h3>
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
