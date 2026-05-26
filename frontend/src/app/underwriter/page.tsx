"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  FileSearch,
  LockKeyhole,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { toastError, toastSuccess } from "@/lib/toast";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type PacketStatus = "needs_review" | "approved" | "blocked" | "draft" | "processing";

interface ExpectedPayout {
  low_usd?: number;
  median_usd?: number;
  high_usd?: number;
}
interface ClaimRecommendation {
  should_file?: boolean;
  probability?: number;
  expected_payout?: ExpectedPayout;
  reasons?: string[];
}

interface QueueItem {
  id: string;
  incident_id: string;
  venue_id: string;
  status: PacketStatus;
  risk_signals: {
    severity?: string;
    confidence?: number;
    explanation?: string;
    type?: string;
  };
  memo: {
    summary?: string;
    open_questions?: string[];
  };
  generated_at: string;
  claim_recommendation?: ClaimRecommendation;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--state-error)",
  high: "var(--state-error)",
  medium: "var(--state-warning)",
  low: "var(--brand-primary)",
  unknown: "var(--text-tertiary)",
};

const STATUS_CONFIG: Record<PacketStatus, { label: string; icon: React.ReactNode; color: string }> = {
  needs_review: { label: "Needs Review", icon: <Clock size={11} />, color: "var(--state-warning)" },
  approved:     { label: "Approved",     icon: <CheckCircle2 size={11} />, color: "var(--accent-ink)" },
  blocked:      { label: "Blocked",      icon: <LockKeyhole size={11} />, color: "var(--state-error)" },
  draft:        { label: "Draft",        icon: <FileSearch size={11} />, color: "var(--text-tertiary)" },
  processing:   { label: "Processing",   icon: <RefreshCw size={11} />, color: "var(--text-secondary)" },
};

const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };

function titleize(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatVenue(id: string) { return id.replace(/-/g, " "); }
function formatDateTime(iso: string) {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    time: d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
  };
}

