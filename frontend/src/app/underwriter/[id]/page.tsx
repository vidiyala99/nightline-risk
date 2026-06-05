"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useBreakpoint, useMounted } from "@/hooks/useBreakpoint";
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardCheck, FileSpreadsheet, LockKeyhole, RefreshCw, ShieldCheck, TrendingUp, TrendingDown } from "lucide-react";
import ClaimProposeModal, { type OverrideReason } from "@/components/ClaimProposeModal";
import { authHeaders } from "@/lib/authFetch";
import { byIndex, resolveOpenQuestion, type OpenQuestionResponse } from "@/lib/openQuestions";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ClaimRecommendation {
  should_file: boolean;
  probability: number;
  expected_payout: { low_usd: number; median_usd: number; high_usd: number };
  expected_premium_impact: { annual_delta_usd: number; duration_years: number; cumulative_usd: number };
  net_expected_value_usd: number;
  reasons: string[];
  confidence: number;
  rubric_version: string;
}

export interface ClaimProposal {
  id: string;
  packet_id: string;
  venue_id: string;
  proposed_by: string;
  proposed_at: string;
  override_recommendation: boolean;
  override_reason: string | null;
  override_freetext: string | null;
  state:
    | "pending_broker_review"
    | "approved"
    | "rejected_by_broker"
    | "needs_more_info"
    | "filed_with_carrier"
    | "paid"
    | "denied";
  broker_decided_by: string | null;
  broker_decided_at: string | null;
  broker_notes: string | null;
  info_requested_by: string | null;
  info_requested_at: string | null;
  info_request_note: string | null;
  operator_response_note: string | null;
  operator_responded_at: string | null;
}

interface Packet {
  id: string;
  incident_id: string;
  venue_id: string;
  status: string;
  risk_signals: { type?: string; severity?: string; confidence?: number; explanation?: string };
  action_plan: Array<{ title: string; rationale: string; evidence_needed: string[] }>;
  claims_timeline: Array<{ at: string; label: string; source: string }>;
  memo: {
    summary?: string;
    open_questions?: string[];
    review_status?: string;
    // Provenance: set by the memo provider so an underwriter can see whether
    // the prose they're reading is real LLM output or a deterministic template.
    provider?: string;        // e.g. "anthropic", "google", "deterministic"
    model?: string;           // e.g. "claude-haiku-4-5-20251001"
    fallback_reason?: string | null;  // populated when the primary LLM failed
  };
  citation_ids: string[];
  // validation: surfaced for rubric_failures, which signal that one or more
  // packet-creation gates fired (missing citations, invalid sources, etc.).
  validation?: {
    citation_count?: number;
    invalid_count?: number;
    rubric_failures?: string[];
  };
  generated_at: string;
  claim_recommendation?: ClaimRecommendation;
  claim_proposal?: ClaimProposal | null;
  open_question_responses?: OpenQuestionResponse[];
}

interface Incident {
  id: string;
  venue_id: string;
  occurred_at: string;
  location: string;
  summary: string;
  reported_by: string;
  injury_observed: boolean;
  police_called: boolean;
  ems_called: boolean;
  status: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--state-error)",
  high: "var(--state-error)",
  medium: "var(--state-warning)",
  low: "var(--brand-primary)",
  unknown: "var(--text-tertiary)",
};

