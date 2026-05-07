"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, CheckCircle2, ClipboardCheck, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Packet {
  id: string;
  incident_id: string;
  venue_id: string;
  status: string;
  risk_signals: { type?: string; severity?: string; confidence?: number; explanation?: string };
  action_plan: Array<{ title: string; rationale: string; evidence_needed: string[] }>;
  claims_timeline: Array<{ at: string; label: string; source: string }>;
  memo: { summary?: string; open_questions?: string[]; review_status?: string };
  citation_ids: string[];
  generated_at: string;
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

type DecisionRecord = { decision: string; decided_at: string };

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
  const [packet, setPacket] = useState<Packet | null>(null);
  const [incident, setIncident] = useState<Incident | null>(null);
  const [visionAnalysis, setVisionAnalysis] = useState<{ status: string; analyses: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [decision, setDecision] = useState<DecisionRecord | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    async function load() {
      try {
        const pktRes = await fetch(`${API_URL}/api/packets/${id}`);
        if (!pktRes.ok) return;
        const pkt: Packet = await pktRes.json();
        setPacket(pkt);
        const [incRes, analysisRes] = await Promise.all([
          fetch(`${API_URL}/api/incidents/${pkt.incident_id}`),
          fetch(`${API_URL}/api/incidents/${pkt.incident_id}/evidence-analysis`),
        ]);
        if (incRes.ok) setIncident(await incRes.json());
        if (analysisRes.ok) setVisionAnalysis(await analysisRes.json());
      } finally {
        setLoading(false);
      }
    }
    if (id) load();
  }, [id]);

  async function submitDecision(dec: string) {
    if (!packet) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/packets/${packet.id}/review-decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewer_id: "uw-demo-reviewer", decision: dec, notes: notes || null }),
      });
      if (res.ok) {
        const result = await res.json();
        setDecision({ decision: dec, decided_at: result.decided_at });
      }
    } finally {
      setSubmitting(false);
    }
  }

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
            <p className="page-subtitle">Report · {new Date(packet.generated_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>
        </div>
        <div
          className="text-xs font-mono px-md py-sm"
          style={{ border: `1px solid ${SEVERITY_COLOR[severity]}`, color: SEVERITY_COLOR[severity], borderRadius: "var(--radius-sm)" }}
        >
          {severity.toUpperCase()} EXPOSURE · {confidence}% CONFIDENCE
        </div>
      </header>

      <div className="grid grid-cols-3 gap-xl">
        {/* Left: Incident facts */}
        <div className="flex flex-col gap-lg">
          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Incident</h2>
            {incident ? (
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
            ) : (
              <p className="text-sm text-secondary">Incident data unavailable.</p>
            )}
          </section>

          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Required Actions</h2>
            <div className="flex flex-col gap-md">
              {packet.action_plan.length > 0 ? packet.action_plan.map((action, i) => (
                <div key={i} className="flex gap-md">
                  <ClipboardCheck size={16} className="text-secondary mt-xs flex-shrink-0" />
                  <div>
                    <p className="text-sm font-semibold mb-xs">{action.title}</p>
                    <p className="text-xs text-secondary mb-xs">{action.rationale}</p>
                    {action.evidence_needed.length > 0 && (
                      <p className="text-xs" style={{ color: "var(--brand-primary)" }}>{action.evidence_needed.join(" · ")}</p>
                    )}
                  </div>
                </div>
              )) : <p className="text-sm text-secondary">No actions required.</p>}
            </div>
          </section>
        </div>

        {/* Center: Risk analysis */}
        <div className="flex flex-col gap-lg">
          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Risk Signal</h2>
            <div className="flex gap-lg items-start">
              <div className="flex-1">
                <span
                  className="inline-block text-xs font-mono font-bold uppercase px-sm py-xs mb-md"
                  style={{ background: `${SEVERITY_COLOR[severity]}22`, color: SEVERITY_COLOR[severity], border: `1px solid ${SEVERITY_COLOR[severity]}` }}
                >
                  {severity} exposure
                </span>
                <p className="text-sm leading-relaxed">{packet.risk_signals?.explanation ?? "No explanation available."}</p>
              </div>
              <div className="text-center flex-shrink-0">
                <div className="text-4xl font-bold font-mono" style={{ color: "var(--brand-primary)" }}>{confidence}%</div>
                <div className="text-xs text-secondary uppercase tracking-wide">confidence</div>
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Underwriting Memo</h2>
            <p className="text-sm leading-relaxed mb-lg">{packet.memo?.summary ?? "No memo available."}</p>
            {(packet.memo?.open_questions?.length ?? 0) > 0 && (
              <div>
                <p className="text-xs uppercase tracking-wide text-secondary mb-md">Open Questions</p>
                <div className="flex flex-col gap-sm">
                  {packet.memo.open_questions!.map((q, i) => (
                    <label key={i} className="flex items-start gap-sm cursor-pointer">
                      <input type="checkbox" className="mt-1" />
                      <span className="text-sm text-secondary">{q}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Vision Analysis */}
          {visionAnalysis && visionAnalysis.analyses.length > 0 && (
            <section className="card">
              <div className="flex items-center justify-between mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>
                <h2 className="text-xs font-mono uppercase tracking-wide text-secondary">Visual Evidence Analysis</h2>
                {visionAnalysis.analyses[0]?.corroboration && (
                  <span className="text-xs font-mono px-sm py-xs font-bold" style={{
                    background: visionAnalysis.analyses[0].corroboration === "CONSISTENT" ? "rgba(212,255,0,0.12)" : visionAnalysis.analyses[0].corroboration === "CONTRADICTED" ? "rgba(255,60,60,0.12)" : "rgba(255,153,0,0.12)",
                    color: visionAnalysis.analyses[0].corroboration === "CONSISTENT" ? "var(--brand-primary)" : visionAnalysis.analyses[0].corroboration === "CONTRADICTED" ? "var(--state-error)" : "var(--state-warning)",
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
                    <span className="text-xs font-mono" style={{ color: "var(--brand-primary)" }}>+{Math.round(a.confidence_delta * 100)}% confidence</span>
                  </div>
                  <p className="text-sm leading-relaxed">{a.raw_description}</p>
                  {a.findings?.incident_indicators?.length > 0 && (
                    <div className="flex flex-wrap gap-xs mt-xs">
                      {a.findings.incident_indicators.map((ind: string, j: number) => (
                        <span key={j} className="text-xs px-sm py-xs font-mono" style={{ background: "rgba(212,255,0,0.06)", border: "1px solid rgba(212,255,0,0.2)", borderRadius: "var(--radius-sm)", color: "var(--brand-primary)" }}>
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

          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Claims Timeline</h2>
            <div className="flex flex-col gap-sm">
              {packet.claims_timeline.length > 0 ? packet.claims_timeline.map((event, i) => (
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
          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Review Decision</h2>
            {decision ? (
              <div className="flex items-center gap-md p-md" style={{ border: `1px solid ${decision.decision === "approved" ? "var(--brand-primary)" : "var(--state-error)"}`, borderRadius: "var(--radius-sm)" }}>
                {decision.decision === "approved" ? <ShieldCheck size={20} style={{ color: "var(--brand-primary)" }} /> : <LockKeyhole size={20} style={{ color: "var(--state-error)" }} />}
                <div>
                  <p className="font-semibold capitalize">{decision.decision.replace(/_/g, " ")}</p>
                  <p className="text-xs text-secondary">{new Date(decision.decided_at).toLocaleString()}</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-sm">
                <div>
                  <label className="text-xs uppercase tracking-wide text-secondary block mb-xs">Notes (optional)</label>
                  <textarea
                    className="w-full text-sm p-sm"
                    rows={3}
                    placeholder="Add internal notes..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)", resize: "none" }}
                  />
                </div>
                <button
                  className="btn btn-primary w-full flex items-center justify-center gap-sm"
                  onClick={() => submitDecision("approved")}
                  disabled={submitting}
                >
                  <CheckCircle2 size={16} />
                  {submitting ? "Recording..." : "Approve"}
                </button>
                <button
                  className="btn w-full flex items-center justify-center gap-sm"
                  onClick={() => submitDecision("needs_more_info")}
                  disabled={submitting}
                  style={{ border: "1px solid var(--state-warning)", color: "var(--state-warning)", background: "none" }}
                >
                  <AlertTriangle size={16} />
                  Request More Info
                </button>
                <button
                  className="btn w-full flex items-center justify-center gap-sm"
                  onClick={() => submitDecision("blocked")}
                  disabled={submitting}
                  style={{ border: "1px solid var(--state-error)", color: "var(--state-error)", background: "none" }}
                >
                  <LockKeyhole size={16} />
                  Block
                </button>
              </div>
            )}
          </section>

          <section className="card">
            <h2 className="text-xs font-mono uppercase tracking-wide text-secondary mb-lg" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "var(--space-sm)" }}>Evidence Summary</h2>
            <div className="flex gap-md mb-md">
              <div className="flex-1 text-center p-md" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                <div className="text-2xl font-bold font-mono" style={{ color: "var(--brand-primary)" }}>{packet.citation_ids.length}</div>
                <div className="text-xs text-secondary uppercase tracking-wide">Citations</div>
              </div>
              <div className="flex-1 text-center p-md" style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                <div className="text-2xl font-bold font-mono" style={{ color: "var(--brand-primary)" }}>{packet.claims_timeline.length}</div>
                <div className="text-xs text-secondary uppercase tracking-wide">Events</div>
              </div>
            </div>
            <p className="text-xs text-secondary font-mono">Report ID: {packet.id.slice(0, 16)}…</p>
          </section>
        </div>
      </div>
    </div>
  );
}
