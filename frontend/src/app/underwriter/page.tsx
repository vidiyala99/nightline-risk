"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, ClipboardCheck, FileSearch, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { buildEvidenceGroups, classifyPacketLifecycle, summarizeEvidence } from "../../lib/incidentView.mjs";

type Citation = { source_id: string; source_type: string; excerpt: string; usedBy?: string };
type Lifecycle = "draft" | "processing" | "needs_review" | "approved" | "blocked";

type IncidentPacket = {
  incident: { id: string; venue_id: string; occurred_at: string; location: string; summary: string };
  risk_signal: { type: string; severity: string; confidence: number; explanation: string; review_status: string; citations: Citation[] };
  action_plan: Array<{ title: string; rationale: string; evidence_needed: string[] }>;
  claims_timeline: Array<{ at: string; label: string; source: string }>;
  underwriting_memo: { summary: string; open_questions: string[]; review_status: string; citations: Citation[] };
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

const demoIncident = {
  occurred_at: "2026-05-02T23:13:00Z",
  location: "rear bar",
  summary: "Two patrons began fighting near the rear bar during a sold-out DJ event.",
  reported_by: "shift-lead",
  injury_observed: false,
  police_called: false,
  ems_called: false,
};

const lifecycleLabels: Record<Lifecycle, string> = {
  draft: "Draft",
  processing: "Processing",
  needs_review: "Needs review",
  approved: "Approved",
  blocked: "Blocked",
};

const goldStandardScenarios = [
  {
    id: "SCENARIO-001-DELAYED-BRAWL",
    name: "DELAYED_BRAWL_INCIDENT",
    description: "Physical struggle with delayed security response (>40s).",
    data: {
      incident: { id: "EV-001", venue_id: "elsewhere-brooklyn", occurred_at: "2026-05-02T23:14:00Z", location: "rear bar", summary: "A physical struggle occurs near the rear bar. Security response is delayed by over 40 seconds." },
      risk_signal: { type: "negligent_security", severity: "high", confidence: 0.92, explanation: "Security intervention was not detected until 42 seconds after aggression spike. This exceeds the 30-second 'Duty of Care' threshold.", review_status: "needs_review", citations: [] },
      action_plan: [{ title: "ESCALATE TO CARRIER", rationale: "Response latency violates Section III of the policy.", evidence_needed: ["Video evidence (EV-CAM-001)", "Staff logs"] }],
      claims_timeline: [
        { at: "2026-05-02T23:14:00Z", label: "Aggression detected at Rear Bar (Confidence: 0.92)", source: "stream:camera-rear-bar" },
        { at: "2026-05-02T23:14:42Z", label: "Security intervention detected (Response delta: 42s)", source: "stream:camera-rear-bar" }
      ],
      underwriting_memo: { summary: "High-risk incident detected. Security response latency represents a significant liability exposure for Assault & Battery claims.", open_questions: ["WHY WAS SECURITY DELAYED?", "WAS THE BAR AREA ADEQUATELY STAFFED?"], review_status: "needs_review", citations: [] }
    }
  },
  {
    id: "SCENARIO-002-AFTER-HOURS-LIQUOR",
    name: "AFTER_HOURS_LIQUOR_SALE",
    description: "Spirits sale occurring after 4:00 AM legal cutoff.",
    data: {
      incident: { id: "EV-002", venue_id: "elsewhere-brooklyn", occurred_at: "2026-05-03T04:05:12Z", location: "bar-primary", summary: "Multiple sales of high-ABV spirits occur after the 4:00 AM legal cutoff." },
      risk_signal: { type: "liquor_liability", severity: "critical", confidence: 0.98, explanation: "POS logs indicate sale of spirits at 04:05:12 AM, violating the 04:00 AM legal service cutoff.", review_status: "needs_review", citations: [] },
      action_plan: [{ title: "IMMEDIATE COMPLIANCE REVIEW", rationale: "Dram Shop violation identified.", evidence_needed: ["POS Audit", "Staff interview"] }],
      claims_timeline: [{ at: "2026-05-03T04:05:12Z", label: "Sale of 4x Tequila Shot recorded at POS", source: "stream:pos-primary" }],
      underwriting_memo: { summary: "Critical Liquor Liability violation. Violation of Section 1.2 regarding service hour compliance.", open_questions: ["WAS THIS AN ISOLATED INCIDENT?", "IS THE STAFF TRAINED ON LOCAL CUTOFFS?"], review_status: "needs_review", citations: [] }
    }
  },
  {
    id: "SCENARIO-003-PROACTIVE-MITIGATION",
    name: "PROACTIVE_RISK_MITIGATION",
    description: "High crowd density mitigated by proactive water and security presence.",
    data: {
      incident: { id: "EV-003", venue_id: "elsewhere-brooklyn", occurred_at: "2026-05-03T01:30:00Z", location: "dance-floor", summary: "High crowd density is detected, but POS data shows proactive water distribution." },
      risk_signal: { type: "crowd_management", severity: "low", confidence: 0.95, explanation: "Crowd density elevated, but mitigated by confirmed security presence and free water distribution.", review_status: "approved", citations: [] },
      action_plan: [{ title: "DOCUMENT AS BEST PRACTICE", rationale: "Demonstrates high Duty of Care.", evidence_needed: ["Archive POS and Camera metadata"] }],
      claims_timeline: [
        { at: "2026-05-03T01:30:00Z", label: "Security presence confirmed on Dance Floor", source: "stream:camera-dance-floor" },
        { at: "2026-05-03T01:32:00Z", label: "10x Free Water distribution recorded", source: "stream:pos-primary" }
      ],
      underwriting_memo: { summary: "Incident demonstrates proactive risk management. No premium action recommended.", open_questions: [], review_status: "approved", citations: [] }
    }
  }
];

type DecisionRecord = { decision: string; decided_at: string };

export default function UnderwriterPage() {
  const [packet, setPacket] = useState<IncidentPacket | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Lifecycle>("needs_review");
  const [selectedScenario, setSelectedScenario] = useState<string>("");
  const [packetId, setPacketId] = useState<string | null>(null);
  const [reviewNotes, setReviewNotes] = useState("");
  const [reviewOverride, setReviewOverride] = useState("");
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [decisionRecorded, setDecisionRecorded] = useState<DecisionRecord | null>(null);

  const activePacket = packet ?? getMockDataForTab(activeTab);

  async function handleScenarioChange(scenarioId: string) {
    setSelectedScenario(scenarioId);
    setPacketId(null);
    setDecisionRecorded(null);
    if (!scenarioId) {
      setPacket(null);
      return;
    }
    const scenario = goldStandardScenarios.find(s => s.id === scenarioId);
    if (scenario) {
      setLoading(true);
      setTimeout(() => {
        setPacket(scenario.data as any);
        setLoading(false);
      }, 800);
    }
  }

  const evidenceSummary = useMemo(() => summarizeEvidence(activePacket), [activePacket]);
  const evidenceGroups = useMemo(() => buildEvidenceGroups(activePacket), [activePacket]);

  async function runIncidentFlow() {
    setLoading(true);
    setError(null);
    setPacketId(null);
    setDecisionRecorded(null);
    try {
      const response = await fetch(`${API_URL}/api/venues/elsewhere-brooklyn/incidents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(demoIncident),
      });
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const data = await response.json();
      setPacket(data);
      setActiveTab("needs_review");
      // Resolve packet ID so review decisions can be recorded
      const incidentId = data.incident?.id;
      if (incidentId) {
        try {
          const pktsRes = await fetch(`${API_URL}/api/incidents/${incidentId}/packets`);
          if (pktsRes.ok) {
            const pkts = await pktsRes.json();
            if (pkts.length > 0) setPacketId(pkts[0].id);
          }
        } catch {
          // packet ID lookup is best-effort
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backend unavailable. Showing deterministic demo packet.");
    } finally {
      setLoading(false);
    }
  }

  async function submitReviewDecision(decision: string) {
    if (!packetId) return;
    setSubmittingDecision(true);
    try {
      const res = await fetch(`${API_URL}/api/packets/${packetId}/review-decisions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewer_id: "uw-demo-reviewer",
          decision,
          override_reason: reviewOverride || null,
          notes: reviewNotes || null,
        }),
      });
      if (!res.ok) throw new Error(`Decision submit failed: ${res.status}`);
      const result = await res.json();
      setDecisionRecorded({ decision, decided_at: result.decided_at });
      setActiveTab(decision === "approved" ? "approved" : decision === "blocked" ? "blocked" : "needs_review");
    } catch (err) {
      console.error("Review decision error:", err);
    } finally {
      setSubmittingDecision(false);
    }
  }

  return (
    <div className="theme-underwriter min-h-screen p-xl">
      <header className="flex justify-between items-end mb-xl border-b border-dim pb-sm">
        <div>
          <div className="data-label mb-xs text-secondary">SYSTEM.ID // UNDERWRITER TERMINAL V1</div>
          <h1 className="text-3xl font-mono critical-data">UW_TERMINAL_V1</h1>
          <p className="text-sm font-mono mt-xs text-secondary max-w-prose">EVIDENCE-FIRST CARRIER REVIEW FOR LIQUOR-LIABILITY EXPOSURE, CLAIMS DEFENSIBILITY, AND RENEWAL ACTION.</p>
        </div>
        <div className="flex items-center gap-md">
          <div className="flex flex-col gap-xs mr-md">
            <span className="data-label">PHASE_1_SIMULATION</span>
            <select
              className="bg-transparent border border-dim text-secondary font-mono text-xs p-1 outline-none hover:border-accent"
              value={selectedScenario}
              onChange={(e) => handleScenarioChange(e.target.value)}
            >
              <option value="">-- SELECT SCENARIO --</option>
              {goldStandardScenarios.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="text-right border-r border-dim pr-md">
            <div className="data-label">STATUS</div>
            <div className="data-value text-accent font-bold">ONLINE // DEMO_DATA</div>
          </div>
          <button className="btn btn-accent-outline" onClick={runIncidentFlow} disabled={loading}>
            {loading ? <RefreshCw size={16} className="spin-icon" /> : <FileSearch size={16} />}
            <span className="font-mono uppercase ml-xs">{loading ? "PROCESSING" : "REFRESH"}</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="workbench-panel p-md mb-lg border-warning flex items-start gap-md" role="status">
          <AlertTriangle size={24} className="text-warning mt-xs" />
          <div>
            <strong className="font-mono text-warning uppercase block mb-xs">BACKEND OFFLINE FALLBACK</strong>
            <span className="font-mono text-secondary text-sm">{error}</span>
          </div>
        </div>
      )}

      <section className="mb-lg border-b border-dim" aria-label="Packet lifecycle navigation">
        <div className="flex">
          {(Object.keys(lifecycleLabels) as Lifecycle[]).map((stage) => {
             const isActive = stage === activeTab;
             return (
               <button 
                 key={stage} 
                 className={`px-lg py-md text-center font-mono text-sm uppercase whitespace-nowrap transition-all border-b-2 outline-none cursor-pointer ${
                   isActive 
                     ? "border-primary text-primary bg-primary-glow tab-active-glow"
                     : "border-transparent text-secondary hover:text-primary hover:bg-surface-dim"
                 }`}
                 onClick={() => {
                   setPacket(null); // Clear live packet when switching demo tabs
                   setActiveTab(stage);
                 }}
               >
                 {isActive ? `[ ${lifecycleLabels[stage]} ]` : lifecycleLabels[stage]}
               </button>
             );
          })}
        </div>
      </section>

      <main className="grid grid-cols-12 gap-lg items-start">
        <aside className="col-span-3 flex flex-col gap-lg">
          <Panel title="CONTEXT_RAIL">
            <div className="flex flex-col gap-sm">
              <DataRow label="VENUE" value="ELSEWHERE BROOKLYN" />
              <DataRow label="ROLE" value="CARRIER UNDERWRITER" />
              <DataRow label="POLICY" value="TSR-LIQ-2026-0442" />
              <DataRow label="CAPACITY" value="742 / 800" critical />
              <DataRow label="OWNER" value="M. RAO" />
              <DataRow label="LAST_UPDATED" value="MAY 5, 2026 02:12 ET" />
            </div>
          </Panel>

          <Panel title="INCIDENT_FACTS">
            <div className="flex flex-col gap-md">
              <Fact label="OBSERVED_FACT" value={activePacket.incident.summary} />
              <Fact label="LOCATION" value={activePacket.incident.location} />
              <Fact label="SOURCE" value="VENUE:INCIDENT-REPORT" />
              <Fact label="HUMAN_REVIEW" value={activePacket.underwriting_memo.review_status.replace("_", " ")} />
            </div>
          </Panel>
        </aside>

        <section className="col-span-6 flex flex-col gap-lg">
          <Panel title="RISK_SIGNAL">
            <div className="flex gap-lg items-center">
              <div className="flex-1">
                <span className="inline-block px-2 py-1 mb-md font-mono text-xs font-bold uppercase bg-error-dim text-error border border-error">
                  {activePacket.risk_signal.severity} EXPOSURE
                </span>
                <p className="font-mono text-sm text-primary leading-relaxed">{activePacket.risk_signal.explanation}</p>
              </div>
              <div className="flex flex-col items-center justify-center p-md border border-dim" style={{ minWidth: '120px' }}>
                <span className="text-4xl font-mono critical-data mb-xs">{Math.round(activePacket.risk_signal.confidence * 100)}%</span>
                <small className="data-label">CONFIDENCE</small>
              </div>
            </div>
          </Panel>

          <Panel title="UNDERWRITING_MEMO">
            <p className="font-mono text-sm text-primary leading-relaxed mb-lg border-b border-dim pb-md">{activePacket.underwriting_memo.summary}</p>
            <div className="mt-md">
              <h3 className="data-label mb-md">OPEN_REVIEW_QUESTIONS</h3>
              {activePacket.underwriting_memo.open_questions.length > 0 ? (
                <div className="flex flex-col gap-sm">
                  {activePacket.underwriting_memo.open_questions.map((question) => (
                    <label key={question} className="flex items-start gap-md cursor-pointer group">
                      <input type="checkbox" className="mt-1 w-4 h-4 bg-transparent border border-accent accent-primary" />
                      <span className="font-mono text-sm text-secondary group-hover:text-primary transition-colors">{question}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <span className="font-mono text-sm text-secondary">None</span>
              )}
            </div>
          </Panel>

          <Panel title="CLAIMS_TIMELINE">
            <div className="flex flex-col gap-sm">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-dim">
                    <th className="pb-xs data-label w-24">TIME (Z)</th>
                    <th className="pb-xs data-label">EVENT_LABEL</th>
                    <th className="pb-xs data-label text-right">SOURCE</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {activePacket.claims_timeline.map((event) => (
                    <tr key={`${event.at}-${event.source}`} className="border-b border-darker">
                      <td className="py-sm text-secondary">{event.at.split("T")[1].replace("Z", "")}</td>
                      <td className="py-sm text-primary truncate pr-md" style={{ maxWidth: '300px' }} title={event.label}>{event.label}</td>
                      <td className="py-sm text-secondary text-right">{event.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </section>

        <aside className="col-span-3 flex flex-col gap-lg">
          <Panel title="EVIDENCE_INDEX">
            <div className="grid grid-cols-3 gap-sm mb-lg">
              <Metric value={evidenceSummary.citationCount} label="CITATIONS" />
              <Metric value={evidenceSummary.sourceTypes.length} label="SOURCES" />
              <Metric value={evidenceSummary.hasStreamingContext ? "YES" : "NO"} label="STREAM" />
            </div>
            <div className="flex flex-col gap-md">
              {evidenceGroups.map((group) => (
                <details key={group.sourceType} open className="group">
                  <summary className="data-label cursor-pointer mb-sm hover:text-primary transition-colors">{group.sourceType}</summary>
                  <div className="flex flex-col gap-sm pl-xs border-l border-dim ml-xs">
                    {group.citations.map((citation: Citation) => (
                      <div key={`${citation.source_type}-${citation.source_id}`} className="p-sm bg-surface-dim border border-transparent hover:border-dim">
                        <span className="font-mono text-xs text-secondary block mb-xs">{citation.source_id}</span>
                        <p className="font-mono text-xs text-primary leading-relaxed mb-xs line-clamp-3" title={citation.excerpt}>{citation.excerpt}</p>
                        <small className="font-mono text-xxs text-tertiary">USED_BY: {citation.usedBy}</small>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
              {evidenceGroups.length === 0 && (
                <span className="font-mono text-sm text-secondary">No evidence collected yet.</span>
              )}
            </div>
          </Panel>

          <Panel title="REQUIRED_ACTIONS">
            <div className="flex flex-col gap-md">
              {activePacket.action_plan.map((action) => (
                <div key={action.title} className="flex gap-md p-sm border border-dim">
                  <ClipboardCheck size={16} className="text-secondary mt-xs" />
                  <div>
                    <h3 className="font-mono text-sm text-primary font-bold mb-xs">{action.title}</h3>
                    <p className="font-mono text-xs text-secondary mb-sm">{action.rationale}</p>
                    <small className="font-mono text-xxs text-accent block">{action.evidence_needed.join(" // ")}</small>
                  </div>
                </div>
              ))}
              {activePacket.action_plan.length === 0 && (
                <span className="font-mono text-sm text-secondary">No pending actions.</span>
              )}
            </div>
          </Panel>

          {/* Review Decision — only visible when a real backend packet is loaded */}
          {packetId && (
            <Panel title="REVIEW_DECISION">
              {decisionRecorded ? (
                <div className="flex flex-col gap-sm">
                  <div className={`flex items-center gap-sm p-md border ${decisionRecorded.decision === "approved" ? "border-success bg-[rgba(212,255,0,0.05)]" : decisionRecorded.decision === "blocked" ? "border-error bg-error-dim" : "border-warning bg-warning-dim"}`}>
                    {decisionRecorded.decision === "approved"
                      ? <ShieldCheck size={18} className="text-success flex-shrink-0" />
                      : decisionRecorded.decision === "blocked"
                      ? <LockKeyhole size={18} className="text-error flex-shrink-0" />
                      : <AlertTriangle size={18} className="text-warning flex-shrink-0" />
                    }
                    <div>
                      <span className="font-mono text-sm font-bold text-primary uppercase block">{decisionRecorded.decision.replace("_", " ")}</span>
                      <span className="font-mono text-xxs text-secondary">
                        RECORDED // {new Date(decisionRecorded.decided_at).toISOString().replace("T", " ").slice(0, 19)} Z
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-xxs text-secondary">PKT: {packetId}</span>
                </div>
              ) : (
                <div className="flex flex-col gap-md">
                  <div className="flex flex-col gap-xs">
                    <label className="data-label">OVERRIDE_REASON (optional)</label>
                    <textarea
                      className="bg-transparent border border-dim font-mono text-xs text-primary p-sm outline-none resize-none"
                      rows={2}
                      placeholder="Enter reason if overriding system recommendation..."
                      value={reviewOverride}
                      onChange={(e) => setReviewOverride(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-xs">
                    <label className="data-label">NOTES (optional)</label>
                    <textarea
                      className="bg-transparent border border-dim font-mono text-xs text-primary p-sm outline-none resize-none"
                      rows={2}
                      placeholder="Internal notes for audit trail..."
                      value={reviewNotes}
                      onChange={(e) => setReviewNotes(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-sm">
                    <button
                      className="flex items-center gap-sm p-sm border border-success bg-transparent text-success font-mono text-xs uppercase font-bold cursor-pointer transition-colors hover:bg-[rgba(212,255,0,0.08)]"
                      onClick={() => submitReviewDecision("approved")}
                      disabled={submittingDecision}
                    >
                      <CheckCircle2 size={14} />
                      {submittingDecision ? "RECORDING..." : "APPROVE PACKET"}
                    </button>
                    <button
                      className="flex items-center gap-sm p-sm border border-warning bg-transparent text-warning font-mono text-xs uppercase font-bold cursor-pointer transition-colors"
                      onClick={() => submitReviewDecision("needs_more_info")}
                      disabled={submittingDecision}
                    >
                      <AlertTriangle size={14} />
                      REQUEST MORE INFO
                    </button>
                    <button
                      className="flex items-center gap-sm p-sm border border-error bg-transparent text-error font-mono text-xs uppercase font-bold cursor-pointer transition-colors"
                      onClick={() => submitReviewDecision("blocked")}
                      disabled={submittingDecision}
                    >
                      <LockKeyhole size={14} />
                      BLOCK PACKET
                    </button>
                  </div>
                  <span className="font-mono text-xxs text-secondary">PKT_ID: {packetId}</span>
                </div>
              )}
            </Panel>
          )}
        </aside>
      </main>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="workbench-panel p-lg">
      <h2 className="data-label mb-lg border-b border-dim pb-xs">{title}</h2>
      {children}
    </section>
  );
}

function DataRow({ label, value, critical = false }: { label: string; value: string; critical?: boolean }) {
  return (
    <div className="flex justify-between items-baseline border-b border-darker pb-xs">
      <span className="data-label">{label}</span>
      <span className={critical ? "critical-data" : "data-value"}>{value}</span>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l-2 border-secondary pl-sm">
      <span className="data-label block mb-xs">{label}</span>
      <p className="font-mono text-sm text-primary uppercase">{value}</p>
    </div>
  );
}

function Metric({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center p-sm border border-dim">
      <strong className="font-mono text-lg text-secondary mb-xs">{value}</strong>
      <span className="data-label text-xxs text-center">{label}</span>
    </div>
  );
}

function getMockDataForTab(tab: Lifecycle): IncidentPacket {
  const basePacket = {
    incident: { id: "preview", venue_id: "elsewhere-brooklyn", occurred_at: demoIncident.occurred_at, location: demoIncident.location, summary: demoIncident.summary },
    claims_timeline: [
      { at: "2026-05-02T23:10:00Z", label: "POS aggregate shows normal transaction volume before the brawl.", source: "stream:pos" },
      { at: "2026-05-02T23:12:00Z", label: "Door count recorded 742 guests against 800 capacity.", source: "stream:door-count" },
      { at: "2026-05-02T23:13:00Z", label: "Camera metadata flagged a 90-second altercation-like motion event near rear bar.", source: "stream:camera-rear-bar-clip" },
      { at: "2026-05-02T23:13:00Z", label: "Incident logged by shift lead after two patrons began fighting.", source: "venue:incident-report" },
    ],
  };

  switch (tab) {
    case "draft":
      return {
        ...basePacket,
        risk_signal: {
          type: "pending_analysis", severity: "unknown", confidence: 0.0, explanation: "Awaiting deterministic evidence extraction and rubric scoring.", review_status: "draft", citations: []
        },
        action_plan: [],
        underwriting_memo: { summary: "Awaiting generation...", open_questions: [], review_status: "draft", citations: [] }
      };
    case "processing":
      return {
        ...basePacket,
        risk_signal: {
          type: "altercation_event", severity: "calculating...", confidence: 0.45, explanation: "Processing camera feeds and matching against policy TSR-LIQ-2026-0442.", review_status: "processing", citations: []
        },
        action_plan: [],
        underwriting_memo: { summary: "Extracting timeline events and checking compliance status...", open_questions: [], review_status: "processing", citations: [] }
      };
    case "needs_review":
      return {
        ...basePacket,
        risk_signal: {
          type: "altercation_event", severity: "medium", confidence: 0.78, explanation: "A brawl creates liquor-liability and claims-defense exposure, but staffing and capacity controls may mitigate premium impact if evidence is preserved.", review_status: "needs_review", citations: [
            { source_id: "policy-2026-liquor-liability", source_type: "policy", excerpt: "Liquor liability policy requires documented security response and incident records for altercations." }
          ]
        },
        action_plan: [
          { title: "PRESERVE INCIDENT EVIDENCE", rationale: "A clean evidence package makes the event defensible if a claim appears later.", evidence_needed: ["Reviewed rear-bar clip 23:10-23:18", "Completed witness/contact section", "Security lead narrative"] },
          { title: "COMPLETE MANAGER FOLLOW-UP", rationale: "Underwriters value contemporaneous records over reconstructed notes.", evidence_needed: ["Manager sign-off", "Police/EMS confirmation fields", "Removal outcome"] }
        ],
        underwriting_memo: {
          summary: "Brawl incident at rear bar requires underwriter review. Current evidence shows the incident was logged promptly, camera metadata identified the relevant clip window, and staffing/capacity controls may mitigate the underwriting impact.",
          open_questions: ["WAS SERVICE STOPPED FOR INVOLVED PATRONS?", "WERE WITNESS NAMES COLLECTED BEFORE CLOSE?", "HAS THE REAR-BAR CLIP BEEN PRESERVED?"], review_status: "needs_review", citations: [
            { source_id: "stream:camera-rear-bar-clip", source_type: "stream", excerpt: "Camera metadata flagged a short altercation-like event near rear bar; human review is required." },
            { source_id: "staffing-2026-05-02", source_type: "staffing", excerpt: "Security shift log confirms 6 floor staff and 4 licensed security guards scheduled." }
          ]
        }
      };
    case "approved":
      return {
        ...basePacket,
        risk_signal: {
          type: "altercation_event", severity: "low", confidence: 0.95, explanation: "Evidence preserved. Incident deemed highly defensible. No immediate premium action required.", review_status: "approved", citations: []
        },
        action_plan: [
          { title: "ARCHIVE TO CARRIER RECORD", rationale: "Evidence successfully gathered and verified by underwriter.", evidence_needed: ["All items complete"] }
        ],
        underwriting_memo: { summary: "Underwriter M. Rao verified all required evidence. Video clip confirms staff intervened within 45 seconds. Manager sign-off completed. File marked closed and defensible.", open_questions: [], review_status: "approved", citations: [] }
      };
    case "blocked":
      return {
        ...basePacket,
        risk_signal: {
          type: "altercation_event", severity: "high", confidence: 0.88, explanation: "CRITICAL FAILURE: Venue management failed to upload requested camera footage within the 72-hour window. Claim defensibility compromised.", review_status: "blocked", citations: []
        },
        action_plan: [
          { title: "ESCALATE TO BROKER", rationale: "Missing evidence violates policy terms.", evidence_needed: ["Require immediate broker contact with venue owner."] }
        ],
        underwriting_memo: { summary: "Packet blocked. Missing camera footage. Risk of non-renewal flag if not resolved in 24 hours.", open_questions: ["Why was footage not preserved?"], review_status: "blocked", citations: [] }
      };
  }
}