export default function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [packet, setPacket] = useState<Packet | null>(null);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [visionAnalysis, setVisionAnalysis] = useState<{ status: string; analyses: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [resolvingQ, setResolvingQ] = useState<number | null>(null);
  const [proposal, setProposal] = useState<ClaimProposal | null>(null);
  const [proposeModalOpen, setProposeModalOpen] = useState(false);
  const [submittingProposal, setSubmittingProposal] = useState(false);
  const [submittingBrokerDecision, setSubmittingBrokerDecision] = useState(false);
  const [brokerRejectNotes, setBrokerRejectNotes] = useState("");
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [operatorResponseNote, setOperatorResponseNote] = useState("");
  const [submittingResponse, setSubmittingResponse] = useState(false);
  const [fnolDraft, setFnolDraft] = useState<{
    policy_id: string | null;
    coverage_line: string;
    date_of_loss: string | null;
    blockers: string[];
  } | null>(null);
  const [filing, setFiling] = useState(false);

  const isOperator = user?.role === "venue_operator";
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const bp = useBreakpoint();
  const mounted = useMounted();
  const isPhone = mounted && (bp === "xs" || bp === "sm");

  const reloadPacket = async () => {
    const res = await fetch(`${API_URL}/api/packets/${id}`, { headers: authHeaders() });
    if (res.ok) setPacket(await res.json());
  };

  const handleResolve = async (i: number, questionText: string) => {
    if (!packet) return;
    setResolvingQ(i);
    try {
      await resolveOpenQuestion(packet.id, i, { question_text: questionText });
      await reloadPacket();
    } finally {
      setResolvingQ(null);
    }
  };

  useEffect(() => {
    async function load() {
      try {
        const pktRes = await fetch(`${API_URL}/api/packets/${id}`, { headers: authHeaders() });
        if (!pktRes.ok) return;
        const pkt: Packet = await pktRes.json();
        setPacket(pkt);
        setProposal(pkt.claim_proposal ?? null);
        const [incRes, analysisRes] = await Promise.all([
          fetch(`${API_URL}/api/incidents/${pkt.incident_id}`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/incidents/${pkt.incident_id}/evidence-analysis`, { headers: authHeaders() }),
        ]);
        if (incRes.ok) setIncident(await incRes.json());
        if (analysisRes.ok) setVisionAnalysis(await analysisRes.json());
      } finally {
        setLoading(false);
      }
    }
    if (id) load();
  }, [id]);

  async function postProposal(override: {
    override_recommendation: boolean;
    override_reason: OverrideReason | null;
    override_freetext: string | null;
  }) {
    if (!packet) return;
    setSubmittingProposal(true);
    setProposalError(null);
    try {
      const res = await fetch(`${API_URL}/api/packets/${packet.id}/claim-proposal`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          operator_id: user?.id ?? "unknown",
          override_recommendation: override.override_recommendation,
          override_reason: override.override_reason,
          override_freetext: override.override_freetext,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setProposalError(err.detail ?? `Request failed (${res.status})`);
        return;
      }
      const created: ClaimProposal = await res.json();
      setProposal(created);
      setProposeModalOpen(false);
    } finally {
      setSubmittingProposal(false);
    }
  }

  async function submitBrokerDecision(dec: "approved" | "rejected" | "needs_more_info") {
    if (!proposal) return;
    setSubmittingBrokerDecision(true);
    setProposalError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/claim-proposals/${proposal.id}/broker-decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            broker_id: user?.id ?? "unknown",
            decision: dec,
            // The shared note carries the rejection reason OR the info request.
            notes:
              (dec === "rejected" || dec === "needs_more_info") && brokerRejectNotes.trim()
                ? brokerRejectNotes.trim()
                : null,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setProposalError(err.detail ?? `Request failed (${res.status})`);
        return;
      }
      const updated: ClaimProposal = await res.json();
      setProposal(updated);
      setBrokerRejectNotes("");
      if (dec === "approved") {
        loadFnolDraft(updated.id);
      }
    } finally {
      setSubmittingBrokerDecision(false);
    }
  }

  async function submitOperatorResponse() {
    if (!proposal || !operatorResponseNote.trim()) return;
    setSubmittingResponse(true);
    setProposalError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/claim-proposals/${proposal.id}/operator-response`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            operator_id: user?.id ?? "unknown",
            response_note: operatorResponseNote.trim(),
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setProposalError(err.detail ?? `Request failed (${res.status})`);
        return;
      }
      const updated: ClaimProposal = await res.json();
      setProposal(updated);
      setOperatorResponseNote("");
    } finally {
      setSubmittingResponse(false);
    }
  }

  // Broker escape hatch: withdraw your own info request so the proposal comes
  // back to your queue instead of parking on an operator who may never answer.
  async function cancelInfoRequest() {
    if (!proposal) return;
    setSubmittingBrokerDecision(true);
    setProposalError(null);
    try {
      const res = await fetch(
        `${API_URL}/api/claim-proposals/${proposal.id}/cancel-info-request`,
        { method: "POST", headers: { "content-type": "application/json", ...authHeaders() } },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setProposalError(err.detail ?? `Request failed (${res.status})`);
        return;
      }
      setProposal(await res.json());
    } finally {
      setSubmittingBrokerDecision(false);
    }
  }

  async function loadFnolDraft(proposalId: string) {
    const r = await fetch(`${API_URL}/api/claim-proposals/${proposalId}/fnol-draft`, { headers: authHeaders() });
    if (r.ok) setFnolDraft(await r.json());
  }

  // Auto-load the FNOL draft when the page loads with an already-approved proposal.
  useEffect(() => {
    if (proposal?.state === "approved" && !fnolDraft) {
      loadFnolDraft(proposal.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.state, proposal?.id]);

  if (loading) return <div className="page-loading"><div className="loading-spinner" /></div>;
  if (!packet) return (
    <div className="page page-empty">
      <AlertTriangle size={48} />
      <h3>Report Not Found</h3>
      <button className="btn btn-ghost mt-md" onClick={() => router.push("/underwriter")}>Back to Reports</button>
    </div>
  );

  const severity = packet.risk_signals?.severity ?? "unknown";
  const confidence = Math.round((packet.risk_signals?.confidence ?? 0) * 100);

  return (
    <div className="page">
      <header className="page-header">
        <div className="flex items-center gap-md">
          <button className="btn btn-ghost btn-sm" onClick={() => router.push("/underwriter")}>
            <ArrowLeft size={16} />
            Reports
          </button>
          <div>
            <h1 style={{ fontSize: "1.5rem" }}>
              {packet.venue_id.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
            </h1>
            <p className="page-subtitle">
              <span className="hide-on-phone">Report · </span>
              {new Date(packet.generated_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            </p>
          </div>
        </div>
        <div
          className="text-xs font-mono px-md py-sm"
          style={{ border: `1px solid ${SEVERITY_COLOR[severity]}`, color: SEVERITY_COLOR[severity], borderRadius: "var(--radius-sm)" }}
        >
          {severity.toUpperCase()} EXPOSURE · {confidence}% CONFIDENCE
        </div>
      </header>

      <div className="grid grid-cols-3 gap-xl report-detail-grid">
        {/* Left: Incident facts */}
        <div className="flex flex-col gap-lg">
          {incident && (
            <section className="card" data-section="incident">
              <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Incident</h2>
              <div className="flex flex-col gap-md text-sm">
                <div><span className="text-xs uppercase tracking-wide text-secondary block mb-xs">Summary</span><p>{incident.summary}</p></div>
                <div><span className="text-xs uppercase tracking-wide text-secondary block mb-xs">Location</span><p>{incident.location}</p></div>
                <div><span className="text-xs uppercase tracking-wide text-secondary block mb-xs">Reported by</span><p>{incident.reported_by}</p></div>
                <div><span className="text-xs uppercase tracking-wide text-secondary block mb-xs">Date</span><p>{new Date(incident.occurred_at).toLocaleString()}</p></div>
                <div className="flex gap-md pt-sm" style={{ borderTop: "1px solid var(--border-subtle)" }}>
                  {incident.injury_observed && <span className="badge badge-error">Injury</span>}
                  {incident.police_called && <span className="badge badge-warning">Police</span>}
                  {incident.ems_called && <span className="badge badge-warning">EMS</span>}
                </div>
              </div>
            </section>
          )}

          {(() => {
            const actions = (packet.action_plan ?? []).filter(a => a?.title?.trim() || a?.rationale?.trim());
            if (actions.length === 0) return null;
            return (
              <section className="card" data-section="actions">
                <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Required Actions</h2>
                <div className="flex flex-col gap-md">
                  {actions.map((action, i) => (
                    <div key={i} className="flex gap-md">
                      <ClipboardCheck size={16} className="text-secondary mt-xs flex-shrink-0" />
                      <div>
                        {action.title && <p className="text-sm font-semibold mb-xs">{action.title}</p>}
                        {action.rationale && <p className="text-xs text-secondary mb-xs">{action.rationale}</p>}
                        {(action.evidence_needed?.length ?? 0) > 0 && (
                          <p className="text-xs" style={{ color: "var(--accent-ink)" }}>{action.evidence_needed!.join(" · ")}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}
        </div>

        {/* Center: Risk analysis */}
        <div className="flex flex-col gap-lg">
          <section className="card" data-section="risk">
            <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Risk Signal</h2>
            <div className="flex gap-lg items-start">
              <div className="flex-1">
                <span
                  className="inline-block text-xs font-bold uppercase px-sm py-xs mb-md"
                  style={{ background: `${SEVERITY_COLOR[severity]}22`, color: SEVERITY_COLOR[severity], border: `1px solid ${SEVERITY_COLOR[severity]}` }}
                >
                  {severity} exposure
                </span>
                <p className="text-sm leading-relaxed">{packet.risk_signals?.explanation ?? "No explanation available."}</p>
              </div>
              <div className="text-center flex-shrink-0">
                <div className="text-4xl font-bold font-display" style={{ color: "var(--accent-ink)" }}>{confidence}%</div>
                <div className="text-xs text-secondary">confidence</div>
              </div>
            </div>
          </section>

          <section className="card" data-section="memo">
            <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Underwriting Memo</h2>

            {/* Transparency: warn whenever the prose came from the deterministic
                template rather than a real LLM call. Two cases trigger this:
                  1) The configured LLM provider failed at runtime → fallback_reason
                     is set with the failure reason (anthropic_provider.py etc.).
                  2) No LLM keys were configured at all → provider is reported as
                     "deterministic" / "deterministic-v1" and fallback_reason is null.
                Both look identical to the underwriter; both deserve the same warning. */}
            {(() => {
              const provider = packet.memo?.provider ?? "";
              const isDeterministic = provider.toLowerCase().startsWith("deterministic");
              const fallbackReason = packet.memo?.fallback_reason;
              if (!isDeterministic && !fallbackReason) return null;
              return (
                <div
                  className="mb-lg"
                  style={{
                    background: "rgba(245,158,11,0.10)",
                    border: "1px solid rgba(245,158,11,0.30)",
                    borderRadius: "var(--radius-md)",
                    padding: "var(--space-md)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-xs)",
                  }}
                  data-testid="memo-fallback-banner"
                >
                  <div className="text-xs uppercase tracking-wide" style={{ color: "var(--tier-c)", fontWeight: 600 }}>
                    ⚠ Template-generated — not from an LLM
                  </div>
                  <div className="text-xs text-secondary">
                    This memo was produced by the deterministic template, not a language model.
                    Treat the prose as a structured placeholder, not analysis.
                  </div>
                  <div className="text-xs" style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                    {fallbackReason
                      ? `Reason: ${fallbackReason}`
                      : `Provider: ${provider || "deterministic"} (no LLM configured)`}
                  </div>
                </div>
              );
            })()}

            {/* Rubric gates that fired during packet creation. The default rubric
                enforces requires_citations; richer rubrics can require minimum
                counts, reject invalid citations, or ban prohibited fields. */}
            {(packet.validation?.rubric_failures?.length ?? 0) > 0 ? (
              <div
                className="mb-lg"
                style={{
                  background: "rgba(244,63,94,0.10)",
                  border: "1px solid rgba(244,63,94,0.30)",
                  borderRadius: "var(--radius-md)",
                  padding: "var(--space-md)",
                }}
                data-testid="rubric-failures-banner"
              >
                <div className="text-xs uppercase tracking-wide mb-sm" style={{ color: "var(--tier-d)", fontWeight: 600 }}>
                  ⚠ Rubric gate{packet.validation!.rubric_failures!.length === 1 ? "" : "s"} failed
                </div>
                <ul className="text-xs text-secondary" style={{ listStyle: "disc", paddingLeft: "var(--space-lg)", margin: 0 }}>
                  {packet.validation!.rubric_failures!.map((f, i) => (
                    <li key={i} style={{ fontFamily: "var(--font-mono)", marginBottom: 2 }}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-sm leading-relaxed mb-lg">{packet.memo?.summary ?? "No memo available."}</p>

            {/* Provenance caption: only shown when the memo IS from an LLM. The
                deterministic / fallback case is covered by the warning banner above. */}
            {(() => {
              const provider = packet.memo?.provider ?? "";
              const isDeterministic = provider.toLowerCase().startsWith("deterministic");
              if (isDeterministic || packet.memo?.fallback_reason || !provider) return null;
              return (
                <div className="text-xs mb-lg" style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }} data-testid="memo-provenance">
                  Generated by {provider}{packet.memo?.model ? ` · ${packet.memo.model}` : ""}
                </div>
              );
            })()}
            {(packet.memo?.open_questions?.length ?? 0) > 0 && (() => {
              const responses = byIndex(packet.open_question_responses);
              return (
                <div>
                  <p className="text-xs uppercase tracking-wide text-secondary mb-md">Open Questions</p>
                  <div className="flex flex-col gap-md">
                    {packet.memo.open_questions!.map((q, i) => {
                      const resp = responses.get(i);
                      return (
                        <div
                          key={i}
                          className="card"
                          style={{ padding: "var(--space-md)", opacity: resp?.resolved ? 0.7 : 1 }}
                        >
                          <div className="flex items-start gap-sm" style={{ justifyContent: "space-between" }}>
                            <span className="text-sm" style={{ fontWeight: 600 }}>{q}</span>
                            {resp?.resolved && (
                              <span className="text-xs" style={{ color: "var(--accent-ink)", whiteSpace: "nowrap" }}>
                                ✓ Resolved{resp.resolved_by ? ` · ${resp.resolved_by}` : ""}
                              </span>
                            )}
                          </div>
                          {resp?.answer ? (
                            <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--accent-ink)" }}>
                              <div className="text-xs uppercase tracking-wide text-muted">
                                Operator{resp.answered_by ? ` · ${resp.answered_by}` : ""}
                              </div>
                              <p className="text-sm text-secondary" style={{ margin: "2px 0 0", lineHeight: 1.6 }}>{resp.answer}</p>
                            </div>
                          ) : (
                            <p className="text-xs text-muted" style={{ margin: "6px 0 0", fontStyle: "italic" }}>
                              Awaiting operator response
                            </p>
                          )}
                          {isBroker && !resp?.resolved && (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              style={{ marginTop: 10, minHeight: 44 }}
                              disabled={resolvingQ === i}
                              onClick={() => handleResolve(i, q)}
                            >
                              {resolvingQ === i ? "Resolving…" : "Mark resolved"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </section>

          {/* Vision Analysis */}
          {visionAnalysis && visionAnalysis.analyses.length > 0 && (
            <section className="card" data-section="vision">
              <div className="flex items-center justify-between mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                <h2 className="text-xs uppercase tracking-wide text-secondary">Visual Evidence Analysis</h2>
                {visionAnalysis.analyses[0]?.corroboration && (
                  <span className="text-xs font-mono px-sm py-xs font-bold" style={{
                    background: visionAnalysis.analyses[0].corroboration === "CONSISTENT" ? "rgba(200,240,0,0.12)" : visionAnalysis.analyses[0].corroboration === "CONTRADICTED" ? "rgba(255,60,60,0.12)" : "rgba(255,153,0,0.12)",
                    color: visionAnalysis.analyses[0].corroboration === "CONSISTENT" ? "var(--accent-ink)" : visionAnalysis.analyses[0].corroboration === "CONTRADICTED" ? "var(--state-error)" : "var(--state-warning)",
                    borderRadius: "var(--radius-sm)",
                  }}>
                    {visionAnalysis.analyses[0].corroboration}
                  </span>
                )}
              </div>
              {visionAnalysis.analyses.map((a: any, i: number) => (
                <div key={i} className="flex flex-col gap-sm mb-md">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-mono uppercase text-secondary">{a.analysis_type} analysis</span>
                    <span className="text-xs font-mono" style={{ color: "var(--accent-ink)" }}>+{Math.round(a.confidence_delta * 100)}% confidence</span>
                  </div>
                  <p className="text-sm leading-relaxed">{a.raw_description}</p>
                  {a.findings?.incident_indicators?.length > 0 && (
                    <div className="flex flex-wrap gap-xs mt-xs">
                      {a.findings.incident_indicators.map((ind: string, j: number) => (
                        <span key={j} className="text-xs px-sm py-xs font-mono" style={{ background: "rgba(200,240,0,0.06)", border: "1px solid rgba(200,240,0,0.2)", borderRadius: "var(--radius-sm)", color: "var(--accent-ink)" }}>
                          {ind}
                        </span>
                      ))}
                    </div>
                  )}
                  {a.findings?.injury_detail && (
                    <p className="text-xs text-secondary font-mono mt-xs">Injury detail: {a.findings.injury_detail}</p>
                  )}
                  {a.findings?.security_present !== undefined && (
                    <p className="text-xs text-secondary font-mono">Security present: {a.findings.security_present ? `Yes${a.findings.security_response_seconds ? ` (response: ${a.findings.security_response_seconds}s)` : ""}` : "No"}</p>
                  )}
                </div>
              ))}
            </section>
          )}

          <section className="card" data-section="timeline">
            <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Claims Timeline</h2>
            <div className="flex flex-col gap-sm">
              {(packet.claims_timeline?.length ?? 0) > 0 ? packet.claims_timeline!.map((event, i) => (
                <div key={i} className="flex gap-md text-sm" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                  <span className="font-mono text-xs text-secondary flex-shrink-0 mt-xs">
                    {event.at.split("T")[1]?.slice(0, 5) ?? event.at}
                  </span>
                  <div>
                    <p>{event.label}</p>
                    <p className="text-xs text-secondary mt-xs">{event.source}</p>
                  </div>
                </div>
              )) : <p className="text-sm text-secondary">No timeline events.</p>}
            </div>
          </section>
        </div>

        {/* Right: Decision */}
        <div className="flex flex-col gap-lg">

          {/* AI Claim Recommendation — the single most-impactful surface on this page.
              Sits above Review Decision so the broker reads it BEFORE choosing approve/reject. */}
          {packet.claim_recommendation && (() => {
            const rec = packet.claim_recommendation;
            const accent = rec.should_file ? "var(--brand-primary)" : "var(--text-tertiary)";
            const netEvFormatted = (rec.net_expected_value_usd >= 0 ? "+" : "−") +
              "$" + Math.abs(rec.net_expected_value_usd).toLocaleString();
            return (
              <section className="card" data-section="ai-rec" style={{ border: `1px solid ${accent}55`, position: "relative" }}>
                {/* Brand-primary accent stripe — earned only when the recommender says file */}
                <div style={{
                  position: "absolute", left: 0, top: 0, bottom: 0, width: 3,
                  background: accent, borderTopLeftRadius: "var(--radius-md)", borderBottomLeftRadius: "var(--radius-md)",
                }} aria-hidden="true" />

                <div className="flex items-center justify-between mb-md ai-rec-card__head" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                  <div className="flex items-center gap-sm">
                    <FileSpreadsheet size={16} style={{ color: accent }} aria-hidden="true" />
                    <h2 className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>AI Claim Recommendation</h2>
                  </div>
                  <span
                    className="text-xs font-mono"
                    style={{
                      color: accent,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      fontSize: "0.65rem",
                    }}
                  >
                    {Math.round(rec.confidence * 100)}% confident
                  </span>
                </div>

                <div className="flex items-center gap-md mb-md">
                  {isPhone ? (
                    <span
                      aria-hidden="true"
                      style={{
                        color: accent,
                        fontSize: "2rem",
                        lineHeight: 1,
                        fontWeight: 400,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {rec.should_file ? "↑" : "↓"}
                    </span>
                  ) : rec.should_file ? (
                    <TrendingUp size={32} style={{ color: accent }} aria-hidden="true" />
                  ) : (
                    <TrendingDown size={32} style={{ color: accent }} aria-hidden="true" />
                  )}
                  <div>
                    <p className="text-lg font-bold" style={{ color: accent, margin: 0, lineHeight: 1.1 }}>
                      {rec.should_file ? "File this claim" : "Don't file yet"}
                    </p>
                    <p className="text-xs text-secondary" style={{ margin: 0, marginTop: 2 }}>
                      {Math.round(rec.probability * 100)}% paid-out probability · net EV {netEvFormatted}
                    </p>
                  </div>
                </div>

                {/* The expected-value math, made visible so the broker can sanity-check the recommendation */}
                <div className="flex flex-col gap-sm mb-md" style={{ background: "var(--bg-elevated)", padding: "var(--space-md)", borderRadius: "var(--radius-sm)" }}>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs uppercase tracking-wide text-secondary">Expected payout</span>
                    <span className="text-sm font-mono">
                      ${rec.expected_payout.low_usd.toLocaleString()}
                      <span className="text-secondary"> – </span>
                      ${rec.expected_payout.high_usd.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs uppercase tracking-wide text-secondary">Median</span>
                    <span className="text-sm font-mono font-bold" style={{ color: "var(--accent-ink)" }}>
                      ${rec.expected_payout.median_usd.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline">
                    <span className="text-xs uppercase tracking-wide text-secondary">Premium impact</span>
                    <span className="text-sm font-mono" style={{ color: "var(--state-warning)" }}>
                      +${rec.expected_premium_impact.annual_delta_usd.toLocaleString()}/yr × {rec.expected_premium_impact.duration_years}yr
                    </span>
                  </div>
                  <div className="flex justify-between items-baseline" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-sm)" }}>
                    <span className="text-xs uppercase tracking-wide text-secondary">Net EV</span>
                    <span className="text-sm font-mono font-bold" style={{ color: rec.net_expected_value_usd >= 0 ? "var(--state-success)" : "var(--state-error)" }}>
                      {netEvFormatted}
                    </span>
                  </div>
                </div>

                {isPhone ? (
                  <ul className="flex flex-col gap-sm" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {(rec.reasons ?? []).slice(0, 2).map((reason, i) => (
                      <li key={i} className="text-sm" style={{ lineHeight: 1.45, paddingLeft: "var(--space-lg)", position: "relative", color: "var(--text-primary)" }}>
                        <span style={{ position: "absolute", left: 0, color: accent }} aria-hidden="true">→</span>
                        {reason}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <details>
                    <summary className="text-xs font-mono cursor-pointer text-secondary" style={{ userSelect: "none" }}>
                      Why this recommendation ({rec.reasons?.length ?? 0} reason{(rec.reasons?.length ?? 0) === 1 ? "" : "s"})
                    </summary>
                    <ul className="mt-sm flex flex-col gap-xs" style={{ listStyle: "none", padding: 0, margin: 0 }}>
                      {(rec.reasons ?? []).map((reason, i) => (
                        <li key={i} className="text-xs text-secondary" style={{ lineHeight: 1.5, paddingLeft: "var(--space-md)", position: "relative" }}>
                          <span style={{ position: "absolute", left: 0, color: accent }} aria-hidden="true">→</span>
                          {reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <p className="text-xs text-tertiary mt-md hide-on-phone" style={{ fontStyle: "italic", lineHeight: 1.5 }}>
                  Carrier makes the final coverage decision. This recommendation surfaces the expected-value math before filing.
                </p>
              </section>
            );
          })()}

          {/* Claim Decision row — operator proposes, broker decides.
              Renders one of several states depending on whether a proposal exists
              and the viewer's role. The actual "should this be a claim?" reasoning
              lives in the recommender card above; this card is the *action surface*. */}
          {packet.claim_recommendation && (
            <section className="card" data-section="claim-decision">
              <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                Claim Decision
              </h2>

              {/* CASE 1: No proposal yet */}
              {!proposal && isOperator && (
                <div className="flex flex-col gap-sm">
                  {packet.claim_recommendation.should_file ? (
                    <button
                      className="btn btn-primary w-full flex items-center justify-center gap-sm"
                      onClick={() =>
                        postProposal({
                          override_recommendation: false,
                          override_reason: null,
                          override_freetext: null,
                        })
                      }
                      disabled={submittingProposal}
                    >
                      <CheckCircle2 size={16} />
                      {submittingProposal ? "Submitting…" : "Propose Claim"}
                    </button>
                  ) : (
                    <button
                      className="btn w-full flex items-center justify-center gap-sm"
                      onClick={() => setProposeModalOpen(true)}
                      disabled={submittingProposal}
                      style={{ border: "1px solid var(--state-warning)", color: "var(--state-warning)", background: "none" }}
                    >
                      <AlertTriangle size={16} />
                      Override & Propose
                    </button>
                  )}
                  <p className="text-xs text-secondary">
                    {packet.claim_recommendation.should_file
                      ? "The recommender supports filing. Your broker will review and decide."
                      : "The recommender suggested not filing. Override only if you have additional context the broker should weigh."}
                  </p>
                </div>
              )}

              {!proposal && isBroker && (
                <p className="text-sm text-secondary" style={{ fontStyle: "italic" }}>
                  Awaiting an operator proposal. The operator initiates; you decide.
                </p>
              )}

              {/* CASE 2: Proposal exists */}
              {proposal && (() => {
                const stateLabel: Record<ClaimProposal["state"], string> = {
                  pending_broker_review: "Pending broker review",
                  approved: "Approved · ready to file",
                  rejected_by_broker: "Rejected",
                  needs_more_info: "Info requested · awaiting operator",
                  filed_with_carrier: "Filed with carrier",
                  paid: "Paid",
                  denied: "Denied",
                };
                const stateColor: Record<ClaimProposal["state"], string> = {
                  pending_broker_review: "var(--state-warning)",
                  approved: "var(--brand-primary)",
                  rejected_by_broker: "var(--state-error)",
                  needs_more_info: "var(--state-warning)",
                  filed_with_carrier: "var(--brand-primary)",
                  paid: "var(--brand-primary)",
                  denied: "var(--state-error)",
                };
                const accent = stateColor[proposal.state];
                return (
                  <div className="flex flex-col gap-md">
                    <div className="flex items-center justify-between p-md" style={{ border: `1px solid ${accent}`, borderRadius: "var(--radius-sm)", background: `${accent}11` }}>
                      <div>
                        <p className="text-sm font-bold" style={{ color: accent, margin: 0 }}>
                          {stateLabel[proposal.state]}
                        </p>
                        <p className="text-xs text-secondary" style={{ margin: 0, marginTop: 2 }}>
                          Proposed {new Date(proposal.proposed_at).toLocaleString()}
                        </p>
                      </div>
                      {proposal.override_recommendation && (
                        <span className="text-xs font-mono px-sm py-xs" style={{
                          background: "rgba(255,153,0,0.12)",
                          color: "var(--state-warning)",
                          border: "1px solid var(--state-warning)",
                          borderRadius: "var(--radius-sm)",
                        }}>
                          ⚠ OVERRIDE
                        </span>
                      )}
                    </div>

                    {proposal.override_recommendation && proposal.override_reason && (
                      <div className="text-xs">
                        <span className="text-secondary uppercase tracking-wide">Override reason: </span>
                        <span className="font-mono">{proposal.override_reason.replace(/_/g, " ")}</span>
                        {proposal.override_freetext && (
                          <p className="text-secondary mt-xs" style={{ fontStyle: "italic" }}>
                            “{proposal.override_freetext}”
                          </p>
                        )}
                      </div>
                    )}

                    {proposal.broker_notes && (
                      <div className="text-xs">
                        <span className="text-secondary uppercase tracking-wide">Broker note: </span>
                        <p className="text-secondary mt-xs" style={{ fontStyle: "italic" }}>
                          “{proposal.broker_notes}”
                        </p>
                      </div>
                    )}

                    {proposal.operator_response_note && (
                      <div className="text-xs">
                        <span className="text-secondary uppercase tracking-wide">Operator response: </span>
                        <p className="text-secondary mt-xs" style={{ fontStyle: "italic" }}>
                          “{proposal.operator_response_note}”
                        </p>
                      </div>
                    )}

                    {/* Broker inline approve / request-info / reject when pending */}
                    {proposal.state === "pending_broker_review" && isBroker && (
                      <div className="flex flex-col gap-sm" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-md)" }}>
                        <label className="text-xs uppercase tracking-wide text-secondary block">
                          Notes (required to reject or request info)
                        </label>
                        <textarea
                          className="w-full text-sm p-sm"
                          rows={2}
                          placeholder="Why this shouldn't be filed, or what evidence you need…"
                          value={brokerRejectNotes}
                          onChange={(e) => setBrokerRejectNotes(e.target.value)}
                          disabled={submittingBrokerDecision}
                          style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)", resize: "none" }}
                        />
                        <div className="flex gap-sm">
                          <button
                            className="btn btn-primary flex-1 flex items-center justify-center gap-sm"
                            onClick={() => submitBrokerDecision("approved")}
                            disabled={submittingBrokerDecision}
                          >
                            <ShieldCheck size={16} />
                            Approve & File
                          </button>
                          <button
                            className="btn flex-1 flex items-center justify-center gap-sm"
                            onClick={() => submitBrokerDecision("rejected")}
                            disabled={submittingBrokerDecision}
                            style={{ border: "1px solid var(--state-error)", color: "var(--state-error)", background: "none" }}
                          >
                            <LockKeyhole size={16} />
                            Reject
                          </button>
                        </div>
                        <button
                          className="btn w-full flex items-center justify-center gap-sm"
                          onClick={() => submitBrokerDecision("needs_more_info")}
                          disabled={submittingBrokerDecision || !brokerRejectNotes.trim()}
                          title={!brokerRejectNotes.trim() ? "Add a note describing what you need" : undefined}
                          style={{ border: "1px solid var(--state-warning)", color: "var(--state-warning)", background: "none" }}
                        >
                          Request more info
                        </button>
                      </div>
                    )}

                    {/* Operator responds to a broker's info request → re-queues */}
                    {proposal.state === "needs_more_info" && isOperator && (
                      <div className="flex flex-col gap-sm" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-md)" }}>
                        {proposal.info_request_note && (
                          <p className="text-xs text-secondary" style={{ margin: 0 }}>
                            Your broker asked:{" "}
                            <span style={{ fontStyle: "italic" }}>“{proposal.info_request_note}”</span>
                          </p>
                        )}
                        <textarea
                          className="w-full text-sm p-sm"
                          rows={2}
                          placeholder="Answer the broker, and attach any evidence to the incident above…"
                          value={operatorResponseNote}
                          onChange={(e) => setOperatorResponseNote(e.target.value)}
                          disabled={submittingResponse}
                          style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)", resize: "none" }}
                        />
                        <button
                          className="btn btn-primary w-full flex items-center justify-center gap-sm"
                          onClick={submitOperatorResponse}
                          disabled={submittingResponse || !operatorResponseNote.trim()}
                        >
                          Send response → re-queue for broker
                        </button>
                      </div>
                    )}

                    {/* Broker escape: stop waiting on the operator and pull the
                        proposal back to your queue to decide it now. */}
                    {proposal.state === "needs_more_info" && isBroker && (
                      <div className="flex flex-col gap-sm" style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: "var(--space-md)" }}>
                        <p className="text-xs text-secondary" style={{ margin: 0 }}>
                          Awaiting the operator&apos;s response. Don&apos;t want to wait? Withdraw your request and decide now.
                        </p>
                        <button
                          className="btn w-full flex items-center justify-center gap-sm"
                          onClick={cancelInfoRequest}
                          disabled={submittingBrokerDecision}
                          style={{ border: "1px solid var(--state-warning)", color: "var(--state-warning)", background: "none" }}
                        >
                          <RefreshCw size={16} />
                          {submittingBrokerDecision ? "Withdrawing…" : "Withdraw request — decide now"}
                        </button>
                      </div>
                    )}

                  </div>
                );
              })()}

              {proposalError && (
                <p className="text-xs mt-sm" style={{ color: "var(--state-error)" }}>
                  {proposalError}
                </p>
              )}
            </section>
          )}

          {/* FNOL confirm — shown to brokers after a proposal is approved */}
          {isBroker && proposal?.state === "approved" && fnolDraft && (
            <section className="card" data-section="fnol-confirm" style={{ marginTop: "var(--space-md)" }}>
              <h3 className="card-title">Confirm &amp; file FNOL</h3>
              {fnolDraft.blockers.length > 0 ? (
                <p className="text-error">Cannot file: {fnolDraft.blockers.join(", ")}. Resolve the policy first.</p>
              ) : (
                <>
                  <p className="text-muted font-mono" style={{ fontSize: "0.85rem" }}>
                    policy {fnolDraft.policy_id} · {fnolDraft.coverage_line} · loss {fnolDraft.date_of_loss}
                  </p>
                  <button
                    className="btn btn-primary"
                    disabled={filing}
                    style={{ minHeight: 44 }}
                    onClick={async () => {
                      setFiling(true);
                      const r = await fetch(`${API_URL}/api/claim-proposals/${proposal.id}/file-fnol`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", ...authHeaders() },
                        body: JSON.stringify({
                          policy_id: fnolDraft.policy_id,
                          coverage_line: fnolDraft.coverage_line,
                          date_of_loss: fnolDraft.date_of_loss,
                          broker_id: user?.id ?? "broker",
                        }),
                      });
                      setFiling(false);
                      if (r.ok) {
                        // Reactively advance the proposal so the confirm form
                        // collapses and the "Filed with carrier" badge shows
                        // immediately — no full-page reload.
                        setProposal((prev) => (prev ? { ...prev, state: "filed_with_carrier" } : prev));
                      } else {
                        setProposalError("Could not file the FNOL. Please retry.");
                      }
                    }}
                  >
                    {filing ? "Filing…" : "Confirm & file FNOL"}
                  </button>
                </>
              )}
            </section>
          )}

          {isBroker && proposal?.state === "filed_with_carrier" && (
            <span className="badge badge-info">Filed with carrier</span>
          )}

          <section className="card" data-section="evidence">
            <h2 className="text-xs uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Evidence Summary</h2>
            <div className="flex gap-md mb-md">
              <div className="flex-1 text-center p-md" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                <div className="text-2xl font-bold font-mono" style={{ color: "var(--accent-ink)" }}>{packet.citation_ids?.length ?? 0}</div>
                <div className="text-xs text-secondary uppercase tracking-wide">Citations</div>
              </div>
              <div className="flex-1 text-center p-md" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                <div className="text-2xl font-bold font-mono" style={{ color: "var(--accent-ink)" }}>{packet.claims_timeline?.length ?? 0}</div>
                <div className="text-xs text-secondary uppercase tracking-wide">Events</div>
              </div>
            </div>
            <p className="text-xs text-secondary font-mono">Report ID: {packet.id.slice(0, 16)}…</p>
          </section>
        </div>
      </div>

      <ClaimProposeModal
        isOpen={proposeModalOpen}
        onClose={() => setProposeModalOpen(false)}
        recommenderVerdict={packet.claim_recommendation?.should_file ? "file" : "do_not_file"}
        submitting={submittingProposal}
        onSubmit={async (input) => {
          await postProposal({
            override_recommendation: input.override_recommendation,
            override_reason: input.override_reason,
            override_freetext: input.override_freetext,
          });
        }}
      />
    </div>
  );
}
