"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileSpreadsheet,
  LockKeyhole,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { ClaimProposal } from "@/app/underwriter/[id]/page";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface PayoutRange {
  low_usd: number;
  median_usd: number;
  high_usd: number;
}
interface PremiumImpact {
  annual_delta_usd: number;
  duration_years: number;
  cumulative_usd: number;
}
interface ClaimRecommendation {
  should_file: boolean;
  probability: number;
  expected_payout: PayoutRange;
  expected_premium_impact: PremiumImpact;
  net_expected_value_usd: number;
  reasons: string[];
  confidence: number;
  rubric_version: string;
}
interface PacketLite {
  id: string;
  venue_id: string;
  incident_id: string;
  generated_at: string;
  claim_recommendation?: ClaimRecommendation;
  claim_proposal?: ClaimProposal | null;
}

const STATE_LABEL: Record<ClaimProposal["state"], string> = {
  pending_broker_review: "Pending broker review",
  approved: "Approved · ready to file",
  rejected_by_broker: "Rejected",
  filed_with_carrier: "Filed with carrier",
  paid: "Paid",
  denied: "Denied",
};

const STATE_COLOR: Record<ClaimProposal["state"], string> = {
  pending_broker_review: "var(--state-warning)",
  approved: "var(--brand-primary)",
  rejected_by_broker: "var(--state-error)",
  filed_with_carrier: "var(--brand-primary)",
  paid: "var(--brand-primary)",
  denied: "var(--state-error)",
};

const REASON_LABELS: Record<string, string> = {
  additional_evidence: "Additional evidence available",
  legal_counsel: "Legal counsel advised filing",
  prior_pattern: "Pattern with prior incidents",
  other: "Other (see context)",
};

