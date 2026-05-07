"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTenantId, useAuth, useRole } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import {
  AlertTriangle, Plus, Calendar, MapPin, User,
  ShieldAlert, CheckCircle2, Clock, ArrowRight,
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
  const { isSignedIn } = useAuth();
  const tenantId = useTenantId();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | "all">("all");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    occurred_at: new Date().toISOString().slice(0, 16),
    location: "",
    summary: "",
    reported_by: "",
    injury_observed: false,
    police_called: false,
    ems_called: false,
  });
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [evidenceLinks, setEvidenceLinks] = useState<string[]>([]);
  const [linkInput, setLinkInput] = useState("");
  const [venues, setVenues] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedVenueId, setSelectedVenueId] = useState<string>("");

  useEffect(() => {
    if (!isSignedIn) router.push("/login");
  }, [isSignedIn, router]);

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
      try {
        const url = isBroker
          ? `${API_URL}/api/incidents`
          : `${API_URL}/api/venues/${tenantId ?? "elsewhere-brooklyn"}/incidents`;
        const res = await fetch(url);
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
  }, [tenantId, isBroker]);

  const openIncident = (incidentId: string) => {
    router.push(`/incidents/${incidentId}`);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const venueId = isBroker ? selectedVenueId : (tenantId ?? "");
    if (!venueId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...formData, occurred_at: new Date(formData.occurred_at).toISOString() }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      const created = await res.json();
      // Upload any attached evidence files
      if (evidenceFiles.length > 0 && created.incident?.id) {
        await Promise.all(evidenceFiles.map(file => {
          const fd = new FormData();
          fd.append("file", file);
          return fetch(`${API_URL}/api/incidents/${created.incident.id}/evidence`, { method: "POST", body: fd });
        }));
      }
      toastSuccess(evidenceLinks.length > 0
        ? "Incident reported. Linked footage will be reviewed within 24–48 hours."
        : "Incident reported successfully"
      );
      setShowForm(false);
      setEvidenceFiles([]);
      setEvidenceLinks([]);
      setLinkInput("");
      setFormData({ occurred_at: new Date().toISOString().slice(0, 16), location: "", summary: "", reported_by: "", injury_observed: false, police_called: false, ems_called: false });
      const updated = await fetch(isBroker ? `${API_URL}/api/incidents` : `${API_URL}/api/venues/${venueId}/incidents`);
      if (updated.ok) {
        const data = await updated.json();
        setIncidents(Array.isArray(data) ? data : []);
      }
    } catch {
      toastError("Failed to report incident");
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusUpdate = async (incidentId: string, newStatus: IncidentStatus) => {
    setUpdatingId(incidentId);
    try {
      const res = await fetch(`${API_URL}/api/incidents/${incidentId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
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

  return (
    <div className="theme-venue page">
      <header className="page-header">
        <div>
          <h1>Incidents</h1>
          <p className="page-subtitle">Report and track incidents at your venue</p>
        </div>
        <button style={{display:"none"}}>
        </button>
      </header>

      <div className="flex justify-between items-center mb-lg">
        <div className="flex gap-xs" style={{ background: "var(--bg-surface)", padding: "4px", borderRadius: "var(--radius-lg)" }}>
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
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          <Plus size={18} /> Report Incident
        </button>
      </div>

      {showForm && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-xl)" }}
          onClick={(e) => { if (e.target === e.currentTarget) { setShowForm(false); setEvidenceFiles([]); setEvidenceLinks([]); setLinkInput(""); } }}
        >
        <form onSubmit={handleSubmit} className="incident-form animate-fade-in" style={{ width: "100%", maxWidth: 760, maxHeight: "90vh", overflowY: "auto", margin: 0 }}>
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
              <input type="text" className="input-field" placeholder="e.g., rear bar, dance floor" value={formData.location} onChange={(e) => setFormData({ ...formData, location: e.target.value })} required />
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
                    <span key={i} className="flex items-center gap-xs text-xs font-mono px-sm py-xs" style={{ background: "rgba(212,255,0,0.08)", border: "1px solid rgba(212,255,0,0.2)", borderRadius: "var(--radius-sm)", color: "var(--brand-primary)" }}>
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

          {/* Link alternative for large footage */}
          <div className="form-group">
            <label className="form-label">Share a footage link (for CC or large videos)</label>
            <div className="flex gap-sm">
              <input
                type="url"
                className="input-field flex-1"
                placeholder="e.g. Google Drive, Dropbox, NVR portal link..."
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (!linkInput.trim()) return;
                  setEvidenceLinks(prev => [...prev, linkInput.trim()]);
                  setLinkInput("");
                }}
              >
                Add
              </button>
            </div>
            {evidenceLinks.length > 0 && (
              <div className="flex flex-col gap-xs mt-sm">
                {evidenceLinks.map((link, i) => (
                  <div key={i} className="flex items-center justify-between text-xs font-mono px-sm py-xs" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)" }}>
                    <span className="text-secondary truncate flex-1 mr-sm">{link}</span>
                    <button type="button" onClick={() => setEvidenceLinks(prev => prev.filter((_, idx) => idx !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>×</button>
                  </div>
                ))}
              </div>
            )}
            {evidenceLinks.length > 0 && (
              <p className="text-xs text-secondary mt-xs" style={{ color: "var(--state-warning)" }}>
                Linked footage will be reviewed manually — allow 24–48 hours for analysis to complete.
              </p>
            )}
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setShowForm(false); setEvidenceFiles([]); setEvidenceLinks([]); setLinkInput(""); }}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>{submitting ? "Submitting..." : "Submit Report"}</button>
          </div>
        </form>
        </div>
      )}

      <div className="incidents-section">
        <div className="incidents-list">
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
                  <div className="flex justify-between items-start mb-xs">
                    <h4 style={{ margin: 0 }}>{incident.summary.split(".")[0]}</h4>
                    <div className="flex items-center gap-sm">
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
