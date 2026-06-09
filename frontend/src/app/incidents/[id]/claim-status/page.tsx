"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Circle, AlertTriangle, Clock, Send, ShieldCheck } from "lucide-react";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { CLAIM_STATUS_LABEL, isClosedStatus, formatLedgerMoney, type ClaimStatus } from "@/lib/claim-tokens";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ClaimStatusResponse {
  incident_status: string;
  proposal: { exists: boolean; state: string | null };
  claim: { exists: boolean; status: string | null };
}
interface IncidentClaim {
  id: string; incident_id: string | null; carrier_claim_number: string | null;
  coverage_line: string; status: string; current_reserve: string;
}
// The filing recommendation — the "details" an operator wants at the
// pre-claim (awaiting-broker) stage, before a carrier Claim row exists.
interface Rec {
  should_file: boolean;
  net_expected_value_usd: number;
  confidence: number;
  reasons: string[];
  deductible: number | null;
  pay_out_of_pocket_cost: number;
  has_active_policy: boolean;
}

type Tone = "info" | "success" | "warning" | "error" | "neutral";

/** Plain-language status the operator actually wants: where it stands now + who owns
 * the next move. Honours ADR-0004 — a routed ClaimProposal is NOT a Claim, so we say
 * "recommendation" until a carrier Claim row exists. */
function deriveStatus(cs: ClaimStatusResponse, claim: IncidentClaim | null): {
  tone: Tone; headline: string; detail: string; next: string; currentIndex: number;
} {
  const ps = cs.proposal.state;
  const claimStatus = claim?.status ?? cs.claim.status ?? null;

  // Terminal claim outcomes first.
  if (ps === "paid" || claimStatus === "closed_paid") {
    return { tone: "success", headline: "Claim paid", detail: "The carrier settled this claim. Nothing more is needed from you.", next: "Resolved — no action required.", currentIndex: 4 };
  }
  if (ps === "denied" || claimStatus === "closed_denied") {
    return { tone: "error", headline: "Claim denied by carrier", detail: "The carrier declined this claim. Your broker can advise on options.", next: "Talk to your broker if you want to dispute or appeal.", currentIndex: 4 };
  }
  if (claimStatus === "closed_dropped") {
    return { tone: "neutral", headline: "Claim withdrawn", detail: "This claim was dropped before settlement.", next: "Resolved — no action required.", currentIndex: 4 };
  }
  // Broker declined the recommendation outright — never became a claim.
  if (ps === "rejected_by_broker") {
    return { tone: "error", headline: "Declined by your broker", detail: "Your broker reviewed the recommendation and decided not to file. It never became a carrier claim.", next: "Review the recommendation, or talk to your broker about next steps.", currentIndex: 1 };
  }
  // Filed with the carrier — a real Claim now exists.
  if (ps === "filed_with_carrier" || cs.claim.exists) {
    return { tone: "info", headline: "Filed with the carrier", detail: "Your broker filed this as a carrier claim. It's now in the carrier's hands.", next: "Awaiting the carrier's decision — we'll update this when it settles.", currentIndex: 3 };
  }
  // Approved by broker, claim being opened.
  if (ps === "approved") {
    return { tone: "success", headline: "Approved — filing with the carrier", detail: "Your broker approved the recommendation. The carrier claim is being opened now.", next: "Your broker has the next move. No action needed from you.", currentIndex: 2 };
  }
  // Broker bounced it back for more evidence.
  if (ps === "needs_more_info") {
    return { tone: "warning", headline: "Your broker needs more information", detail: "Before filing, your broker asked for additional evidence on this incident.", next: "You have the next move — add the requested evidence on the incident.", currentIndex: 1 };
  }
  // Default: routed, sitting in the broker's queue.
  if (cs.proposal.exists) {
    return { tone: "info", headline: "Awaiting your broker's decision", detail: "We sent the recommendation to your broker. They'll approve it as a claim, ask for more info, or decline.", next: "Your broker has the next move. We'll update this when they respond.", currentIndex: 1 };
  }
  // No proposal yet (shouldn't reach here — pre-claim empty state handles it).
  return { tone: "neutral", headline: "Not sent to your broker yet", detail: "This is still a recommendation.", next: "Review the recommendation to decide whether to file.", currentIndex: 0 };
}

