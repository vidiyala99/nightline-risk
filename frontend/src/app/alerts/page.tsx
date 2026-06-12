"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTenantId, useAuth, useRole } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import { authHeaders } from "@/lib/authFetch";
import { bySeverity } from "@/lib/sort";
import Link from "next/link";
import { Bell, CheckCircle2, XCircle, ChevronDown, RefreshCw, ShieldAlert, ShieldCheck, Zap, ArrowRight } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type Severity = "critical" | "high" | "medium" | "low";
type FeedbackType = "confirmed" | "false_alarm" | null;

interface Alert {
  id: string;
  venue_id: string;
  zone: string;
  event_type: string;
  severity: Severity;
  confidence: number;
  description: string;
  detected_at: string;
  feedback?: FeedbackType;
}

interface VenueSummary { id: string; name: string; }

const SEVERITY_CONFIG: Record<Severity, { border: string; badge: string; text: string; label: string; pulse: boolean }> = {
  critical: { border: "#ef4444", badge: "bg-red-500",    text: "text-white",    label: "Critical", pulse: true  },
  high:     { border: "#f97316", badge: "bg-orange-500", text: "text-white",    label: "High",     pulse: false },
  medium:   { border: "#eab308", badge: "bg-yellow-500", text: "text-gray-900", label: "Medium",   pulse: false },
  low:      { border: "#6b7280", badge: "bg-gray-500",   text: "text-white",    label: "Low",      pulse: false },
};

