"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRole, useTenantId, useAuth } from "@/contexts/AuthContext";
import { Building2, AlertTriangle, CheckSquare, TrendingUp, LogOut, DollarSign } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface LiveState {
  current_capacity: number;
  max_capacity: number;
  infrastructure?: Array<{ name: string; status: string; is_degraded?: boolean }>;
  compliance_queue?: Array<any>;
  premium_impact?: number;
}

interface RiskScore {
  venue_id: string;
  total_score: number;
  tier: string;
  factors: Record<string, { score: number; weight: number }>;
  updated_at: string;
}

interface PremiumQuote {
  venue_id: string;
  venue_type: string;
  tier: string;
  base_rate: number;
  annual_premium: number;
  monthly_premium: number;
  billing_options: Record<string, { amount: number; description: string }>;
}

interface Stats {
  venues: number;
  incidents: number;
  compliance: number;
  premiumImpact: number;
}

export default function DashboardPage() {
  const router = useRouter();
  const { signOut, isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const [loading, setLoading] = useState(true);
  const [liveState, setLiveState] = useState<LiveState | null>(null);
  const [riskScore, setRiskScore] = useState<RiskScore | null>(null);
  const [quote, setQuote] = useState<PremiumQuote | null>(null);
  const [stats, setStats] = useState<Stats>({ venues: 0, incidents: 0, compliance: 0, premiumImpact: 0 });

  const isBroker = role === "broker" || role === "admin";

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    async function fetchDashboard() {
      if (!tenantId) {
        setLoading(false);
        return;
      }
      try {
        const [liveRes, riskRes, quoteRes, incidentsRes] = await Promise.all([
          fetch(`${API_URL}/api/venues/${tenantId}/live`),
          fetch(`${API_URL}/api/venues/${tenantId}/risk-score`),
          fetch(`${API_URL}/api/venues/${tenantId}/quote`),
          fetch(`${API_URL}/api/venues/${tenantId}/incidents`),
        ]);
        const incidentCount = incidentsRes.ok ? (await incidentsRes.json()).length : 0;
        if (liveRes.ok) {
          const state = await liveRes.json();
          setLiveState(state);
          setStats({
            venues: isBroker ? 12 : 1,
            incidents: incidentCount,
            compliance: state.compliance_queue?.length || 0,
            premiumImpact: state.premium_impact || 0,
          });
        }
        if (riskRes.ok) setRiskScore(await riskRes.json());
        if (quoteRes.ok) setQuote(await quoteRes.json());
      } catch (error) {
        console.error("Failed to fetch dashboard:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchDashboard();
  }, [tenantId, isBroker]);

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  const getTierColor = (tier: string) => {
    const colors: Record<string, string> = { A: "var(--brand-primary)", B: "var(--brand-secondary)", C: "var(--state-warning)", D: "var(--brand-tertiary)" };
    return colors[tier] || "var(--text-secondary)";
  };

  if (!isSignedIn || loading) {
    return <div className="theme-venue min-h-screen page-loading"><div className="loading-spinner" /></div>;
  }

  if (!tenantId) {
    return (
      <div className="theme-venue min-h-screen p-xl">
        <div className="flex flex-col items-center justify-center" style={{ minHeight: "60vh" }}>
          <Building2 size={48} className="text-muted mb-lg" />
          <h2 className="text-xl mb-sm glow-text">No Venue Assigned</h2>
          <p className="text-muted mb-lg">Contact your administrator to get venue access</p>
          <button onClick={handleSignOut} className="btn btn-secondary"><LogOut size={18} /> Sign Out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="theme-venue min-h-screen p-xl">
      <header className="page-header border-b border-subtle mb-xl pb-lg flex justify-between items-start">
        <div>
          <h1 className="text-4xl font-bold glow-text mb-xs">VENUE <span className="text-accent">OS</span></h1>
          <p className="text-secondary mt-sm">
            {isBroker ? "Overview of all venues and risk metrics" : "Live Operational Health"}
          </p>
        </div>
        <button onClick={handleSignOut} className="btn btn-ghost"><LogOut size={18} /> Sign Out</button>
      </header>

      <div className="bento-grid mb-xl">
        <div className="card bento-card">
           <div className="flex gap-md items-center">
             <div className="stat-icon" style={{ background: 'rgba(212, 255, 0, 0.1)', color: 'var(--brand-primary)' }}>
               <Building2 size={24} />
             </div>
             <div className="flex flex-col gap-xs">
               <span className="text-xs uppercase tracking-wide text-muted">{isBroker ? "Total Venues" : "Your Venue"}</span>
               <span className="text-2xl font-bold">{stats.venues}</span>
             </div>
           </div>
        </div>
        <div className="card bento-card">
           <div className="flex gap-md items-center">
             <div className="stat-icon" style={{ background: 'rgba(255, 0, 85, 0.1)', color: 'var(--brand-tertiary)' }}>
               <AlertTriangle size={24} />
             </div>
             <div className="flex flex-col gap-xs">
               <span className="text-xs uppercase tracking-wide text-muted">Active Incidents</span>
               <span className="text-2xl font-bold text-error">{stats.incidents}</span>
               <span className="text-xs text-muted">This month</span>
             </div>
           </div>
        </div>
        <div className="card bento-card">
           <div className="flex gap-md items-center">
             <div className="stat-icon" style={{ background: 'rgba(0, 240, 255, 0.1)', color: 'var(--brand-secondary)' }}>
               <CheckSquare size={24} />
             </div>
             <div className="flex flex-col gap-xs">
               <span className="text-xs uppercase tracking-wide text-muted">Compliance Actions</span>
               <span className="text-2xl font-bold text-info">{stats.compliance}</span>
               <span className="text-xs text-muted">Pending</span>
             </div>
           </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-lg mb-xl">
        {riskScore && quote && (
          <div className="flex flex-col gap-lg">
            <div className="card highlight">
              <h2 className="text-xl mb-sm font-display uppercase">Risk Profile</h2>
              <div className="flex justify-between items-center mb-md pb-md border-b border-subtle">
                <div className="text-xl font-bold font-mono px-3 py-1 rounded" style={{ border: `1px solid ${getTierColor(riskScore.tier)}`, color: getTierColor(riskScore.tier) }}>
                  TIER {riskScore.tier}
                </div>
                <div className="flex items-baseline gap-sm glow-text">
                  <span className="text-5xl font-bold text-primary">{riskScore.total_score}</span>
                  <span className="text-secondary font-mono">/ 100</span>
                </div>
              </div>
              <div className="flex flex-col gap-md">
                {Object.entries(riskScore.factors).map(([key, data]) => (
                  <div key={key} className="flex items-center gap-md">
                    <span className="text-xs uppercase tracking-wide" style={{ width: "160px" }}>{key.replace("_", " ")}</span>
                    <div className="flex-1 capacity-bar bg-dark">
                      <div className="capacity-fill" style={{ width: `${data.score}%`, background: getTierColor(key === "incident_history" ? quote.tier : "B") }} />
                    </div>
                    <span className="text-sm font-mono text-secondary" style={{ width: "40px", textAlign: "right" }}>{data.score}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card border-accent">
              <h2 className="text-xl mb-sm font-display uppercase text-accent">Premium Quote</h2>
              <div className="flex justify-between items-center mb-md">
                <span className="text-md uppercase tracking-wide text-secondary">{quote.venue_type.replace("_", " ")}</span>
                <span className="text-sm font-bold font-mono px-2 py-1 bg-surface-elevated rounded" style={{ color: getTierColor(quote.tier) }}>{quote.tier} TIER</span>
              </div>
              <div className="flex flex-col gap-md border-t border-subtle pt-md">
                <div className="flex items-baseline gap-sm">
                  <DollarSign size={28} className="text-accent" />
                  <span className="text-4xl font-bold text-primary glow-text">{quote.annual_premium.toLocaleString()}</span>
                  <span className="text-secondary font-mono uppercase text-xs">/ Year</span>
                </div>
                <div className="flex items-baseline gap-xs">
                  <span className="text-xl font-semibold text-secondary font-mono">${quote.monthly_premium.toLocaleString()}</span>
                  <span className="text-xs text-muted uppercase tracking-wide">/ Month</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {liveState && (
          <div className="card flex flex-col h-full">
            <h2 className="text-xl mb-md font-display uppercase">Live Status</h2>
            <div className="flex flex-col gap-xl flex-1">
              <div className="p-md rounded-lg bg-base border border-subtle">
                <div className="flex justify-between mb-sm">
                  <span className="text-xs uppercase tracking-wide text-muted">Current Capacity</span>
                  <span className="text-xl font-mono text-primary glow-text">{liveState.current_capacity} <span className="text-secondary text-sm">/ {liveState.max_capacity}</span></span>
                </div>
                <div className="capacity-bar bg-dark h-[12px] rounded-full">
                  <div className="capacity-fill rounded-full" style={{ width: `${(liveState.current_capacity / liveState.max_capacity) * 100}%`, background: 'var(--gradient-primary)' }} />
                </div>
              </div>
              
              <div>
                <span className="text-xs uppercase tracking-wide text-muted block mb-md">Active Infrastructure</span>
                <div className="grid grid-cols-2 gap-sm">
                  {liveState.infrastructure?.map((item, i) => (
                    <div key={i} className={`p-sm rounded border ${item.is_degraded ? "border-warning bg-[rgba(255,153,0,0.05)] text-warning" : "border-success bg-[rgba(212,255,0,0.05)] text-success"} flex items-center justify-between`}>
                      <span className="text-sm font-semibold uppercase tracking-wide">{item.name}</span>
                      <div className={`w-[8px] h-[8px] rounded-full ${item.is_degraded ? "bg-warning" : "bg-success"}`} style={{ boxShadow: item.is_degraded ? '0 0 8px var(--state-warning)' : '0 0 8px var(--state-success)' }}></div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
