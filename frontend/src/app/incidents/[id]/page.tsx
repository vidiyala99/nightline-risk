"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { answerOpenQuestion, resolveOpenQuestion, byIndex } from "@/lib/openQuestions";
import { toastSuccess, toastError } from "@/lib/toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { downloadDefensePackagePdf } from "@/lib/claims";
import { SEVERITY_COLOR } from "@/lib/risk";

// A claim is "in flight" while it can still pay out — the incident can't be
// closed until it resolves. Mirrors the backend guard in update_incident_status.
const RESOLVED_PROPOSAL_STATES = new Set(["rejected_by_broker", "paid", "denied"]);
const CLOSED_CLAIM_STATUSES = new Set(["closed_paid", "closed_denied", "closed_dropped"]);
import {
  AlertTriangle, Calendar, MapPin, User,
  Clock, CheckCircle2, Shield, ExternalLink, FileText, ChevronRight, Download, Archive, Trash2,
} from "lucide-react";
import { usePageBack } from "@/components/layout/BackNavContext";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface EvidenceItem {
  id: string;
  filename: string;
  content_type: string;
  file_size: number;
  uploaded_at: string;
}

/** Evidence bytes are auth-gated (cross-tenant safe), so a bare <img src> / <a href>
 * can't reach them — the browser won't attach the bearer token. Fetch the blob with
 * authHeaders() and render an object URL instead (same pattern as the gated PDF
 * downloads in lib/claims.ts). */