export default function ClaimDetailPage() {
  const { packetId } = useParams<{ packetId: string }>();
  const router = useRouter();
  const { user } = useAuth();

  const [packet, setPacket] = useState<PacketLite | null>(null);
  const [proposal, setProposal] = useState<ClaimProposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [rejectNotes, setRejectNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isBroker = user?.role === "broker" || user?.role === "admin";

  useEffect(() => {
    async function load() {
      try {
        const pktRes = await fetch(`${API_URL}/api/packets/${packetId}`);
        if (!pktRes.ok) {
          setError("Packet not found");
          return;
        }
        const pkt: PacketLite = await pktRes.json();
        setPacket(pkt);
        setProposal(pkt.claim_proposal ?? null);
      } finally {
        setLoading(false);
      }
    }
    if (packetId) load();
  }, [packetId]);

  async function submitBrokerDecision(decision: "approved" | "rejected") {
    if (!proposal) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/claim-proposals/${proposal.id}/broker-decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            broker_id: user?.id ?? "unknown",
            decision,
            notes:
              decision === "rejected" && rejectNotes.trim() ? rejectNotes.trim() : null,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.detail ?? `Request failed (${res.status})`);
        return;
      }
      const updated: ClaimProposal = await res.json();
      setProposal(updated);
      setRejectNotes("");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="page-loading"><div className="loading-spinner" /></div>;
  if (!packet) {
    return (
      <div className="page page-empty">
        <AlertTriangle size={48} />
        <h3>Claim not found</h3>
        <button className="btn btn-ghost mt-md" onClick={() => router.back()}>
          Back
        </button>
      </div>
    );
  }

  const rec = packet.claim_recommendation;

  return (
    <div className="page">
      <header className="page-header">
        <div className="flex items-center gap-md">
          <button className="btn btn-ghost btn-sm" onClick={() => router.back()}>
            <ArrowLeft size={16} />
            Back
          </button>
          <div>
            <h1 style={{ fontSize: "1.5rem" }}>Claim Detail</h1>
            <p className="page-subtitle">
              Packet{" "}
              <Link href={`/underwriter/${packet.id}`} style={{ color: "var(--brand-primary)" }}>
                {packet.id.slice(0, 16)}…
              </Link>{" "}
              · {packet.venue_id}
            </p>
          </div>
        </div>
        {proposal && (
          <div
            className="text-xs font-mono px-md py-sm"
            style={{
              border: `1px solid ${STATE_COLOR[proposal.state]}`,
              color: STATE_COLOR[proposal.state],
              borderRadius: "var(--radius-sm)",
            }}
          >
            {STATE_LABEL[proposal.state].toUpperCase()}
          </div>
        )}
      </header>

      <div className="grid grid-cols-3 gap-xl">
        {/* Left: status, override reason, lifecycle */}
        <div className="flex flex-col gap-lg">
          <section className="card">
            <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
              Status
            </h2>
            {proposal ? (
              <div className="flex flex-col gap-sm text-sm">
                <div>
                  <span className="text-xs uppercase tracking-wide text-secondary block mb-xs">State</span>
                  <p style={{ color: STATE_COLOR[proposal.state], fontWeight: 700, margin: 0 }}>
                    {STATE_LABEL[proposal.state]}
                  </p>
                </div>
                <div>
                  <span className="text-xs uppercase tracking-wide text-secondary block mb-xs">Proposed by</span>
                  <p style={{ margin: 0 }}>{proposal.proposed_by}</p>
                  <p className="text-xs text-secondary" style={{ margin: 0 }}>
                    {new Date(proposal.proposed_at).toLocaleString()}
                  </p>
                </div>
                {proposal.broker_decided_at && (
                  <div>
                    <span className="text-xs uppercase tracking-wide text-secondary block mb-xs">
                      Broker decided
                    </span>
                    <p style={{ margin: 0 }}>{proposal.broker_decided_by}</p>
                    <p className="text-xs text-secondary" style={{ margin: 0 }}>
                      {new Date(proposal.broker_decided_at).toLocaleString()}
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-secondary">No proposal has been filed yet for this packet.</p>
            )}
          </section>

          {proposal?.override_recommendation && (
            <section className="card" style={{ border: "1px solid var(--state-warning)" }}>
              <h2 className="text-xs uppercase tracking-wide text-secondary mb-md" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                <AlertTriangle size={12} style={{ display: "inline", marginRight: 4, color: "var(--state-warning)" }} />
                Operator Override
              </h2>
              <p className="text-sm font-bold mb-xs" style={{ color: "var(--state-warning)", margin: 0 }}>
                {REASON_LABELS[proposal.override_reason ?? ""] ?? proposal.override_reason}
              </p>
              {proposal.override_freetext && (
                <p className="text-sm text-secondary mt-sm" style={{ fontStyle: "italic" }}>
                  “{proposal.override_freetext}”
                </p>
              )}
              <p className="text-xs text-tertiary mt-md" style={{ lineHeight: 1.5 }}>
                The operator disagreed with the recommender's verdict and chose to propose anyway.
                Every override is logged for audit and feeds the rubric calibration loop.
              </p>
            </section>
          )}

          {proposal?.broker_notes && (
            <section className="card">
              <h2 className="text-xs uppercase tracking-wide text-secondary mb-md" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                Broker Note
              </h2>
              <p className="text-sm text-secondary" style={{ fontStyle: "italic" }}>
                “{proposal.broker_notes}”
              </p>
            </section>
          )}
        </div>

        {/* Center: full EV math, side-by-side comparison */}
        <div className="flex flex-col gap-lg">
          {rec && (() => {
            const accent = rec.should_file ? "var(--brand-primary)" : "var(--text-tertiary)";
            const fileEv = rec.net_expected_value_usd;
            const dontFileEv = 0;
            return (
              <>
                <section className="card">
                  <div className="flex items-center justify-between mb-md" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                    <div className="flex items-center gap-sm">
                      <FileSpreadsheet size={16} style={{ color: accent }} />
                      <h2 className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
                        Recommender verdict
                      </h2>
                    </div>
                    <span
                      className="text-xs font-mono"
                      style={{ color: accent, textTransform: "uppercase", letterSpacing: "0.06em" }}
                    >
                      {Math.round(rec.confidence * 100)}% confident
                    </span>
                  </div>

                  <div className="flex items-center gap-md mb-md">
                    {rec.should_file ? (
                      <TrendingUp size={32} style={{ color: accent }} />
                    ) : (
                      <TrendingDown size={32} style={{ color: accent }} />
                    )}
                    <div>
                      <p className="text-lg font-bold" style={{ color: accent, margin: 0, lineHeight: 1.1 }}>
                        {rec.should_file ? "File this claim" : "Don't file"}
                      </p>
                      <p className="text-xs text-secondary" style={{ margin: 0, marginTop: 2 }}>
                        {Math.round(rec.probability * 100)}% paid-out probability
                      </p>
                    </div>
                  </div>

                  <details>
                    <summary className="text-xs font-mono cursor-pointer text-secondary">
                      Why ({rec.reasons.length})
                    </summary>
                    <ul className="mt-sm flex flex-col gap-xs" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {rec.reasons.map((r, i) => (
                        <li key={i} className="text-xs text-secondary" style={{ lineHeight: 1.5, paddingLeft: "var(--space-md)", position: "relative" }}>
                          <span style={{ position: "absolute", left: 0, color: accent }}>→</span>
                          {r}
                        </li>
                      ))}
                    </ul>
                  </details>
                </section>

                <section className="card">
                  <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                    File vs Don't File
                  </h2>
                  <div className="grid grid-cols-2 gap-md">
                    <div className="p-md" style={{ border: `1px solid ${fileEv >= 0 ? "var(--brand-primary)" : "var(--state-error)"}`, borderRadius: "var(--radius-sm)" }}>
                      <p className="text-xs uppercase tracking-wide text-secondary mb-xs">If you file</p>
                      <p className="text-2xl font-bold font-mono" style={{ color: fileEv >= 0 ? "var(--brand-primary)" : "var(--state-error)", margin: 0 }}>
                        {fileEv >= 0 ? "+" : "−"}${Math.abs(fileEv).toLocaleString()}
                      </p>
                      <p className="text-xs text-secondary mt-xs">Net EV over 3 years</p>
                    </div>
                    <div className="p-md" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                      <p className="text-xs uppercase tracking-wide text-secondary mb-xs">If you don't</p>
                      <p className="text-2xl font-bold font-mono" style={{ margin: 0 }}>
                        $0
                      </p>
                      <p className="text-xs text-secondary mt-xs">No payout, no premium impact</p>
                    </div>
                  </div>
                </section>

                <section className="card">
                  <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                    Expected payout
                  </h2>
                  <div className="flex justify-between items-baseline mb-sm">
                    <span className="text-xs uppercase tracking-wide text-secondary">Low</span>
                    <span className="text-sm font-mono">${rec.expected_payout.low_usd.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between items-baseline mb-sm">
                    <span className="text-xs uppercase tracking-wide text-secondary">Median</span>
                    <span className="text-sm font-mono font-bold" style={{ color: "var(--brand-primary)" }}>
                      ${rec.expected_payout.median_usd.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs uppercase tracking-wide text-secondary">High</span>
                    <span className="text-sm font-mono">${rec.expected_payout.high_usd.toLocaleString()}</span>
                  </div>
                </section>

                <section className="card">
                  <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                    Premium impact · year-by-year
                  </h2>
                  <ResponsiveTable headers={["Year", "Premium delta"]}>
                    {Array.from({ length: rec.expected_premium_impact.duration_years }, (_, i) => (
                      <tr key={i}>
                        <td data-label="Year">Y{i + 1}</td>
                        <td data-label="Premium delta" className="font-mono" style={{ color: "var(--state-warning)" }}>
                          +${rec.expected_premium_impact.annual_delta_usd.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td data-label="Total" className="text-xs uppercase tracking-wide text-secondary">
                        Cumulative
                      </td>
                      <td data-label="Premium delta" className="font-mono font-bold" style={{ color: "var(--state-warning)" }}>
                        +${rec.expected_premium_impact.cumulative_usd.toLocaleString()}
                      </td>
                    </tr>
                  </ResponsiveTable>
                </section>
              </>
            );
          })()}
        </div>

        {/* Right: broker action panel + lifecycle */}
        <div className="flex flex-col gap-lg">
          {proposal && proposal.state === "pending_broker_review" && isBroker && (
            <section className="card" style={{ border: "1px solid var(--brand-primary)" }}>
              <h2 className="text-xs uppercase tracking-wide text-secondary mb-md" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                Broker Decision
              </h2>
              <div className="flex flex-col gap-sm">
                <textarea
                  className="w-full text-sm p-sm"
                  rows={3}
                  placeholder="Reject notes (optional for approve)…"
                  value={rejectNotes}
                  onChange={(e) => setRejectNotes(e.target.value)}
                  disabled={submitting}
                  style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)", resize: "none" }}
                />
                <button
                  className="btn btn-primary w-full flex items-center justify-center gap-sm"
                  onClick={() => submitBrokerDecision("approved")}
                  disabled={submitting}
                >
                  <ShieldCheck size={16} />
                  Approve & File
                </button>
                <button
                  className="btn w-full flex items-center justify-center gap-sm"
                  onClick={() => submitBrokerDecision("rejected")}
                  disabled={submitting}
                  style={{ border: "1px solid var(--state-error)", color: "var(--state-error)", background: "none" }}
                >
                  <LockKeyhole size={16} />
                  Reject
                </button>
              </div>
              {error && (
                <p className="text-xs mt-sm" style={{ color: "var(--state-error)" }}>
                  {error}
                </p>
              )}
            </section>
          )}

          {proposal && (
            <section className="card">
              <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                Lifecycle
              </h2>
              <ol className="flex flex-col gap-md" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                <li className="flex items-start gap-sm">
                  <CheckCircle2 size={14} style={{ color: "var(--brand-primary)", marginTop: 2 }} />
                  <div>
                    <p className="text-sm font-semibold" style={{ margin: 0 }}>Proposed</p>
                    <p className="text-xs text-secondary" style={{ margin: 0 }}>
                      {new Date(proposal.proposed_at).toLocaleString()}
                    </p>
                  </div>
                </li>
                {proposal.broker_decided_at ? (
                  <li className="flex items-start gap-sm">
                    {proposal.state === "approved" || proposal.state === "filed_with_carrier" ? (
                      <CheckCircle2 size={14} style={{ color: "var(--brand-primary)", marginTop: 2 }} />
                    ) : (
                      <LockKeyhole size={14} style={{ color: "var(--state-error)", marginTop: 2 }} />
                    )}
                    <div>
                      <p className="text-sm font-semibold" style={{ margin: 0 }}>
                        Broker {proposal.state === "approved" ? "approved" : "rejected"}
                      </p>
                      <p className="text-xs text-secondary" style={{ margin: 0 }}>
                        {new Date(proposal.broker_decided_at).toLocaleString()}
                      </p>
                    </div>
                  </li>
                ) : (
                  <li className="flex items-start gap-sm" style={{ opacity: 0.5 }}>
                    <div style={{ width: 14, height: 14, borderRadius: "50%", border: "1px dashed var(--text-tertiary)", marginTop: 2 }} />
                    <div>
                      <p className="text-sm" style={{ margin: 0 }}>Awaiting broker decision</p>
                    </div>
                  </li>
                )}
              </ol>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