const TONE_COLOR: Record<Tone, string> = {
  info: "var(--accent-ink)",
  success: "var(--accent-ink)",
  warning: "var(--state-warning)",
  error: "var(--state-error)",
  neutral: "var(--text-secondary)",
};

export default function ClaimStatusPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [summary, setSummary] = useState("");
  const [cs, setCs] = useState<ClaimStatusResponse | null>(null);
  const [claim, setClaim] = useState<IncidentClaim | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/"); }, [isLoaded, isSignedIn, router]);
  useEffect(() => { if (isLoaded && isSignedIn && !isOperator) router.replace(`/incidents/${id}`); }, [isLoaded, isSignedIn, isOperator, id, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isOperator) return;
    let cancelled = false;
    (async () => {
      const incRes = await fetch(`${API_URL}/api/incidents/${id}`, { headers: authHeaders() });
      const inc = incRes.ok ? await incRes.json() : null;
      const csRes = await fetch(`${API_URL}/api/incidents/${id}/claim-status`, { headers: authHeaders() });
      const csData = csRes.ok ? await csRes.json() : null;
      // Primary packet carries the filing recommendation — the pre-claim "details".
      const pkRes = await fetch(`${API_URL}/api/incidents/${id}/packets`, { headers: authHeaders() });
      const pkts = pkRes.ok ? await pkRes.json() : [];
      const primary = Array.isArray(pkts) ? pkts[0] : undefined;
      let matched: IncidentClaim | null = null;
      if (inc?.venue_id) {
        const clRes = await fetch(`${API_URL}/api/venues/${inc.venue_id}/claims`, { headers: authHeaders() });
        if (clRes.ok) {
          const rows: IncidentClaim[] = await clRes.json();
          matched = rows.find((c) => c.incident_id === id) ?? null;
        }
      }
      if (cancelled) return;
      setSummary(inc?.summary ?? "");
      setCs(csData);
      setClaim(matched);
      setRec(primary?.claim_recommendation ?? null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isLoaded, isSignedIn, isOperator]);

  if (!isLoaded || loading || !isOperator) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const hasProposal = !!cs?.proposal.exists;
  const stepLabels = ["Reported", "Sent to broker", "Approved", "Filed", "Resolved"];

  return (
    <div className="theme-venue min-h-screen p-xl">
      <div style={{ maxWidth: 760 }}>
        <header className="mb-xl">
          <div className="text-xs uppercase tracking-wide text-secondary mb-sm">
            {claim ? "Operator · Claim" : "Operator · Claim status"}
          </div>
          <h1 className="glow-text mb-md">
            {claim
              ? (claim.carrier_claim_number ? `Claim ${claim.carrier_claim_number}` : "Your claim")
              : "Where this stands"}
          </h1>
          {summary && <p className="text-secondary" style={{ lineHeight: 1.6, margin: 0 }}>{summary}</p>}
        </header>

        {!hasProposal && !claim ? (
          <div className="card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="flex items-center gap-xs text-sm" style={{ fontWeight: 600 }}>
              <Send size={15} className="text-muted" aria-hidden="true" /> Not sent to your broker yet
            </div>
            <p className="text-sm text-secondary" style={{ margin: 0, lineHeight: 1.6 }}>
              This incident is still a recommendation — nothing has been filed. Review it to decide whether to send it to your broker.
            </p>
            <Link href={`/incidents/${id}/decision`} className="text-sm" style={{ color: "var(--accent-ink)", textDecoration: "none", fontWeight: 600 }}>View the recommendation →</Link>
          </div>
        ) : (() => {
          const s = deriveStatus(cs!, claim);
          const reserve = claim ? Number(claim.current_reserve) : 0;
          const Icon = s.tone === "error" ? AlertTriangle : s.tone === "warning" ? Clock : s.currentIndex >= 3 ? ShieldCheck : Send;

          // Stepper chips — shared between the status-first (pre-claim) and the
          // details-first (claim exists) layouts. Current step is ringed ("you
          // are here"), done steps are checked.
          const stepper = (
            <div role="list" aria-label="Claim progress" className="flex gap-sm" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {stepLabels.map((label, i) => {
                const done = i < s.currentIndex;
                const current = i === s.currentIndex;
                return (
                  <div key={label} role="listitem" aria-current={current ? "step" : undefined}
                    className="flex items-center gap-xs"
                    style={{
                      padding: "5px 11px", borderRadius: "var(--radius-sm)",
                      background: current ? "rgba(200,240,0,0.08)" : "var(--bg-elevated)",
                      border: current ? `1px solid ${TONE_COLOR[s.tone]}` : "1px solid transparent",
                    }}>
                    {done
                      ? <CheckCircle2 size={14} style={{ color: "var(--accent-ink)", flexShrink: 0 }} aria-hidden="true" />
                      : current
                        ? <span style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${TONE_COLOR[s.tone]}`, flexShrink: 0, display: "inline-block" }} aria-hidden="true" />
                        : <Circle size={14} className="text-muted" style={{ flexShrink: 0 }} aria-hidden="true" />}
                    <span className="text-xs" style={{ color: done || current ? "var(--accent-ink)" : undefined, fontWeight: current ? 700 : 400 }}>{label}</span>
                    {current && <span className="text-xs" style={{ color: TONE_COLOR[s.tone], fontWeight: 600 }}>· now</span>}
                  </div>
                );
              })}
            </div>
          );

          // Smooth flow: from the claim/status back to "what was recommended and why".
          const recommendedLink = (
            <Link href={`/incidents/${id}/decision`} className="wq-row" aria-label="See what was recommended and why" style={{ textDecoration: "none" }}>
              <span style={{ flex: 1 }} className="text-sm">See what was recommended and why</span>
              <span className="text-xs text-muted">View decision →</span>
            </Link>
          );

          // ── Details-first: a real carrier Claim exists. The operator already
          //    sees the status chain on their dashboard, so lead with the claim
          //    *facts* (coverage, reserve, status, outcome) and demote the stepper
          //    to a thin "progress" strip below.
          if (claim) {
            const statusText = CLAIM_STATUS_LABEL[claim.status as ClaimStatus] ?? claim.status.replace(/_/g, " ");
            const closed = isClosedStatus(claim.status as ClaimStatus);
            return (
              <>
                <div className="card mb-md" style={{ borderLeft: `3px solid ${TONE_COLOR[s.tone]}` }}>
                  <div className="flex items-center gap-sm mb-sm">
                    <Icon size={18} style={{ color: TONE_COLOR[s.tone], flexShrink: 0 }} aria-hidden="true" />
                    <span style={{ fontWeight: 700, fontSize: "1.05rem", color: TONE_COLOR[s.tone] }}>{s.headline}</span>
                  </div>
                  <p className="text-sm text-secondary" style={{ margin: "0 0 var(--space-md) 0", lineHeight: 1.6 }}>{s.detail}</p>

                  {/* Claim facts — the substance the operator wants on a real claim. */}
                  <div className="claim-status-facts">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Coverage</div>
                      <div className="text-sm" style={{ marginTop: 2 }}>{claim.coverage_line.replace(/_/g, " ").toUpperCase()}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Reserved</div>
                      <div className="text-sm font-mono" style={{ marginTop: 2 }}>{reserve > 0 ? formatLedgerMoney(claim.current_reserve) : "—"}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Status</div>
                      <div className="text-sm" style={{ marginTop: 2 }}>{statusText}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Outcome</div>
                      <div className="text-sm" style={{ marginTop: 2 }}>{closed ? statusText : "In progress"}</div>
                    </div>
                  </div>

                  <div style={{ marginTop: "var(--space-md)", borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-sm)" }}>
                    <div className="text-xs uppercase tracking-wide text-muted" style={{ marginBottom: 2 }}>What happens next</div>
                    <p className="text-sm" style={{ margin: 0, lineHeight: 1.6 }}>{s.next}</p>
                  </div>
                </div>

                {/* Demoted progress strip — the stepper the dashboard already shows. */}
                <div className="card mb-md">
                  <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Progress</div>
                  {stepper}
                </div>

                {recommendedLink}
              </>
            );
          }

          // ── Status-first: a routed recommendation with no claim yet. Here status
          //    IS the point, so keep the banner + stepper as the hero.
          return (
            <>
              {/* Status banner — the plain-language "where it stands now". */}
              <div className="card mb-md" role="status" aria-live="polite" style={{ borderLeft: `3px solid ${TONE_COLOR[s.tone]}` }}>
                <div className="flex items-center gap-sm mb-xs">
                  <Icon size={18} style={{ color: TONE_COLOR[s.tone], flexShrink: 0 }} aria-hidden="true" />
                  <span style={{ fontWeight: 700, fontSize: "1.05rem", color: TONE_COLOR[s.tone] }}>{s.headline}</span>
                </div>
                <p className="text-sm text-secondary" style={{ margin: "0 0 var(--space-sm) 0", lineHeight: 1.6 }}>{s.detail}</p>
                <div className="text-xs uppercase tracking-wide text-muted" style={{ marginBottom: 2 }}>What happens next</div>
                <p className="text-sm" style={{ margin: 0, lineHeight: 1.6 }}>{s.next}</p>
              </div>

              {/* What was recommended — the "details" at the pre-claim stage. The
                  whole card links to the full file-vs-pay breakdown, so the separate
                  "View decision" row below is dropped (no twin doorways). */}
              {rec && (
                <Link
                  href={`/incidents/${id}/decision`}
                  className="card mb-md claim-rec-link"
                  aria-label="See the full filing recommendation and why"
                  style={{ display: "block", textDecoration: "none", color: "inherit" }}
                >
                  <div className="flex items-center justify-between mb-sm" style={{ gap: 12 }}>
                    <span className="text-xs uppercase tracking-wide text-secondary">What was recommended</span>
                    <span className="text-xs text-muted claim-rec-link__cta">View decision →</span>
                  </div>
                  <div className="claim-status-facts">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Recommendation</div>
                      <div className="text-sm" style={{ marginTop: 2 }}>
                        {!rec.has_active_policy ? "No active policy" : rec.should_file ? "Worth filing" : "Pay out of pocket"}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">{rec.has_active_policy ? "Net value" : "Out of pocket"}</div>
                      <div className="text-sm font-mono" style={{ marginTop: 2 }}>
                        {rec.has_active_policy
                          ? `net ${rec.net_expected_value_usd >= 0 ? "+" : "−"}$${Math.abs(rec.net_expected_value_usd).toLocaleString()}`
                          : `absorb ~$${rec.pay_out_of_pocket_cost.toLocaleString()}`}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted">Confidence</div>
                      <div className="text-sm font-mono" style={{ marginTop: 2 }}>{Math.round(rec.confidence * 100)}%</div>
                    </div>
                  </div>
                  {rec.reasons.length > 0 && (
                    <ul style={{ margin: "var(--space-sm) 0 0 var(--space-md)", padding: 0, fontSize: "0.82rem" }}>
                      {rec.reasons.slice(0, 2).map((r, i) => (
                        <li key={i} className="text-muted" style={{ marginBottom: 4 }}>{r}</li>
                      ))}
                    </ul>
                  )}
                </Link>
              )}

              <div className="card mb-md">{stepper}</div>

              {/* Fallback doorway only when there's no recommendation card to click. */}
              {!rec && recommendedLink}
            </>
          );
        })()}
      </div>
    </div>
  );
}