function AuthedEvidenceRow({ ev, onDelete, deleting }: {
  ev: EvidenceItem;
  onDelete?: (id: string) => void;
  deleting?: boolean;
}) {
  const isImage = ev.content_type.startsWith("image/");
  const isVideo = ev.content_type.startsWith("video/");
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isImage) return;
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/evidence/${ev.id}/file`, { headers: authHeaders() });
        if (!res.ok || cancelled) return;
        url = URL.createObjectURL(await res.blob());
        if (cancelled) { URL.revokeObjectURL(url); return; }
        setThumbUrl(url);
      } catch { /* leave the placeholder tile */ }
    })();
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [ev.id, isImage]);

  async function view() {
    try {
      const res = await fetch(`${API_URL}/api/evidence/${ev.id}/file`, { headers: authHeaders() });
      if (!res.ok) return;
      // The opened tab keeps reading this URL, so it can't be revoked synchronously.
      window.open(URL.createObjectURL(await res.blob()), "_blank", "noreferrer");
    } catch { /* ignore */ }
  }

  return (
    <div className="flex items-center gap-md p-sm" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
      {isImage && thumbUrl ? (
        <img src={thumbUrl} alt={ev.filename} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "var(--radius-sm)", flexShrink: 0 }} />
      ) : (
        <div style={{ width: 56, height: 56, background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <span className="text-xs text-secondary">{isVideo ? "VID" : isImage ? "IMG" : "FILE"}</span>
        </div>
      )}
      <div className="flex-1" style={{ minWidth: 0, overflow: "hidden" }}>
        <p className="text-sm truncate">{ev.filename}</p>
        <p className="text-xs text-secondary">{(ev.file_size / 1024).toFixed(1)} KB · {new Date(ev.uploaded_at).toLocaleString()}</p>
      </div>
      <button type="button" onClick={view} className="btn btn-ghost btn-sm text-xs">View</button>
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(ev.id)}
          disabled={deleting}
          className="btn btn-ghost btn-sm text-xs"
          aria-label={`Delete ${ev.filename}`}
          title="Delete evidence"
          style={{ color: "var(--state-error)", opacity: deleting ? 0.5 : 1 }}
        >
          {deleting ? <div className="loading-spinner loading-spinner-sm" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}

type IncidentStatus = "open" | "under_review" | "closed" | "closed_archived";

interface Incident {
  id: string;
  venue_id: string;
  occurred_at: string;
  location: string;
  summary: string;
  reported_by: string;
  injury_observed?: boolean;
  police_called?: boolean;
  ems_called?: boolean;
  status: IncidentStatus;
  incident_category?: string | null;
}

// A scannable H1 label — the narrative summary lives in the Description card,
// so the title uses the structured category when present, else the first
// sentence of the summary (a clean boundary, never a mid-word slice).
function prettyCategory(c: string): string {
  return c.replace(/[_-]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
function incidentTitle(inc: Incident): string {
  if (inc.incident_category?.trim()) return prettyCategory(inc.incident_category);
  const firstSentence = inc.summary.split(/(?<=[.!?])\s/)[0]?.trim();
  return firstSentence || inc.summary;
}

interface Citation {
  source_id: string;
  source_type: string;
  excerpt: string;
}

interface Packet {
  id: string;
  status: string;
  risk_signals: {
    type: string;
    severity: string;
    confidence: number;
    explanation: string;
    citations: Citation[];
  };
}

// Severity ink colors are shared — local copies drifted to lime-as-text once
// already; import from the lint-allowlisted token source instead.
// (SEVERITY_COLOR import added below with the other lib imports.)

// Whether a packet became a claim proposal, and its state — so a broker
// drilling into an incident sees the actionable item, not just a read wall.
const PROPOSAL_BADGE: Record<string, { label: string; color: string }> = {
  pending_broker_review: { label: "Proposal · pending", color: "var(--state-warning)" },
  needs_more_info: { label: "Proposal · info requested", color: "var(--state-warning)" },
  approved: { label: "Proposal · approved", color: "var(--accent-ink)" },
  rejected_by_broker: { label: "Proposal · rejected", color: "var(--state-error)" },
  filed_with_carrier: { label: "Proposal · filed", color: "var(--accent-ink)" },
  paid: { label: "Proposal · paid", color: "var(--accent-ink)" },
  denied: { label: "Proposal · denied", color: "var(--state-error)" },
};

interface ClaimStatusResponse {
  incident_status: string;
  proposal: { exists: boolean; state: string | null };
  claim: { exists: boolean; status: string | null };
}

// The closed loop: did this incident become a real carrier claim?
interface IncidentClaim {
  id: string;
  incident_id: string | null;
  carrier_claim_number: string | null;
  coverage_line: string;
  status: string;
  current_reserve: string;
}

const statusLabel: Record<IncidentStatus, string> = {
  open: "Open",
  under_review: "Under Review",
  closed: "Closed",
  closed_archived: "Archived",
};

export default function IncidentDetailPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [incident, setIncident] = useState<Incident | null>(null);
  const [packets, setPackets] = useState<Packet[]>([]);
  const [proposalByPacket, setProposalByPacket] = useState<Record<string, string>>({});
  const [claim, setClaim] = useState<IncidentClaim | null>(null);
  const [evidence, setEvidence] = useState<Array<{ id: string; filename: string; content_type: string; file_size: number; uploaded_at: string }>>([]);
  const [visionAnalysis, setVisionAnalysis] = useState<{ status: string; processed: number; total_files: number; analyses: any[] } | null>(null);
  const [riskScore, setRiskScore] = useState<{ total_score: number; tier: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState<string | null>(null);
  const [claimStatus, setClaimStatus] = useState<ClaimStatusResponse | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<number, string>>({});
  const [savingQ, setSavingQ] = useState<number | null>(null);

  const reloadPackets = async () => {
    const res = await fetch(`${API_URL}/api/incidents/${id}/packets`, { headers: authHeaders() });
    if (res.ok) setPackets(await res.json());
  };

  const answerQuestion = async (packetId: string, i: number, questionText: string) => {
    const answer = (answerDrafts[i] ?? "").trim();
    if (!answer) return;
    setSavingQ(i);
    try {
      await answerOpenQuestion(packetId, i, { question_text: questionText, answer });
      setAnswerDrafts((d) => ({ ...d, [i]: "" }));
      await reloadPackets();
    } finally {
      setSavingQ(null);
    }
  };

  const resolveQuestion = async (packetId: string, i: number, questionText: string) => {
    setSavingQ(i);
    try {
      await resolveOpenQuestion(packetId, i, { question_text: questionText });
      await reloadPackets();
    } finally {
      setSavingQ(null);
    }
  };

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    async function load() {
      try {
        const [incidentRes, packetsRes, evidenceRes, analysisRes, claimStatusRes] = await Promise.all([
          fetch(`${API_URL}/api/incidents/${id}`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/incidents/${id}/packets`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/incidents/${id}/evidence`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/incidents/${id}/evidence-analysis`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/incidents/${id}/claim-status`, { headers: authHeaders() }),
        ]);
        if (incidentRes.ok) setIncident(await incidentRes.json());
        if (claimStatusRes.ok) setClaimStatus(await claimStatusRes.json());
        if (packetsRes.ok) {
          const pkts = await packetsRes.json();
          setPackets(pkts);
          // Resolve whether each packet became a claim proposal (and its state).
          // by-packet 404s when none exists; few packets per incident, so the
          // per-packet calls are cheap.
          const entries = await Promise.all(
            (pkts as Packet[]).map(async (p) => {
              try {
                const r = await fetch(`${API_URL}/api/claim-proposals/by-packet/${p.id}`, { headers: authHeaders() });
                if (!r.ok) return null;
                const prop = await r.json();
                return [p.id, prop.state] as [string, string];
              } catch {
                return null;
              }
            }),
          );
          setProposalByPacket(Object.fromEntries(entries.filter(Boolean) as [string, string][]));
        }
        if (evidenceRes.ok) { const d = await evidenceRes.json(); setEvidence(Array.isArray(d) ? d : []); }
        if (analysisRes.ok) setVisionAnalysis(await analysisRes.json());
      } catch {
        // non-fatal
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  // Closed loop: once we know the venue, pull its claims and find the one
  // filed off this incident. Also fetch the venue risk score for the snapshot.
  // Uses the venue-scoped read, so it resolves for the operator (own venue)
  // as well as the broker — killing the post-incident black box on the
  // operator's own surface.
  useEffect(() => {
    const venueId = incident?.venue_id;
    if (!venueId) return;
    let cancelled = false;
    (async () => {
      try {
        const [claimsRes, riskRes] = await Promise.all([
          fetch(`${API_URL}/api/venues/${venueId}/claims`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/venues/${venueId}/risk-score`, { headers: authHeaders() }),
        ]);
        if (!claimsRes.ok) return;
        const rows: IncidentClaim[] = await claimsRes.json();
        const match = rows.find((c) => c.incident_id === id) ?? null;
        if (!cancelled) setClaim(match);
        if (riskRes.ok && !cancelled) setRiskScore(await riskRes.json());
      } catch {
        // non-fatal
      }
    })();
    return () => { cancelled = true; };
  }, [incident?.venue_id, id]);

  // ── Recommendation card helpers ──────────────────────────────────────────
  const primaryPacket = packets[0] as any | undefined;
  const rec = primaryPacket?.claim_recommendation as
    | { should_file: boolean; net_expected_value_usd: number; confidence: number; reasons: string[];
        carrier_payout: number; deductible: number | null; pay_out_of_pocket_cost: number;
        has_active_policy: boolean;
        expected_premium_impact: { annual_delta_usd: number; duration_years: number; cumulative_usd: number } }
    | undefined;
  const isBroker = role === "broker" || role === "admin";
  const proposalState = primaryPacket ? proposalByPacket[primaryPacket.id] : undefined;
  // Is there a claim still in flight? Blocks closing the incident (see backend
  // guard). Claim status is authoritative once a real claim exists; else the
  // proposal state decides.
  const claimInFlight = (() => {
    if (!claimStatus) return false;
    const { proposal, claim } = claimStatus;
    if (claim.exists && claim.status) return !CLOSED_CLAIM_STATUSES.has(claim.status);
    if (proposal.exists && proposal.state) return !RESOLVED_PROPOSAL_STATES.has(proposal.state);
    return false;
  })();
  // Has the recommendation been routed to the broker yet? Two phases, one row:
  // before routing the operator's job is to DECIDE (→ /decision); after routing
  // it's to TRACK (→ /claim-status, which links back to the decision). Showing
  // both doorways at once is the redundancy — gate them on this.
  const proposalRouted = !!claimStatus && (claimStatus.proposal.exists || claimStatus.claim.exists);
  // ─────────────────────────────────────────────────────────────────────────

  // Evidence upload: explicit pending → success/error feedback so the operator
  // knows the file persisted to the vault (matches the compliance-upload pattern).
  const handleEvidenceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`${API_URL}/api/incidents/${id}/evidence`, {
        method: "POST", headers: authHeaders(), body: fd,
      });
      if (!r.ok) throw new Error("upload failed");
      const ev = await fetch(`${API_URL}/api/incidents/${id}/evidence`, { headers: authHeaders() });
      if (ev.ok) { const d = await ev.json(); setEvidence(Array.isArray(d) ? d : []); }
      toastSuccess("Evidence saved to the vault");
    } catch {
      toastError("Upload failed — please try again.");
    } finally {
      setUploading(false);
      e.target.value = ""; // allow re-selecting the same file
    }
  };

  // Deletion is anti-spoliation-safe server-side (audit-logged); still confirm,
  // since the bytes are gone from the operator's view immediately. Opens a
  // destructive ConfirmDialog (was a native window.confirm).
  const handleEvidenceDelete = (evidenceId: string) => setConfirmDeleteId(evidenceId);

  const runEvidenceDelete = async () => {
    if (!confirmDeleteId) return;
    const evidenceId = confirmDeleteId;
    setDeletingId(evidenceId);
    try {
      const r = await fetch(`${API_URL}/api/evidence/${evidenceId}`, {
        method: "DELETE", headers: authHeaders(),
      });
      if (!r.ok) throw new Error("delete failed");
      const ev = await fetch(`${API_URL}/api/incidents/${id}/evidence`, { headers: authHeaders() });
      if (ev.ok) { const d = await ev.json(); setEvidence(Array.isArray(d) ? d : []); }
      setConfirmDeleteId(null);
      toastSuccess("Evidence removed");
    } catch {
      toastError("Couldn't delete — please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  const handleStatusUpdate = async (newStatus: IncidentStatus) => {
    setUpdatingStatus(true);
    try {
      const res = await fetch(`${API_URL}/api/incidents/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) {
        setIncident((prev) => prev ? { ...prev, status: newStatus } : prev);
      } else {
        // Surface the reason (e.g. a claim still in flight blocks closing).
        const body = await res.json().catch(() => null);
        toastError(body?.message || body?.detail?.message || "Couldn't update the incident status.");
      }
    } catch {
      toastError("Couldn't update the incident status.");
    } finally {
      setUpdatingStatus(false);
    }
  };

  // The defense PDF is the operator's tangible "your evidence defends you"
  // artifact. The endpoint is venue-gated and keyed by packet id, so this
  // works for the operator (own venue) as well as the broker.
  const handleDownloadPdf = async (packetId: string) => {
    setDownloadingPdf(packetId);
    try {
      await downloadDefensePackagePdf(packetId);
    } catch {
      // non-fatal — helper throws on non-200; surface nothing destructive
    } finally {
      setDownloadingPdf(null);
    }
  };

  // Single contextual back, rendered once by AppShell (no role gate).
  usePageBack("Back to Incidents", () => router.push("/incidents"));

  if (loading) return <div className="page-loading"><div className="loading-spinner" /></div>;

  return (
    <div className="theme-venue min-h-screen p-xl">
      {/* Back nav is registered via usePageBack and rendered once by AppShell
          (see BackNavContext) — no page-level back here. */}

      {!incident ? (
        <div className="page-empty">
          <AlertTriangle size={48} />
          <h3>Incident not found</h3>
          <p>This incident may have been removed or you may not have access.</p>
        </div>
      ) : (
        <>
          {/* Header */}
          <header className="mb-xl">
            <h1
              className="glow-text mb-md"
              title={incident.summary}
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
            >
              {incidentTitle(incident)}
            </h1>
            <div className="flex items-center gap-lg flex-wrap">
              <span className={`badge ${incident.status === "open" ? "badge-error" : incident.status === "under_review" ? "badge-warning" : incident.status === "closed_archived" ? "badge-neutral" : "badge-success"}`} style={{ fontSize: "0.8rem", padding: "4px 10px" }}>
                {incident.status === "open" && <AlertTriangle size={12} aria-hidden="true" />}
                {incident.status === "under_review" && <Clock size={12} aria-hidden="true" />}
                {incident.status === "closed" && <CheckCircle2 size={12} aria-hidden="true" />}
                {incident.status === "closed_archived" && <Archive size={12} aria-hidden="true" />}
                {statusLabel[incident.status]}
              </span>
              <span className="flex items-center gap-xs text-sm text-secondary"><Calendar size={13} />{new Date(incident.occurred_at).toLocaleString()}</span>
              <span className="flex items-center gap-xs text-sm text-secondary"><MapPin size={13} />{incident.location}</span>
              <span className="flex items-center gap-xs text-sm text-secondary"><User size={13} />{incident.reported_by}</span>
            </div>
          </header>

          <div className="incident-detail-grid">
            {/* Main content */}
            <div className="flex flex-col gap-xl">

              {/* Closed loop: this incident became a real carrier claim */}
              {claim && (() => {
                const reserve = Number(claim.current_reserve);
                const isClosed = ["closed_paid", "closed_denied", "closed_dropped"].includes(claim.status);
                const claimCard = (
                  <div className="flex items-center gap-md p-lg" style={{
                    border: `1px solid ${isClosed ? "var(--border-subtle)" : "var(--accent-ink)"}`,
                    borderRadius: "var(--radius-md)",
                    background: "rgba(200,240,0,0.05)",
                  }}>
                    <Shield size={20} style={{ color: "var(--accent-ink)", flexShrink: 0 }} aria-hidden="true" />
                    <div className="flex-1" style={{ minWidth: 0 }}>
                      <div className="text-xs uppercase tracking-wide" style={{ color: "var(--accent-ink)" }}>
                        Filed as a carrier claim
                      </div>
                      <div className="text-sm mt-xs">
                        {claim.carrier_claim_number ? `Claim ${claim.carrier_claim_number}` : "Claim opened"}
                        {" · "}{claim.coverage_line.toUpperCase()}
                        {" · "}<span style={{ textTransform: "capitalize" }}>{claim.status.replace(/_/g, " ")}</span>
                        {reserve > 0 && ` · reserved $${reserve.toLocaleString()}`}
                      </div>
                    </div>
                    {!isOperator && <ChevronRight size={16} className="text-secondary" aria-hidden="true" />}
                  </div>
                );
                // Operators get a read-only window; brokers can open the claim file.
                return isOperator ? claimCard : (
                  <Link href={`/claims/${claim.id}`} style={{ textDecoration: "none" }} aria-label="Open claim file">
                    {claimCard}
                  </Link>
                );
              })()}

              {/* Description */}
              <div className="card">
                <div className="text-xs uppercase tracking-wide text-secondary mb-md">Description</div>
                <p style={{ lineHeight: 1.7, color: "var(--text-secondary)" }}>{incident.summary}</p>
                <div className="flex gap-sm mt-lg">
                  {incident.injury_observed && <span className="flag-tag flag-danger">Injury Observed</span>}
                  {incident.police_called && <span className="flag-tag flag-warning">Police Called</span>}
                  {incident.ems_called && <span className="flag-tag flag-info">EMS Called</span>}
                </div>
              </div>

              {/* Evidence files */}
              {(evidence.length > 0 || (isOperator && incident && incident.status !== "closed_archived")) && (
                <div className="card">
                  <div className="flex items-center justify-between mb-md" style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}>
                    <div className="text-xs uppercase tracking-wide text-secondary">Attached Evidence</div>
                    {isOperator && incident && incident.status !== "closed_archived" && (
                      <label
                        className="btn btn-secondary"
                        style={{ minHeight: 44, cursor: uploading ? "not-allowed" : "pointer", opacity: uploading ? 0.6 : 1 }}
                        aria-busy={uploading}
                      >
                        {uploading ? (
                          <><div className="loading-spinner loading-spinner-sm" aria-hidden="true" /> Uploading…</>
                        ) : "Add evidence"}
                        <input type="file" hidden disabled={uploading} onChange={handleEvidenceUpload} />
                      </label>
                    )}
                  </div>
                  {evidence.length > 0 && (
                    <div className="flex flex-col gap-sm">
                      {evidence.map((ev) => (
                        <AuthedEvidenceRow
                          key={ev.id}
                          ev={ev}
                          onDelete={isOperator && incident.status !== "closed_archived" ? handleEvidenceDelete : undefined}
                          deleting={deletingId === ev.id}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Vision Analysis */}
              {visionAnalysis && visionAnalysis.total_files > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-md" style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}>
                    <div className="text-xs uppercase tracking-wide text-secondary">AI Evidence Analysis</div>
                    {visionAnalysis.status === "processing" ? (
                      <span className="flex items-center gap-xs text-xs font-mono" style={{ color: "var(--state-warning)" }}>
                        <div className="loading-spinner loading-spinner-sm" /> Analyzing evidence...
                      </span>
                    ) : (
                      <span className="text-xs font-mono px-sm py-xs" style={{
                        color: visionAnalysis.analyses[0]?.corroboration === "CONSISTENT" ? "var(--state-success)" :
                               visionAnalysis.analyses[0]?.corroboration === "CONTRADICTED" ? "var(--state-error)" : "var(--state-warning)",
                        border: `1px solid currentColor`, borderRadius: "var(--radius-sm)"
                      }}>
                        {visionAnalysis.analyses[0]?.corroboration ?? "COMPLETE"}
                      </span>
                    )}
                  </div>
                  {visionAnalysis.analyses.map((a, i) => (
                    <div key={i} className="flex flex-col gap-sm p-sm mb-sm" style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius-sm)", borderLeft: `3px solid ${a.corroboration === "CONSISTENT" ? "var(--state-success)" : a.corroboration === "CONTRADICTED" ? "var(--state-error)" : "var(--state-warning)"}` }}>
                      <div className="flex items-center justify-between" style={{ flexWrap: "wrap", gap: "var(--space-xs)" }}>
                        <span className="text-xs font-mono uppercase text-secondary">{a.analysis_type} analysis</span>
                        <span className="text-xs" style={{ color: "var(--accent-ink)" }}>+{Math.round(a.confidence_delta * 100)}% confidence</span>
                      </div>
                      <p className="text-sm" style={{ lineHeight: 1.6 }}>{a.raw_description}</p>
                      {a.findings?.incident_indicators?.length > 0 && (
                        <div className="flex flex-wrap gap-xs">
                          {a.findings.incident_indicators.map((ind: string, j: number) => (
                            <span key={j} className="text-xs px-sm py-xs font-mono" style={{ background: "rgba(200,240,0,0.06)", border: "1px solid rgba(200,240,0,0.2)", borderRadius: "var(--radius-sm)", color: "var(--accent-ink)" }}>
                              {ind}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── Open questions (AI risk assessment) ───────────────────────────
                  Operator answers; broker marks resolved. Both read the same
                  responses off the packet payload. */}
              {(primaryPacket?.memo?.open_questions?.length ?? 0) > 0 && (() => {
                const responses = byIndex(primaryPacket.open_question_responses);
                return (
                  <div className="card">
                    <h2 className="text-sm font-semibold text-secondary" style={{ margin: "0 0 var(--space-md)" }}>
                      Open questions
                    </h2>
                    <div className="flex flex-col gap-md">
                      {primaryPacket.memo.open_questions.map((q: string, i: number) => {
                        const resp = responses.get(i);
                        const draft = answerDrafts[i] ?? "";
                        return (
                          <div key={i} style={{ paddingBottom: "var(--space-md)", borderBottom: "1px solid var(--border-subtle)" }}>
                            <div className="flex items-start gap-sm" style={{ justifyContent: "space-between" }}>
                              <span className="text-sm" style={{ fontWeight: 600 }}>{q}</span>
                              {resp?.resolved && (
                                <span className="text-xs" style={{ color: "var(--accent-ink)", whiteSpace: "nowrap" }}>
                                  ✓ Resolved
                                </span>
                              )}
                            </div>
                            {resp?.answer && (
                              <div style={{ marginTop: 8, paddingLeft: 10, borderLeft: "2px solid var(--accent-ink)" }}>
                                <div className="text-xs uppercase tracking-wide text-muted">
                                  Answer{resp.answered_by ? ` · ${resp.answered_by}` : ""}
                                </div>
                                <p className="text-sm text-secondary" style={{ margin: "2px 0 0", lineHeight: 1.6 }}>{resp.answer}</p>
                              </div>
                            )}
                            {isOperator && !resp?.resolved && (
                              <div className="flex gap-sm" style={{ marginTop: 10, alignItems: "flex-start" }}>
                                <textarea
                                  value={draft}
                                  onChange={(e) => setAnswerDrafts((d) => ({ ...d, [i]: e.target.value }))}
                                  placeholder={resp?.answer ? "Update your answer…" : "Type your answer…"}
                                  style={{ flex: 1, minHeight: 44, padding: "8px 10px", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)", color: "var(--text-primary)", font: "inherit", resize: "vertical" }}
                                />
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  style={{ minHeight: 44 }}
                                  disabled={!draft.trim() || savingQ === i}
                                  onClick={() => answerQuestion(primaryPacket.id, i, q)}
                                >
                                  {savingQ === i ? "Saving…" : resp?.answer ? "Update" : "Answer"}
                                </button>
                              </div>
                            )}
                            {isBroker && !resp?.resolved && (
                              <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ marginTop: 10, minHeight: 44 }}
                                disabled={savingQ === i}
                                onClick={() => resolveQuestion(primaryPacket.id, i, q)}
                              >
                                {savingQ === i ? "Resolving…" : "Mark resolved"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* ── Recommendation card ───────────────────────────────────────────
                  Broker: full recommendation card (unchanged).
                  Operator: compact link to the dedicated /decision screen. */}
              {rec && (isBroker ? (
                <div className="card">
                  <h2 className="card-title">Claim recommendation</h2>
                  <div className="mb-md">
                    {rec.should_file
                      ? <span className="badge badge-success">Recommendation: File</span>
                      : <span className="badge badge-warning">Recommendation: hold</span>}
                  </div>
                  <div className="flex gap-lg flex-wrap mb-md">
                    <div>
                      <div className="text-muted" style={{ fontSize: "0.75rem" }}>Net expected value</div>
                      <div className="font-mono" style={{ fontSize: "1.1rem" }}>
                        {rec.net_expected_value_usd >= 0 ? "+" : "−"}${Math.abs(rec.net_expected_value_usd).toLocaleString()}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted" style={{ fontSize: "0.75rem" }}>Confidence</div>
                      <div className="font-mono" style={{ fontSize: "1.1rem" }}>{Math.round(rec.confidence * 100)}%</div>
                    </div>
                  </div>
                  {rec.reasons.length > 0 && (
                    <ul style={{ margin: "0 0 var(--space-md) var(--space-md)", padding: 0, fontSize: "0.82rem" }}>
                      {rec.reasons.map((r, i) => (
                        <li key={i} className="text-muted" style={{ marginBottom: "var(--space-xs)" }}>{r}</li>
                      ))}
                    </ul>
                  )}
                  {riskScore && (
                    <div className="text-muted mb-md" style={{ fontSize: "0.82rem" }}>
                      Venue risk{" "}
                      <span className="font-mono">{riskScore.total_score}/100</span>
                      {" · "}tier{" "}
                      <span className="font-mono" style={{ color: `var(--tier-${riskScore.tier.toLowerCase()})`, fontWeight: 700 }}>{riskScore.tier}</span>
                      {" · "}
                      <a href={`/incidents?venue=${incident?.venue_id}`}>recent incidents</a>
                    </div>
                  )}
                  {proposalState ? (
                    <button
                      className="btn btn-primary"
                      onClick={() => router.push(`/underwriter/${primaryPacket.id}`)}
                      aria-label="Review this claim proposal"
                      style={{ minHeight: 44 }}
                    >
                      Review proposal →
                    </button>
                  ) : (
                    <span className="text-muted">No claim proposal to review yet.</span>
                  )}
                </div>
              ) : !proposalRouted ? (
                <Link
                  href={`/incidents/${id}/decision`}
                  className="wq-row"
                  aria-label="View filing decision"
                  style={{ textDecoration: "none" }}
                >
                  <span style={{ flex: 1 }} className="text-sm">
                    {!rec.has_active_policy ? "No active policy" : rec.should_file ? "Worth filing" : "Pay out of pocket"}
                    {" · "}
                    <span className="font-mono">net {rec.net_expected_value_usd >= 0 ? "+" : "−"}${Math.abs(rec.net_expected_value_usd).toLocaleString()}</span>
                  </span>
                  <span className="text-xs text-muted">View decision →</span>
                </Link>
              ) : null)}
              {/* ─────────────────────────────────────────────────────────────────── */}

              {/* ── Claim / status link (operator only) — shown once routed; before
                  routing the decision row above is the operator's single doorway. */}
              {isOperator && claimStatus && proposalRouted && (() => {
                const ps = claimStatus.proposal.state;
                const cstat = claimStatus.claim.status;
                // ADR-0004: a real Claim only exists once the broker files it. Until then it's a routed
                // recommendation, so don't call it a "Claim".
                const isRealClaim = claimStatus.claim.exists || (!!ps && ["filed_with_carrier", "paid", "denied"].includes(ps));
                const resolved = (!!ps && ["paid", "denied"].includes(ps)) || (!!cstat && ["closed_paid", "closed_denied", "closed_dropped"].includes(cstat));
                // This row links to "Where this stands" (claim-status), so label it as status —
                // not "Recommendation", which would collide with the decision row above.
                const noun = isRealClaim ? "Claim" : "Status";
                const current =
                  resolved ? "Resolved"
                  : isRealClaim ? "Filed with carrier"
                  : ps === "approved" ? "Approved — filing"
                  : ps === "rejected_by_broker" ? "Declined by broker"
                  : ps === "needs_more_info" ? "Needs more info"
                  : claimStatus.proposal.exists ? "Awaiting broker"
                  : "Not sent yet";
                return (
                  <Link href={`/incidents/${id}/claim-status`} className="wq-row" aria-label="View claim status" style={{ textDecoration: "none" }}>
                    <span style={{ flex: 1 }} className="text-sm">{noun}: <span style={{ color: "var(--accent-ink)" }}>{current}</span></span>
                    <span className="text-xs text-muted">View →</span>
                  </Link>
                );
              })()}
              {/* ─────────────────────────────────────────────────────────────────── */}

              {/* Insurance Reports */}
              <div>
                <div className="flex items-center gap-sm mb-lg">
                  <FileText size={14} className="text-secondary" />
                  <h2 className="text-sm font-semibold text-secondary" style={{ margin: 0 }}>
                    Insurance Reports
                  </h2>
                  {packets.length > 0 && (
                    <span className="text-xs" style={{ color: "var(--accent-ink)" }}>{packets.length}</span>
                  )}
                </div>

                {packets.length === 0 ? (
                  <div className="card" style={{ textAlign: "center", padding: "var(--space-2xl)" }}>
                    <FileText size={32} style={{ color: "var(--text-muted)", margin: "0 auto var(--space-md)" }} />
                    <div className="text-sm text-secondary">No evidence packets generated yet</div>
                    <div className="text-xs text-muted mt-xs">Packets are generated automatically when incidents are processed</div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-lg">
                    {packets.map((pkt) => (
                      <div key={pkt.id} className="card" style={{ padding: 0, overflow: "hidden" }}>
                        {/* Packet header bar */}
                        <div className="flex justify-between items-center p-md" style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid var(--border-subtle)", flexWrap: "wrap", gap: "var(--space-sm)" }}>
                          <div className="flex items-center gap-sm">
                            <Shield size={14} style={{ color: SEVERITY_COLOR[pkt.risk_signals.severity] }} />
                            <span className="text-xs font-mono uppercase tracking-wide" style={{ color: SEVERITY_COLOR[pkt.risk_signals.severity] }}>
                              {pkt.risk_signals.severity} severity
                            </span>
                            <span className="text-xs text-muted">·</span>
                            <span className="text-xs text-secondary">{pkt.risk_signals.type.replace(/_/g, " ")}</span>
                          </div>
                          <div className="flex items-center gap-md">
                            <span className="text-xs text-secondary">{Math.round(pkt.risk_signals.confidence * 100)}% confidence</span>
                            <span className="text-xs font-mono uppercase px-2 py-0 rounded" style={{
                              color: pkt.status === "approved" ? "var(--state-success)" : pkt.status === "needs_review" ? "var(--state-warning)" : "var(--text-muted)",
                              border: `1px solid ${pkt.status === "approved" ? "var(--state-success)" : pkt.status === "needs_review" ? "var(--state-warning)" : "var(--border-subtle)"}`,
                            }}>
                              {pkt.status.replace(/_/g, " ")}
                            </span>
                            {(() => {
                              const badge = PROPOSAL_BADGE[proposalByPacket[pkt.id]];
                              return badge ? (
                                <Link
                                  href={`/underwriter/${pkt.id}`}
                                  className="text-xs font-mono uppercase px-2 py-0 rounded flex items-center gap-xs"
                                  style={{ color: badge.color, border: `1px solid ${badge.color}`, textDecoration: "none" }}
                                  aria-label={`${badge.label} — open claim proposal`}
                                >
                                  {badge.label}
                                  <ChevronRight size={11} aria-hidden="true" />
                                </Link>
                              ) : null;
                            })()}
                          </div>
                        </div>

                        <div className="p-lg">
                          <p className="text-sm mb-lg" style={{ color: "var(--text-secondary)", lineHeight: 1.7 }}>
                            {pkt.risk_signals.explanation}
                          </p>

                          <button
                            className="btn btn-ghost btn-sm text-xs mb-lg"
                            onClick={() => handleDownloadPdf(pkt.id)}
                            disabled={downloadingPdf === pkt.id}
                            aria-label="Download defense package PDF"
                          >
                            <Download size={13} aria-hidden="true" />
                            {downloadingPdf === pkt.id ? "Preparing PDF…" : "Download defense package (PDF)"}
                          </button>

                          {pkt.risk_signals.citations?.length > 0 && (
                            <>
                              <div className="text-xs font-mono uppercase tracking-wide text-secondary mb-sm flex items-center gap-xs">
                                <ExternalLink size={10} /> Citations ({pkt.risk_signals.citations.length})
                              </div>
                              <div className="flex flex-col gap-sm">
                                {pkt.risk_signals.citations.map((c, i) => (
                                  <div key={i} style={{ padding: "var(--space-sm) var(--space-md)", background: "rgba(255,255,255,0.02)", borderLeft: "2px solid var(--border-subtle)", borderRadius: "0 var(--radius-sm) var(--radius-sm) 0" }}>
                                    <div className="text-xs font-mono text-secondary mb-xs">{c.source_type.toUpperCase()} · {c.source_id}</div>
                                    <p className="text-xs" style={{ color: "var(--text-muted)", lineHeight: 1.5 }}>{c.excerpt}</p>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Sidebar */}
            <div className="flex flex-col gap-lg">
              {/* Status actions — operators only */}
              {isOperator && incident.status !== "closed" && (
                <div className="card">
                  <div className="text-xs uppercase tracking-wide text-secondary mb-md">Actions</div>
                  <div className="flex flex-col gap-sm">
                    {incident.status === "open" && (
                      <button
                        className="btn btn-secondary"
                        disabled={updatingStatus}
                        onClick={() => handleStatusUpdate("under_review")}
                      >
                        <Clock size={14} /> Move to Review
                      </button>
                    )}
                    <button
                      className="btn btn-secondary"
                      disabled={updatingStatus || claimInFlight}
                      onClick={() => handleStatusUpdate("closed")}
                      title={claimInFlight ? "Resolve the claim with your broker before closing." : undefined}
                      style={{
                        color: "var(--state-error)",
                        borderColor: "var(--state-error)",
                        opacity: claimInFlight ? 0.45 : undefined,
                        cursor: claimInFlight ? "not-allowed" : undefined,
                      }}
                    >
                      <CheckCircle2 size={14} /> Close Incident
                    </button>
                    {claimInFlight && (
                      <p className="text-xs text-muted" style={{ margin: 0, lineHeight: 1.5 }}>
                        This incident has a claim with your broker. Resolve it first, then you can close.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Metadata */}
              <div className="card">
                <div className="text-xs uppercase tracking-wide text-secondary mb-md">Details</div>
                <div className="flex flex-col gap-md">
                  <div>
                    <div className="text-xs text-muted mb-xs">Incident ID</div>
                    <div className="text-xs text-secondary">{incident.id}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-xs">Occurred</div>
                    <div className="text-xs text-secondary">{new Date(incident.occurred_at).toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-xs">Location</div>
                    <div className="text-xs text-secondary">{incident.location}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-xs">Reported By</div>
                    <div className="text-xs text-secondary">{incident.reported_by}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-xs">Insurance Reports</div>
                    <div className="text-xs text-secondary">{packets.length}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted mb-xs">Evidence Files</div>
                    <div className="text-xs text-secondary">{evidence.length || "None"}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {confirmDeleteId && (
        <ConfirmDialog
          open
          title="Delete evidence"
          body="This can't be undone — the removal is logged for the audit trail."
          confirmLabel="Delete evidence"
          destructive
          busy={deletingId === confirmDeleteId}
          onConfirm={runEvidenceDelete}
          onClose={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}