function formatZone(z: string) {
  return z.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function formatEventType(e: string) {
  return e.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function AlertCardSkeleton() {
  return (
    <div className="card animate-pulse" style={{ borderLeft: "3px solid var(--bg-surface-elevated)", padding: "var(--space-lg)" }}>
      <div className="flex flex-col gap-sm">
        <div style={{ height: 18, width: "30%", borderRadius: 4, background: "var(--bg-surface-elevated)" }} />
        <div style={{ height: 12, width: "60%", borderRadius: 4, background: "var(--bg-surface-elevated)" }} />
        <div style={{ height: 12, width: "80%", borderRadius: 4, background: "var(--bg-surface-elevated)" }} />
        <div style={{ height: 12, width: "45%", borderRadius: 4, background: "var(--bg-surface-elevated)" }} />
      </div>
    </div>
  );
}

function AlertCard({
  alert,
  onFeedback,
}: {
  alert: Alert;
  onFeedback: (id: string, fb: "confirmed" | "false_alarm") => Promise<boolean>;
}) {
  const [submitting, setSubmitting] = useState<"confirmed" | "false_alarm" | null>(null);
  const mounted = useRef(true);
  const cfg = SEVERITY_CONFIG[alert.severity] ?? SEVERITY_CONFIG.low;
  const confidencePct = Math.round(alert.confidence * 100);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function handleFeedback(fb: "confirmed" | "false_alarm") {
    setSubmitting(fb);
    const ok = await onFeedback(alert.id, fb);
    if (mounted.current) setSubmitting(null);
    if (ok) {
      toastSuccess(fb === "confirmed" ? "Alert confirmed — logged for review." : "Marked as false alarm.");
    } else {
      toastError("Failed to save feedback — try again.");
    }
  }

  return (
    <div
      className="card"
      style={{
        borderLeft: `3px solid ${cfg.border}`,
        padding: "var(--space-lg)",
        transition: "box-shadow 200ms ease",
      }}
    >
      {/* Top row */}
      <div className="flex flex-wrap gap-sm items-center mb-sm">
        {/* Severity badge */}
        <span
          className={`${cfg.badge} ${cfg.text} text-xs font-bold uppercase tracking-wide flex items-center gap-xs`}
          style={{ padding: "3px 10px", borderRadius: "var(--radius-sm)" }}
        >
          {cfg.pulse && (
            <span
              style={{
                width: 6, height: 6, borderRadius: "50%",
                background: "white", opacity: 0.9,
                animation: "pulse 1.4s ease-in-out infinite",
              }}
            />
          )}
          {cfg.label}
        </span>

        {/* Zone & event */}
        <span className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
          {formatZone(alert.zone)}
        </span>
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>·</span>
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
          {formatEventType(alert.event_type)}
        </span>

        {/* Timestamp pushed right */}
        <span className="ml-auto text-xs font-mono" style={{ color: "var(--text-tertiary)" }}>
          {relativeTime(alert.detected_at)}
        </span>
      </div>

      {/* Confidence bar */}
      <div className="mb-md">
        <div className="flex justify-between items-center mb-xs">
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>Confidence</span>
          <span className="text-xs font-mono font-semibold" style={{ color: cfg.border }}>
            {confidencePct}%
          </span>
        </div>
        <div
          style={{
            height: 4, borderRadius: 99,
            background: "var(--bg-surface-elevated)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${confidencePct}%`,
              background: cfg.border,
              borderRadius: 99,
              transition: "width 600ms ease",
            }}
          />
        </div>
      </div>

      {/* Description */}
      <p
        className="text-sm mb-lg"
        style={{
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
        }}
      >
        {alert.description}
      </p>

      {/* Feedback */}
      {alert.feedback ? (
        <div className="flex items-center gap-sm">
          {alert.feedback === "confirmed" ? (
            <span
              className="flex items-center gap-xs text-xs font-semibold"
              style={{
                color: "var(--state-success)",
                padding: "6px 14px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--state-success)",
                background: "rgba(34,197,94,0.08)",
              }}
            >
              <CheckCircle2 size={13} /> Confirmed
            </span>
          ) : (
            <span
              className="flex items-center gap-xs text-xs font-semibold"
              style={{
                color: "var(--text-secondary)",
                padding: "6px 14px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid rgba(255,255,255,0.1)",
                background: "var(--bg-surface-elevated)",
              }}
            >
              <XCircle size={13} /> False Alarm
            </span>
          )}
        </div>
      ) : (
        <div className="flex gap-sm flex-wrap">
          <button
            onClick={() => handleFeedback("confirmed")}
            disabled={submitting !== null}
            aria-label="Mark as confirmed real event"
            style={{
              minHeight: 44,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 16px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--state-success)",
              color: "var(--state-success)",
              background: "rgba(34,197,94,0.06)",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting !== null ? 0.5 : 1,
              transition: "opacity 150ms, background 150ms",
            }}
          >
            <CheckCircle2 size={15} />
            {submitting === "confirmed" ? "Saving…" : "Confirmed"}
          </button>
          <button
            onClick={() => handleFeedback("false_alarm")}
            disabled={submitting !== null}
            aria-label="Mark as false alarm"
            style={{
              minHeight: 44,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 16px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid rgba(255,255,255,0.12)",
              color: "var(--text-secondary)",
              background: "var(--bg-surface-elevated)",
              fontSize: "0.8rem",
              fontWeight: 600,
              cursor: submitting ? "not-allowed" : "pointer",
              opacity: submitting !== null ? 0.5 : 1,
              transition: "opacity 150ms, background 150ms",
            }}
          >
            <XCircle size={15} />
            {submitting === "false_alarm" ? "Saving…" : "False Alarm"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AlertsPage() {
  return (
    <Suspense fallback={<div className="theme-venue min-h-screen page-loading"><div className="loading-spinner" /></div>}>
      <AlertsPageInner />
    </Suspense>
  );
}

function AlertsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSignedIn, isLoaded } = useAuth();
  const tenantId = useTenantId();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";

  const [venues, setVenues] = useState<VenueSummary[]>([]);
  const [selectedVenueId, setSelectedVenueId] = useState("");
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  // Alerts are real-time venue floor/liability detections — an operator
  // surface. Brokers are book-level and don't run the floor; bounce them.
  useEffect(() => {
    if (isLoaded && isSignedIn && isBroker) router.replace("/dashboard");
  }, [isLoaded, isSignedIn, isBroker, router]);

  useEffect(() => {
    if (!isSignedIn || isBroker) return;
    async function loadVenues() {
      try {
        if (isBroker) {
          const res = await fetch(`${API_URL}/api/venues`, { headers: authHeaders() });
          if (res.ok) {
            const list: VenueSummary[] = await res.json();
            setVenues(Array.isArray(list) ? list : []);
            setSelectedVenueId(searchParams.get("venue") ?? list[0]?.id ?? "");
          }
        } else if (tenantId) {
          const res = await fetch(`${API_URL}/api/venues/${tenantId}`, { headers: authHeaders() });
          const data = res.ok ? await res.json() : {};
          setVenues([{ id: tenantId, name: data.name ?? tenantId }]);
          setSelectedVenueId(tenantId);
        }
      } catch { /* ignore */ }
    }
    loadVenues();
  }, [isSignedIn, isBroker, tenantId, searchParams]);

  const fetchAlerts = useCallback(async (silent = false) => {
    if (!selectedVenueId) { setLoading(false); return; }
    if (!silent) setLoading(true);
    else setRefreshing(true);

    try {
      const res = await fetch(`${API_URL}/api/venues/${selectedVenueId}/alerts`, { headers: authHeaders() });
      setAlerts(res.ok ? (await res.json()) : []);
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedVenueId]);

  useEffect(() => { fetchAlerts(); }, [fetchAlerts]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!selectedVenueId) return;
    const id = setInterval(() => fetchAlerts(true), 30_000);
    return () => clearInterval(id);
  }, [selectedVenueId, fetchAlerts]);

  const handleFeedback = useCallback(async (
    alertId: string,
    feedback: "confirmed" | "false_alarm",
  ): Promise<boolean> => {
    try {
      const res = await fetch(`${API_URL}/api/alerts/${alertId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ feedback }),
      });
      if (res.ok) {
        setAlerts((prev) => prev.map((a) => a.id === alertId ? { ...a, feedback } : a));
        return true;
      }
      return false;
    } catch { return false; }
  }, []);

  const criticalCount = alerts.filter((a) => a.severity === "critical" && !a.feedback).length;
  const selectedVenueName = venues.find((v) => v.id === selectedVenueId)?.name ?? selectedVenueId;

  // Brokers are redirected away (operator-only surface) — hold the spinner.
  if (!isLoaded || isBroker) {
    return <div className="theme-venue min-h-screen page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="theme-venue min-h-screen p-xl">
      {/* Header */}
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            ALERTS
            <span className="lc-eyebrow__sep" />
            {selectedVenueName ? selectedVenueName.toUpperCase() : "VENUE"}
            {criticalCount > 0 && (
              <span
                style={{
                  marginLeft: "var(--space-sm)",
                  background: "var(--state-error)",
                  color: "white",
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  padding: "2px 8px",
                  borderRadius: "var(--radius-sm)",
                  animation: "pulse 1.4s ease-in-out infinite",
                  letterSpacing: "0.1em",
                }}
              >
                {criticalCount} CRITICAL
              </span>
            )}
          </span>
          <h1 className="lc-display">
            Liability <em>alerts</em>
          </h1>
          <p className="lc-sub">
            Real-time anomaly detections — confirm or dismiss each alert
          </p>
        </div>

        <div className="lc-hero__meta">
          {/* Venue selector */}
          {venues.length > 1 && (
            <div style={{ position: "relative", minWidth: 180 }}>
              <select
                value={selectedVenueId}
                onChange={(e) => { setSelectedVenueId(e.target.value); setLoading(true); }}
                className="input-field"
                style={{ paddingRight: 36, appearance: "none", cursor: "pointer" }}
              >
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
              <ChevronDown size={14} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-tertiary)" }} />
            </div>
          )}
          {venues.length === 1 && (
            <span className="lc-meta-cell">
              <span className="lc-stat-label">Venue</span>
              <strong>{selectedVenueName}</strong>
            </span>
          )}

          {/* Severity summary */}
          {!loading && alerts.length > 0 && (["critical", "high", "medium", "low"] as Severity[]).map((sev) => {
            const count = alerts.filter((a) => a.severity === sev).length;
            if (!count) return null;
            const cfg = SEVERITY_CONFIG[sev];
            return (
              <span key={sev} className="lc-meta-cell">
                <span className="lc-stat-label">{cfg.label}</span>
                <strong style={{ color: cfg.border }}>{count.toString().padStart(2, "0")}</strong>
              </span>
            );
          })}

          {/* Refresh button */}
          <button
            onClick={() => fetchAlerts(true)}
            disabled={refreshing}
            aria-label="Refresh alerts"
            className="btn btn-secondary"
            style={{ minHeight: 40, padding: "0 12px", gap: 6, fontSize: "0.8rem" }}
          >
            <RefreshCw size={14} style={{ animation: refreshing ? "spin 1s linear infinite" : "none" }} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </section>

      {/* Loading skeletons */}
      {loading && (
        <div className="flex flex-col gap-md">
          {[1, 2, 3].map((i) => <AlertCardSkeleton key={i} />)}
        </div>
      )}

      {/* Empty state + active list + recent resolved */}
      {!loading && (() => {
        // Severity-first (critical → low) so the most dangerous exposure leads,
        // newest breaking ties — was newest-first, ignoring severity.
        const activeAlerts = alerts
          .filter((a) => !a.feedback)
          .sort(bySeverity((a) => a.severity, (a) => a.detected_at));
        const resolvedAlerts = alerts.filter((a) => !!a.feedback).slice(0, 5);
        if (activeAlerts.length === 0) {
          return (
            <>
              <div className="card lc-empty" style={{ padding: "var(--space-2xl) var(--space-xl)" }}>
                <span className="lc-empty__icon" aria-hidden>
                  <ShieldCheck size={28} />
                </span>
                <h2 className="lc-empty__title">All clear — no active alerts</h2>
                <p className="lc-empty__sub">
                  {selectedVenueId
                    ? "No liability events flagged for this venue. Real-time detection is running across all infrastructure."
                    : "Select a venue to view its alert stream."}
                </p>
              </div>

              {resolvedAlerts.length > 0 && (
                <div style={{ marginTop: "var(--space-xl)" }}>
                  <div className="flex items-center justify-between mb-md">
                    <span className="lc-stat-label">Recent resolved alerts</span>
                    <span className="text-xs" style={{ color: "var(--text-tertiary)", fontFamily: "var(--font-mono)" }}>
                      last {resolvedAlerts.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-sm">
                    {resolvedAlerts.map((a) => {
                      const cfg = SEVERITY_CONFIG[a.severity] ?? SEVERITY_CONFIG.low;
                      const confirmed = a.feedback === "confirmed";
                      return (
                        <div
                          key={a.id}
                          className="card"
                          style={{
                            padding: "var(--space-md) var(--space-lg)",
                            borderLeft: `3px solid ${confirmed ? "var(--state-success)" : "var(--text-tertiary)"}`,
                            display: "grid",
                            gridTemplateColumns: "auto 1fr auto auto",
                            alignItems: "center",
                            gap: 14,
                          }}
                        >
                          <span
                            className="text-xs font-mono"
                            style={{
                              color: confirmed ? "var(--state-success)" : "var(--text-tertiary)",
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {confirmed ? "Confirmed" : "Dismissed"}
                          </span>
                          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                            {formatEventType(a.event_type)} · {formatZone(a.zone)}
                          </span>
                          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{cfg.label}</span>
                          <span className="text-xs font-mono" style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                            {relativeTime(a.detected_at)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          );
        }
        return (
          <div className="flex flex-col gap-md stagger-children">
            {activeAlerts.map((alert) => (
              <AlertCard key={alert.id} alert={alert} onFeedback={handleFeedback} />
            ))}
            {resolvedAlerts.length > 0 && (
              <div style={{ marginTop: "var(--space-lg)" }}>
                <span className="lc-stat-label" style={{ display: "block", marginBottom: 10 }}>Recent resolved</span>
                <div className="flex flex-col gap-sm">
                  {resolvedAlerts.map((a) => (
                    <AlertCard key={a.id} alert={a} onFeedback={handleFeedback} />
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