export default function ReportsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";
  const isOperator = user?.role === "venue_operator";

  const [packets, setPackets] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<PacketStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDecision, setPendingDecision] = useState<null | "approved" | "blocked">(null);

  const operatorScope = useMemo(() => {
    if (!isOperator || !user) return null;
    const ids = new Set<string>();
    if (user.tenant_id) ids.add(user.tenant_id);
    (user.extra_venue_ids || []).forEach((v) => ids.add(v));
    return ids;
  }, [isOperator, user]);

  async function fetchPackets() {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/packets?limit=50`);
      if (res.ok) {
        const data: QueueItem[] = await res.json();
        const all = Array.isArray(data) ? data : [];
        setPackets(operatorScope ? all.filter((p) => operatorScope.has(p.venue_id)) : all);
      }
    } catch {
      // stay empty
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchPackets(); }, [operatorScope]);

  const filtered = useMemo(
    () => statusFilter === "all" ? packets : packets.filter((p) => p.status === statusFilter),
    [packets, statusFilter]
  );

  const isTriageTab = statusFilter === "all" || statusFilter === "needs_review";
  const triage = useMemo(() => {
    if (!isTriageTab) return [];
    return filtered
      .filter((p) =>
        p.status === "needs_review" &&
        (p.risk_signals?.severity === "critical" || p.risk_signals?.severity === "high")
      )
      .sort((a, b) => {
        const sa = SEV_RANK[a.risk_signals?.severity ?? "unknown"] ?? 9;
        const sb = SEV_RANK[b.risk_signals?.severity ?? "unknown"] ?? 9;
        if (sa !== sb) return sa - sb;
        return new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime();
      });
  }, [filtered, isTriageTab]);

  const triageIds = useMemo(() => new Set(triage.map((p) => p.id)), [triage]);
  const rest = useMemo(() => filtered.filter((p) => !triageIds.has(p.id)), [filtered, triageIds]);

  // Auto-select first row: prefer triage, fall back to rest, when current selection no longer in view.
  useEffect(() => {
    const inView = (id: string) => triage.some((p) => p.id === id) || rest.some((p) => p.id === id);
    if (!selectedId || !inView(selectedId)) {
      const first = triage[0]?.id ?? rest[0]?.id ?? null;
      setSelectedId(first);
    }
  }, [triage, rest, selectedId]);

  const selected = useMemo(() => packets.find((p) => p.id === selectedId) ?? null, [packets, selectedId]);

  const counts = {
    all: packets.length,
    needs_review: packets.filter((p) => p.status === "needs_review").length,
    approved: packets.filter((p) => p.status === "approved").length,
    blocked: packets.filter((p) => p.status === "blocked").length,
    high_critical: packets.filter(
      (p) => p.risk_signals?.severity === "critical" || p.risk_signals?.severity === "high"
    ).length,
  };

  async function decide(packetId: string, decision: "approved" | "blocked") {
    const prev = packets;
    setPendingDecision(decision);
    setPackets((cur) => cur.map((p) => p.id === packetId ? { ...p, status: decision } : p));
    try {
      const res = await fetch(`${API_URL}/api/packets/${packetId}/review-decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, rationale: "Decided from triage console" }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      toastSuccess(decision === "approved" ? "Approved" : "Blocked");
    } catch {
      setPackets(prev);
      toastError("Decision failed — try again");
    } finally {
      setPendingDecision(null);
    }
  }

  function renderRow(packet: QueueItem) {
    const severity = packet.risk_signals?.severity ?? "unknown";
    const confidencePct = Math.round((packet.risk_signals?.confidence ?? 0) * 100);
    const { date } = formatDateTime(packet.generated_at);
    const category = packet.risk_signals?.type ? titleize(packet.risk_signals.type) : "Incident";
    const isSelected = packet.id === selectedId;
    const isCritical = severity === "critical" || severity === "high";
    return (
      <div
        key={packet.id}
        className="lc-triage__row"
        data-selected={isSelected ? "true" : "false"}
        onClick={() => setSelectedId(packet.id)}
      >
        <span
          className="lc-triage__dot"
          data-filled={isCritical ? "true" : "false"}
          style={{ background: SEVERITY_COLOR[severity], color: SEVERITY_COLOR[severity] }}
          aria-label={severity}
        />
        <div style={{ minWidth: 0 }}>
          <div className="lc-triage__row-title">{category}</div>
          <div className="lc-triage__row-sub">{formatVenue(packet.venue_id)}</div>
        </div>
        <div className="lc-triage__row-meta">
          <div className="conf" style={{ color: SEVERITY_COLOR[severity] }}>{confidencePct}%</div>
          <div className="date">{date}</div>
        </div>
      </div>
    );
  }

  function renderPreview() {
    if (!selected) {
      return (
        <div className="lc-triage__empty">
          <ShieldAlert size={28} aria-hidden />
          <p>Select a report to preview.</p>
        </div>
      );
    }
    const severity = selected.risk_signals?.severity ?? "unknown";
    const confidencePct = Math.round((selected.risk_signals?.confidence ?? 0) * 100);
    const category = selected.risk_signals?.type ? titleize(selected.risk_signals.type) : "Incident";
    const { date, time } = formatDateTime(selected.generated_at);
    const summary = selected.memo?.summary || selected.risk_signals?.explanation || "No summary available.";
    const rec = selected.claim_recommendation;
    const statusCfg = STATUS_CONFIG[selected.status] ?? STATUS_CONFIG.draft;
    const fmt$ = (n?: number) => n != null ? `$${Math.round(n).toLocaleString()}` : "—";

    return (
      <>
        <div className="lc-triage__preview-head">
          <div className="lc-triage__preview-meta" style={{ color: SEVERITY_COLOR[severity], marginBottom: 4 }}>
            {severity} · {category}
          </div>
          <h3>{category}</h3>
          <div className="lc-triage__preview-meta">
            {formatVenue(selected.venue_id)} · {date} {time}
          </div>
          <div
            style={{
              marginTop: 10,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${statusCfg.color}`,
              color: statusCfg.color,
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              letterSpacing: "0.06em",
            }}
          >
            {statusCfg.icon}
            {statusCfg.label}
          </div>
        </div>

        <div className="lc-triage__preview-section">
          <h4>Summary</h4>
          <p>{summary}</p>
        </div>

        <div className="lc-triage__preview-section">
          <h4>Risk signals</h4>
          <dl style={{ margin: 0 }}>
            <div className="lc-triage__kv"><dt>Type</dt><dd>{category}</dd></div>
            <div className="lc-triage__kv"><dt>Severity</dt><dd style={{ color: SEVERITY_COLOR[severity] }}>{severity}</dd></div>
            <div className="lc-triage__kv"><dt>Confidence</dt><dd>{confidencePct}%</dd></div>
          </dl>
        </div>

        {rec && (
          <div className="lc-triage__preview-section">
            <h4>Claim recommendation</h4>
            <dl style={{ margin: 0 }}>
              {rec.should_file != null && (
                <div className="lc-triage__kv">
                  <dt>File claim</dt>
                  <dd>{rec.should_file ? "Yes" : "No"}{rec.probability != null && ` · ${Math.round(rec.probability * 100)}% probability`}</dd>
                </div>
              )}
              {rec.expected_payout && (
                <div className="lc-triage__kv">
                  <dt>Expected payout</dt>
                  <dd>
                    {fmt$(rec.expected_payout.low_usd)} – {fmt$(rec.expected_payout.median_usd)} – {fmt$(rec.expected_payout.high_usd)}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}

        <div className="lc-triage__actions">
          {isBroker && (
            <>
              <button
                className="lc-triage__btn"
                data-tone="approve"
                disabled={pendingDecision !== null || selected.status === "approved"}
                onClick={() => decide(selected.id, "approved")}
              >
                <CheckCircle2 size={14} />
                {selected.status === "approved" ? "Approved" : "Approve"}
              </button>
              <button
                className="lc-triage__btn"
                data-tone="block"
                disabled={pendingDecision !== null || selected.status === "blocked"}
                onClick={() => decide(selected.id, "blocked")}
              >
                <XCircle size={14} />
                {selected.status === "blocked" ? "Blocked" : "Block"}
              </button>
            </>
          )}
          <button
            className="lc-triage__btn"
            data-tone="open"
            onClick={() => router.push(`/underwriter/${selected.id}`)}
          >
            Open full report
            <ArrowUpRight size={14} />
          </button>
        </div>

        {!isBroker && (
          <p className="text-xs" style={{ marginTop: 14, color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", letterSpacing: "0.04em" }}>
            Review decisions are made by your broker.
          </p>
        )}
      </>
    );
  }

  return (
    <div className="page page--fluid">
      {/* Compact header */}
      <header className="lc-triage__head">
        <h1 className="lc-triage__title">{isOperator ? "My Reports" : "Reports"}</h1>
        <span className="lc-triage__kpi">
          <b>{counts.all}</b> total · <b className="lc-triage__kpi-hi">{counts.high_critical}</b> high · <b>{counts.approved}</b> approved · <b>{counts.blocked}</b> blocked
        </span>
        <div className="lc-triage__chips" role="tablist" aria-label="Filter by status">
          {(["all", "needs_review", "approved", "blocked"] as const).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={statusFilter === f}
              data-active={statusFilter === f ? "true" : "false"}
              className="lc-triage__chip"
              onClick={() => setStatusFilter(f)}
            >
              {f === "all" ? "All" : STATUS_CONFIG[f].label}
              {counts[f as "all" | "needs_review" | "approved" | "blocked"] > 0 && (
                <span style={{ opacity: 0.6, marginLeft: 6 }}>({counts[f as "all" | "needs_review" | "approved" | "blocked"]})</span>
              )}
            </button>
          ))}
          <button
            className="lc-triage__chip"
            onClick={fetchPackets}
            aria-label="Refresh reports"
            title="Refresh"
          >
            <RefreshCw size={11} style={{ verticalAlign: -1 }} />
          </button>
        </div>
      </header>

      {loading ? (
        <div className="page-loading"><div className="loading-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <ShieldAlert size={48} />
          <h3>No Reports</h3>
          <p>No reports yet. Incidents reported by venue operators will appear here.</p>
        </div>
      ) : (
        <div className="lc-triage">
          <div className="lc-triage__list">
            {triage.length > 0 && (
              <>
                <div className="lc-triage__group-head" data-critical="true">
                  <div className="flex items-center gap-sm">
                    <AlertTriangle size={12} style={{ color: "var(--state-error)" }} />
                    <span className="lc-stat-label lc-triage__group-label">Triage now — high &amp; critical</span>
                  </div>
                  <span className="text-xs font-mono" style={{ color: "var(--text-tertiary)" }}>
                    {triage.length} unresolved
                  </span>
                </div>
                {triage.map(renderRow)}
              </>
            )}
            {rest.length > 0 && (
              <>
                {triage.length > 0 && (
                  <div className="lc-triage__group-head">
                    <span className="lc-stat-label lc-triage__group-label">All reports</span>
                  </div>
                )}
                {rest.map(renderRow)}
              </>
            )}
          </div>
          <aside className="lc-triage__preview">
            {renderPreview()}
          </aside>
        </div>
      )}
    </div>
  );
}
