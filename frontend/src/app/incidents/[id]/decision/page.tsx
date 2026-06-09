"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Rec {
  should_file: boolean;
  net_expected_value_usd: number;
  confidence: number;
  reasons: string[];
  carrier_payout: number;
  deductible: number | null;
  pay_out_of_pocket_cost: number;
  has_active_policy: boolean;
  expected_premium_impact: { annual_delta_usd: number; duration_years: number; cumulative_usd: number };
}

export default function DecisionPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [summary, setSummary] = useState<string>("");
  const [venueId, setVenueId] = useState<string | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [packetId, setPacketId] = useState<string | null>(null);
  const [routingStatus, setRoutingStatus] = useState<string | undefined>(undefined);
  const [riskScore, setRiskScore] = useState<{ total_score: number; tier: string } | null>(null);
  // Has this packet already been routed (proposal created, auto or manual)? If so
  // the "Send to broker" button must not show — a second send would create a
  // duplicate proposal (the manual create path has no idempotency guard).
  const [proposalSent, setProposalSent] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/"); }, [isLoaded, isSignedIn, router]);
  useEffect(() => { if (isLoaded && isSignedIn && !isOperator) router.replace(`/incidents/${id}`); }, [isLoaded, isSignedIn, isOperator, id, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isOperator) return;
    let cancelled = false;
    (async () => {
      const incRes = await fetch(`${API_URL}/api/incidents/${id}`, { headers: authHeaders() });
      const inc = incRes.ok ? await incRes.json() : null;
      const pkRes = await fetch(`${API_URL}/api/incidents/${id}/packets`, { headers: authHeaders() });
      const pkts = pkRes.ok ? await pkRes.json() : [];
      const primary = Array.isArray(pkts) ? pkts[0] : undefined;
      // Already routed? (auto-router or a prior manual send.) Drives whether the
      // send button or a "sent" badge shows.
      const csRes = await fetch(`${API_URL}/api/incidents/${id}/claim-status`, { headers: authHeaders() });
      const cs = csRes.ok ? await csRes.json() : null;
      let rs = null;
      if (inc?.venue_id) {
        const rsRes = await fetch(`${API_URL}/api/venues/${inc.venue_id}/risk-score`, { headers: authHeaders() });
        if (rsRes.ok) rs = await rsRes.json();
      }
      if (cancelled) return;
      setSummary(inc?.summary ?? "");
      setVenueId(inc?.venue_id ?? null);
      setRec(primary?.claim_recommendation ?? null);
      setPacketId(primary?.id ?? null);
      setRoutingStatus(primary?.routing_status);
      setProposalSent(!!cs?.proposal?.exists || !!cs?.claim?.exists);
      setRiskScore(rs);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isLoaded, isSignedIn, isOperator]);

  const sendToBroker = async () => {
    if (!packetId) return;
    const res = await fetch(`${API_URL}/api/packets/${packetId}/claim-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ operator_id: "operator", override_recommendation: false }),
    });
    if (res.ok) location.reload();
  };

  if (!isLoaded || loading || !isOperator) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="theme-venue min-h-screen p-xl">
      <div style={{ maxWidth: 880 }}>
      <header className="mb-xl">
        <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Operator · Decision</div>
        <h1 className="glow-text mb-md">File or pay out of pocket?</h1>
        {summary && <p className="text-secondary" style={{ lineHeight: 1.6, margin: 0 }}>{summary}</p>}
      </header>

      {!rec ? (
        <div className="card"><p className="text-sm text-muted" style={{ margin: 0 }}>No recommendation available for this incident yet.</p></div>
      ) : (
        <>
        <div className="card">
          <div className="mb-md">
            {!rec.has_active_policy
              ? <span className="badge badge-warning">No active policy</span>
              : rec.should_file
                ? <span className="badge badge-success">Recommended: File</span>
                : <span className="badge badge-warning">Recommended: pay out of pocket</span>}
          </div>

          {/* Operator: two-path file-vs-pay-out-of-pocket decision explainer */}
          {isOperator && (() => {
            if (!rec.has_active_policy) {
              // No active policy — only show pay-out-of-pocket panel + note
              return (
                <div className="mb-md">
                  <div style={{
                    flex: 1, minWidth: 220, padding: "var(--space-md)",
                    border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)",
                  }}>
                    <div className="text-muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-xs)" }}>Pay out of pocket</div>
                    <div className="font-mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                      Absorb ~${(rec.pay_out_of_pocket_cost || 0).toLocaleString()}
                    </div>
                    <div className="text-muted" style={{ fontSize: "0.78rem", marginTop: "var(--space-xs)" }}>
                      no premium hike · no loss-run mark
                    </div>
                  </div>
                  <p className="text-muted" style={{ fontSize: "0.82rem", marginTop: "var(--space-sm)" }}>
                    No active policy on file — talk to your broker about coverage.
                  </p>
                </div>
              );
            }
            // Has policy — show both panels
            const fileIsRecommended = rec.should_file;
            const cumulative = rec.expected_premium_impact?.cumulative_usd ?? 0;
            const deductible = rec.deductible ?? 0;
            const carrierPayout = rec.carrier_payout ?? 0;
            const netEv = rec.net_expected_value_usd ?? 0;
            const popCost = rec.pay_out_of_pocket_cost ?? 0;
            const filePanel = (
              <div style={{
                flex: 1, minWidth: 220, padding: "var(--space-md)",
                border: fileIsRecommended ? "1px solid var(--accent-ink)" : "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                background: fileIsRecommended ? "rgba(200,240,0,0.05)" : undefined,
              }}>
                {fileIsRecommended && (
                  <div style={{ fontSize: "0.7rem", color: "var(--accent-ink)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "var(--space-xs)" }}>
                    Recommended
                  </div>
                )}
                <div className="text-muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-xs)" }}>File the claim</div>
                <div className="font-mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  Carrier covers ~${carrierPayout.toLocaleString()}
                </div>
                <div className="text-muted" style={{ fontSize: "0.78rem", marginTop: "var(--space-xs)" }}>
                  your cost: ${deductible.toLocaleString()} deductible + ${cumulative.toLocaleString()} / {rec.expected_premium_impact?.duration_years ?? 3} yrs
                </div>
                <div className="font-mono" style={{ fontSize: "0.92rem", fontWeight: 600, marginTop: "var(--space-xs)" }}>
                  net {netEv >= 0 ? "+" : "−"}${Math.abs(netEv).toLocaleString()}
                </div>
              </div>
            );
            const popPanel = (
              <div style={{
                flex: 1, minWidth: 220, padding: "var(--space-md)",
                border: !fileIsRecommended ? "1px solid var(--accent-ink)" : "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-sm)",
                background: !fileIsRecommended ? "rgba(200,240,0,0.05)" : undefined,
              }}>
                {!fileIsRecommended && (
                  <div style={{ fontSize: "0.7rem", color: "var(--accent-ink)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "var(--space-xs)" }}>
                    Recommended
                  </div>
                )}
                <div className="text-muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: "var(--space-xs)" }}>Pay out of pocket</div>
                <div className="font-mono" style={{ fontSize: "1.05rem", fontWeight: 600 }}>
                  Absorb ~${popCost.toLocaleString()}
                </div>
                <div className="text-muted" style={{ fontSize: "0.78rem", marginTop: "var(--space-xs)" }}>
                  no premium hike · no loss-run mark
                </div>
              </div>
            );
            return (
              <div className="flex gap-md mb-md" style={{ flexWrap: "wrap" }}>
                {filePanel}
                {popPanel}
              </div>
            );
          })()}

          {rec.reasons.length > 0 && (
            <ul style={{ margin: "0 0 var(--space-md) var(--space-md)", padding: 0, fontSize: "0.82rem" }}>
              {rec.reasons.map((r, i) => <li key={i} className="text-muted" style={{ marginBottom: "var(--space-xs)" }}>{r}</li>)}
            </ul>
          )}

          {riskScore && (
            <div className="text-muted mb-md" style={{ fontSize: "0.82rem" }}>
              Venue risk <span className="font-mono">{riskScore.total_score}/100</span>
              {" · "}tier <span className="font-mono" style={{ color: `var(--tier-${riskScore.tier.toLowerCase()})`, fontWeight: 700 }}>{riskScore.tier}</span>
              {venueId && <>{" · "}<Link href={`/incidents?venue=${venueId}`}>recent incidents</Link></>}
            </div>
          )}

          {proposalSent ? (
            <span className="badge badge-info">Sent to broker · awaiting their decision</span>
          ) : !rec.has_active_policy ? (
            // No policy → nothing to file against a carrier; it's a coverage
            // conversation, not a claim. Don't offer "Send to broker".
            <span className="text-muted">No active policy — talk to your broker about coverage.</span>
          ) : routingStatus === "borderline" ? (
            <button className="btn btn-primary" onClick={sendToBroker} aria-label="Send this incident to the broker for review" style={{ minHeight: 44 }}>Send to broker</button>
          ) : routingStatus === "auto_routed" ? (
            <span className="badge badge-info">Sent to broker for review</span>
          ) : routingStatus === "not_routed" ? (
            <span className="text-muted">Logged — below the filing threshold.</span>
          ) : null}
        </div>

        {/* Smooth flow: from "should I file / why" → "where does the claim stand". */}
        <Link href={`/incidents/${id}/claim-status`} className="wq-row" aria-label="Track this claim's status" style={{ textDecoration: "none", marginTop: "var(--space-lg)" }}>
          <span style={{ flex: 1 }} className="text-sm">Track this claim — where it stands now</span>
          <span className="text-xs text-muted">Claim status →</span>
        </Link>
        </>
      )}
      </div>
    </div>
  );
}
