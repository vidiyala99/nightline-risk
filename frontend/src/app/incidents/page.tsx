"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTenantId, useAuth, useRole } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import { authHeaders } from "@/lib/authFetch";
import {
  AlertTriangle, Plus, Calendar, MapPin, User,
  ShieldAlert, CheckCircle2, Clock, ArrowRight, X,
} from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type IncidentStatus = "open" | "under_review" | "closed";

interface Incident {
  id: string;
  occurred_at: string;
  location: string;
  summary: string;
  reported_by: string;
  injury_observed?: boolean;
  police_called?: boolean;
  ems_called?: boolean;
  status: IncidentStatus;
}


export default function IncidentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSignedIn, isLoaded } = useAuth();
  const tenantId = useTenantId();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";

  // ?venue=<id> scopes the incidents list to a single venue. Set by sidebar
  // navigation from /terminal/[venueId] so users keep their venue context.
  const filterVenueId = searchParams.get("venue");
  const [filterVenueName, setFilterVenueName] = useState<string | null>(null);

  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | "all">("all");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    occurred_at: "",
    location: "",
    summary: "",
    reported_by: "",
    injury_observed: false,
    police_called: false,
    ems_called: false,
  });
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [venues, setVenues] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedVenueId, setSelectedVenueId] = useState<string>("");

  useEffect(() => {
    // Wait for auth to hydrate before redirecting — otherwise a cold load /
    // refresh / deep-link bounces a logged-in user to /login (hydration race).
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!isBroker) return;
    fetch(`${API_URL}/api/venues`)
      .then(r => r.json())
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setVenues(list);
        if (list.length > 0) setSelectedVenueId(list[0].id);
      })
      .catch(() => {});
  }, [isBroker]);

  useEffect(() => {
    async function fetchIncidents() {
      // Explicit ?venue=<id> filter takes precedence over role-based scoping.
      if (filterVenueId) {
        try {
          const res = await fetch(`${API_URL}/api/venues/${filterVenueId}/incidents`, { headers: authHeaders() });
          if (res.ok) {
            const data = await res.json();
            setIncidents(Array.isArray(data) ? data : []);
          } else {
            setIncidents([]);
          }
        } catch (error) {
          console.error("Failed to fetch incidents:", error);
        } finally {
          setLoading(false);
        }
        return;
      }

      // Operator without a tenant_id (mid-onboarding) — show empty state instead
      // of silently fetching some other venue's incidents.
      if (!isBroker && !tenantId) {
        setIncidents([]);
        setLoading(false);
        return;
      }
      try {
        const url = isBroker
          ? `${API_URL}/api/incidents`
          : `${API_URL}/api/venues/${tenantId}/incidents`;
        const res = await fetch(url, { headers: authHeaders() });
        if (res.ok) {
          const data = await res.json();
          setIncidents(Array.isArray(data) ? data : []);
        }
      } catch (error) {
        console.error("Failed to fetch incidents:", error);
      } finally {
        setLoading(false);
      }
    }
    fetchIncidents();
  }, [tenantId, isBroker, filterVenueId]);

  // Look up the filter venue's display name so the chip shows something readable
  useEffect(() => {
    if (!filterVenueId) { setFilterVenueName(null); return; }
    let cancelled = false;
    fetch(`${API_URL}/api/venues/${filterVenueId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) setFilterVenueName(data?.name ?? filterVenueId); })
      .catch(() => { if (!cancelled) setFilterVenueName(filterVenueId); });
    return () => { cancelled = true; };
  }, [filterVenueId]);

  const openIncident = (incidentId: string) => {
    router.push(`/incidents/${incidentId}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const venueId = isBroker ? selectedVenueId : (tenantId ?? "");
    if (!venueId) return;
    if (!formData.occurred_at) {
      toastError("Please enter the date and time of the incident");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ ...formData, occurred_at: new Date(formData.occurred_at).toISOString() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `Server error ${res.status}`);
      }
      const created = await res.json();
      // Upload any attached evidence files
      if (evidenceFiles.length > 0 && created.incident?.id) {
        await Promise.all(evidenceFiles.map(file => {
          const fd = new FormData();
          fd.append("file", file);
          return fetch(`${API_URL}/api/incidents/${created.incident.id}/evidence`, { method: "POST", body: fd });
        }));
      }
      toastSuccess("Incident reported successfully");
      setShowForm(false);
      setEvidenceFiles([]);
      setFormData({ occurred_at: "", location: "", summary: "", reported_by: "", injury_observed: false, police_called: false, ems_called: false });
      const updated = await fetch(isBroker ? `${API_URL}/api/incidents` : `${API_URL}/api/venues/${venueId}/incidents`, { headers: authHeaders() });
      if (updated.ok) {
        const data = await updated.json();
        setIncidents(Array.isArray(data) ? data : []);
      }
    } catch (err: any) {
      toastError(err?.message || "Failed to report incident");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusUpdate = async (incidentId: string, newStatus: IncidentStatus) => {
    setUpdatingId(incidentId);
    try {
      const res = await fetch(`${API_URL}/api/incidents/${incidentId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      setIncidents((prev) => prev.map((i) => (i.id === incidentId ? { ...i, status: newStatus } : i)));
      toastSuccess(`Incident marked as ${newStatus.replace("_", " ")}`);
    } catch {
      toastError("Failed to update incident status");
    } finally {
      setUpdatingId(null);
    }
  };

  const statusLabel: Record<IncidentStatus, string> = { open: "Open", under_review: "Under Review", closed: "Closed" };

  const filteredIncidents = statusFilter === "all" ? incidents : incidents.filter((i) => i.status === statusFilter);

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const openCount = incidents.filter((i) => i.status === "open").length;
  const underReviewCount = incidents.filter((i) => i.status === "under_review").length;

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            INCIDENTS
            <span className="lc-eyebrow__sep" />
            {filterVenueId
              ? (filterVenueName ?? filterVenueId).toUpperCase()
              : isBroker ? "BROKER · PORTFOLIO" : "OPERATOR · VENUE"}
          </span>
          <h1 className="lc-display">
            {isBroker ? <>Portfolio <em>incidents</em></> : <>Tonight's <em>floor</em></>}
          </h1>
          <p className="lc-sub">
            {filterVenueId
              ? `Incidents reported at ${filterVenueName ?? filterVenueId}.`
              : isBroker
                ? "Every reported incident across your insured venues — review, triage, and respond."
                : "Report what happened on your floor and track it through resolution."}
          </p>
        </div>

        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Open</span>
            <strong style={{ color: openCount > 0 ? "var(--state-error)" : undefined }}>
              {openCount.toString().padStart(2, "0")}
            </strong>
          </div>
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Under review</span>
            <strong style={{ color: underReviewCount > 0 ? "var(--state-warning)" : undefined }}>
              {underReviewCount.toString().padStart(2, "0")}
            </strong>
          </div>
          {!isBroker && (
            <div className="lc-meta-cell" style={{ borderLeft: "none" }}>
              <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
                <Plus size={16} /> Report Incident
              </button>
            </div>
          )}
        </div>
      </section>

      {filterVenueId && (
        <div className="mb-lg" style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          <span className="text-xs uppercase tracking-wide text-muted font-mono">Filtered by</span>
          <button
            onClick={() => router.push("/incidents")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "4px 10px",
              borderRadius: "14px",
              border: "1px solid var(--brand-primary)",
              background: "rgba(200,240,0,0.08)",
              color: "var(--accent-ink)",
              fontSize: "0.75rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Clear filter"
          >
            {filterVenueName ?? filterVenueId}
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex justify-between items-center mb-lg" style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}>
        <div className="flex gap-xs" style={{ background: "var(--bg-surface)", padding: "4px", borderRadius: "var(--radius-lg)", flexWrap: "wrap" }}>
          {(["all", "open", "under_review", "closed"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`btn btn-sm ${statusFilter === s ? "btn-primary" : "btn-ghost"}`}
              style={{ borderRadius: "var(--radius-md)" }}
            >
              {s === "all" ? "All" : s === "under_review" ? "Under Review" : s.charAt(0).toUpperCase() + s.slice(1)}
              <span className="text-xs ml-xs opacity-70">
                {s === "all" ? incidents.length : incidents.filter((i) => i.status === s).length}
              </span>
            </button>
          ))}
        </div>
        {isBroker && (
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
            <label htmlFor="venue-filter" className="text-xs uppercase tracking-wide text-muted font-mono">
              Venue
            </label>
            <select
              id="venue-filter"
              value={filterVenueId ?? ""}
              onChange={(e) => {
                const next = e.target.value;
                router.push(next ? `/incidents?venue=${encodeURIComponent(next)}` : "/incidents");
              }}
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border-subtle)",
                borderRadius: "var(--radius-md)",
                color: "var(--text-primary)",
                padding: "6px 12px",
                fontSize: "0.85rem",
                fontFamily: "inherit",
                cursor: "pointer",
                minWidth: "180px",
              }}
            >
              <option value="">All venues ({venues.length})</option>
              {venues.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name ?? v.id}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {showForm && (
        <div
          className="incident-modal-backdrop"
          onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); setEvidenceFiles([]); } }}
        >
        <form onSubmit={handleSubmit} className="incident-form animate-fade-in" style={{ width: "100%", maxWidth: 760, maxHeight: "90vh", overflowY: "auto", margin: 0 }}>
          <div className="incident-form-header">
            <div className="incident-form-dot" />
            <span className="incident-form-header-label">Incident Report</span>
            <span className="text-xs text-muted" style={{ marginLeft: "auto", fontFamily: "var(--font-mono)" }}>{new Date().toLocaleTimeString()}</span>
          </div>
          {isBroker && (
            <div className="input-wrapper" style={{ marginBottom: "var(--space-md)" }}>
              <label className="input-label">Venue</label>
              <select
                className="input-field"
                value={selectedVenueId}
                onChange={(e) => setSelectedVenueId(e.target.value)}
                required
                style={{ background: "var(--bg-surface)", color: "var(--text-primary)" }}
              >
                {venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-row">
            <div className="input-wrapper">
              <label className="input-label">Date & Time</label>
              <input type="datetime-local" className="input-field" value={formData.occurred_at} onChange={(e) => setFormData({ ...formData, occurred_at: e.target.value })} required />
            </div>
            <div className="input-wrapper">
              <label className="input-label">Location</label>
              <input type="text" className="input-field" placeholder="e.g., rear bar, dance floor" value={formData.location} onChange={(e) => setFormData({ ...formData, location: e.target.value })} autoComplete="off" required />
            </div>
          </div>
          <div className="input-wrapper">
            <label className="input-label">Description</label>
            <textarea className="input-field form-textarea" placeholder="Describe what happened..." value={formData.summary} onChange={(e) => setFormData({ ...formData, summary: e.target.value })} required />
          </div>
          <div className="input-wrapper">
            <label className="input-label">Reported By</label>
            <input type="text" className="input-field" placeholder="Your name or role" value={formData.reported_by} onChange={(e) => setFormData({ ...formData, reported_by: e.target.value })} required />
          </div>
          <div className="checkbox-group">
            <label className="checkbox-label"><input type="checkbox" checked={formData.injury_observed} onChange={(e) => setFormData({ ...formData, injury_observed: e.target.checked })} /><span>Injury observed</span></label>
            <label className="checkbox-label"><input type="checkbox" checked={formData.police_called} onChange={(e) => setFormData({ ...formData, police_called: e.target.checked })} /><span>Police called</span></label>
            <label className="checkbox-label"><input type="checkbox" checked={formData.ems_called} onChange={(e) => setFormData({ ...formData, ems_called: e.target.checked })} /><span>EMS called</span></label>
          </div>

          {/* Evidence upload */}
          <div className="form-group">
            <label className="form-label">Evidence (optional)</label>
            <div
              style={{ border: "1px dashed var(--border-subtle)", borderRadius: "var(--radius-md)", padding: "var(--space-lg)", textAlign: "center", cursor: "pointer", background: "var(--bg-surface)" }}
              onClick={() => document.getElementById("evidence-upload")?.click()}
            >
              <input
                id="evidence-upload"
                type="file"
                multiple
                accept="image/*,video/*,application/pdf"
                style={{ display: "none" }}
                onChange={(e) => {
                  const MAX_IMAGE = 20 * 1024 * 1024;
                  const MAX_VIDEO = 200 * 1024 * 1024;
                  const newFiles = Array.from(e.target.files ?? []);
                  const oversized = newFiles.filter(f =>
                    f.type.startsWith("video/") ? f.size > MAX_VIDEO : f.size > MAX_IMAGE
                  );
                  if (oversized.length > 0) {
                    import("@/lib/toast").then(m => m.toastError(
                      `${oversized.map(f => f.name).join(", ")} exceeds the size limit (images: 20MB, videos: 200MB)`
                    ));
                  }
                  const valid = newFiles.filter(f =>
                    f.type.startsWith("video/") ? f.size <= MAX_VIDEO : f.size <= MAX_IMAGE
                  );
                  setEvidenceFiles(prev => {
                    const existingNames = new Set(prev.map(f => f.name));
                    return [...prev, ...valid.filter(f => !existingNames.has(f.name))];
                  });
                  e.target.value = "";
                }}
              />
              <p className="text-sm text-secondary">Attach photos, video clips, or documents</p>
              <p className="text-xs text-muted mt-xs">Images, video, PDF · Click to add more files</p>
              {evidenceFiles.length > 0 && (
                <div className="flex flex-wrap gap-xs mt-md justify-center">
                  {evidenceFiles.map((f, i) => (
                    <span key={i} className="flex items-center gap-xs text-xs font-mono px-sm py-xs" style={{ background: "rgba(200,240,0,0.08)", border: "1px solid rgba(200,240,0,0.2)", borderRadius: "var(--radius-sm)", color: "var(--accent-ink)" }}>
                      {f.name}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEvidenceFiles(prev => prev.filter((_, idx) => idx !== i)); }}
                        style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)", lineHeight: 1, padding: 0 }}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setShowForm(false); setEvidenceFiles([]); }}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Submitting..." : "Submit Report"}</button>
          </div>
        </form>
        </div>
      )}

      <div className="incidents-section">
        <div className="incidents-list stagger-children">
          {filteredIncidents.length > 0 ? (
            filteredIncidents.map((incident) => (
              <div
                key={incident.id}
                className="incident-card"
                style={{ cursor: "pointer" }}
                onClick={() => openIncident(incident.id)}
              >
                <div className="incident-icon">
                  <AlertTriangle size={20} />
                </div>
                <div className="incident-info">
                  <div className="incident-header-row">
                    <h4>{incident.summary.split(".")[0]}</h4>
                    <div className="incident-header-actions">
                      <span className={`badge ${incident.status === "open" ? "badge-error" : incident.status === "under_review" ? "badge-warning" : "badge-success"}`}>
                        {incident.status === "open" && <AlertTriangle size={10} />}
                        {incident.status === "under_review" && <Clock size={10} />}
                        {incident.status === "closed" && <CheckCircle2 size={10} />}
                        {statusLabel[incident.status]}
                      </span>
                      <ArrowRight size={14} style={{ color: "var(--text-muted)" }} />
                    </div>
                  </div>
                  <p className="incident-desc">{incident.summary}</p>
                  <div className="incident-meta">
                    <span><Calendar size={12} />{new Date(incident.occurred_at).toLocaleDateString()}</span>
                    <span><MapPin size={12} />{incident.location}</span>
                    <span><User size={12} />{incident.reported_by}</span>
                  </div>
                  <div className="incident-flags">
                    {incident.injury_observed && <span className="flag-tag flag-danger">Injury</span>}
                    {incident.police_called && <span className="flag-tag flag-warning">Police</span>}
                    {incident.ems_called && <span className="flag-tag flag-info">EMS</span>}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="page-empty">
              <ShieldAlert size={48} />
              <h3>{statusFilter === "all" ? "No Incidents Reported" : `No ${statusFilter.replace("_", " ")} incidents`}</h3>
              <p>{statusFilter === "all" ? "Your venue has a clean record" : "Try a different filter"}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
