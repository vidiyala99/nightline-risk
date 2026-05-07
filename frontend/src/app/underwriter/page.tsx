"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Clock, FileSearch, LockKeyhole, RefreshCw, ShieldAlert } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type PacketStatus = "needs_review" | "approved" | "blocked" | "draft" | "processing";

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
  };
  generated_at: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--state-error)",
  high: "var(--state-error)",
  medium: "var(--state-warning)",
  low: "var(--brand-primary)",
  unknown: "var(--text-tertiary)",
};

const STATUS_CONFIG: Record<PacketStatus, { label: string; icon: React.ReactNode; color: string; bg: string; pulse: boolean }> = {
  needs_review: { label: "Needs Review", icon: <Clock size={12} />, color: "#000", bg: "var(--state-warning)", pulse: true },
  approved:     { label: "Approved",     icon: <CheckCircle2 size={12} />, color: "var(--brand-primary)", bg: "transparent", pulse: false },
  blocked:      { label: "Blocked",      icon: <LockKeyhole size={12} />, color: "#fff", bg: "var(--state-error)", pulse: false },
  draft:        { label: "Draft",        icon: <FileSearch size={12} />, color: "var(--text-tertiary)", bg: "transparent", pulse: false },
  processing:   { label: "Processing",   icon: <RefreshCw size={12} />, color: "var(--text-secondary)", bg: "transparent", pulse: false },
};

export default function ReportsPage() {
  const router = useRouter();
  const [packets, setPackets] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<PacketStatus | "all">("all");

  useEffect(() => {
    async function fetchPackets() {
      try {
        const res = await fetch(`${API_URL}/api/packets?limit=50`);
        if (res.ok) {
          const data = await res.json();
          setPackets(Array.isArray(data) ? data : []);
        }
      } catch {
        // stay empty
      } finally {
        setLoading(false);
      }
    }
    fetchPackets();
  }, []);

  const filtered = statusFilter === "all"
    ? packets
    : packets.filter((p) => p.status === statusFilter);

  const counts = {
    all: packets.length,
    needs_review: packets.filter((p) => p.status === "needs_review").length,
    approved: packets.filter((p) => p.status === "approved").length,
    blocked: packets.filter((p) => p.status === "blocked").length,
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Reports</h1>
          <p className="page-subtitle">Review and action incident reports from your venues</p>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => { setLoading(true); fetch(`${API_URL}/api/packets?limit=50`).then(r => r.json()).then(d => setPackets(Array.isArray(d) ? d : [])).finally(() => setLoading(false)); }}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </header>

      {/* Status filter tabs */}
      <div className="flex gap-xs mb-xl" style={{ borderBottom: "1px solid var(--border-subtle)", paddingBottom: "0" }}>
        {(["all", "needs_review", "approved", "blocked"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className="text-sm font-mono px-lg py-md uppercase tracking-wide"
            style={{
              background: "none",
              border: "none",
              borderBottom: statusFilter === f ? "2px solid var(--brand-primary)" : "2px solid transparent",
              color: statusFilter === f ? "var(--brand-primary)" : "var(--text-secondary)",
              cursor: "pointer",
              marginBottom: "-1px",
            }}
          >
            {f === "all" ? "All" : STATUS_CONFIG[f].label} {counts[f] > 0 && <span style={{ opacity: 0.6 }}>({counts[f]})</span>}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="page-loading"><div className="loading-spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="page-empty">
          <ShieldAlert size={48} />
          <h3>No Reports</h3>
          <p>No reports yet. Incidents reported by venue operators will appear here.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-md">
          {filtered.map((packet) => {
            const severity = packet.risk_signals?.severity ?? "unknown";
            const confidence = packet.risk_signals?.confidence ?? 0;
            const status = STATUS_CONFIG[packet.status] ?? STATUS_CONFIG.draft;
            const date = new Date(packet.generated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            const time = new Date(packet.generated_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

            return (
              <div
                key={packet.id}
                onClick={() => router.push(`/underwriter/${packet.id}`)}
                className="card"
                style={{ cursor: "pointer", borderLeft: `3px solid ${SEVERITY_COLOR[severity] ?? "var(--border-subtle)"}` }}
              >
                <div className="flex justify-between items-start gap-lg">
                  <div className="flex-1" style={{ minWidth: 0 }}>
                    <div className="flex items-center gap-md mb-sm">
                      <span className="text-xs font-mono uppercase tracking-wide" style={{ color: "var(--text-tertiary)" }}>
                        {packet.venue_id.replace(/-/g, " ").toUpperCase()}
                      </span>
                      <span className="text-xs font-mono" style={{ color: SEVERITY_COLOR[severity] }}>
                        {severity.toUpperCase()} EXPOSURE
                      </span>
                    </div>
                    <p className="text-sm" style={{ color: "var(--text-primary)", marginBottom: "var(--space-xs)" }}>
                      {packet.memo?.summary
                        ? packet.memo.summary.length > 120
                          ? packet.memo.summary.slice(0, 120) + "…"
                          : packet.memo.summary
                        : packet.risk_signals?.explanation?.slice(0, 120) ?? "No summary available."}
                    </p>
                    <div className="flex items-center gap-md text-xs font-mono" style={{ color: "var(--text-tertiary)" }}>
                      <span>{date} · {time}</span>
                      <span>{packet.venue_id.replace(/-/g, " ").toUpperCase()}</span>
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-sm" style={{ flexShrink: 0 }}>
                    <div
                      className="flex items-center gap-xs text-xs font-mono font-bold px-sm py-xs"
                      style={{
                        background: status.bg,
                        border: status.bg === "transparent" ? `1px solid ${status.color}` : "none",
                        color: status.color,
                        borderRadius: "var(--radius-sm)",
                        whiteSpace: "nowrap",
                        animation: status.pulse ? "status-pulse 2s ease-in-out infinite" : "none",
                      }}
                    >
                      {status.icon}
                      {status.label}
                    </div>
                    <div className="text-right">
                      <div className="text-xl font-mono font-bold" style={{ color: "var(--brand-primary)" }}>
                        {Math.round(confidence * 100)}%
                      </div>
                      <div className="text-xs font-mono" style={{ color: "var(--text-tertiary)" }}>confidence</div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
