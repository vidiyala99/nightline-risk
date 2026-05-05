"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTenantId, useAuth } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import { AlertTriangle, Plus, Calendar, MapPin, User, ArrowRight, LogOut, ShieldAlert } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Incident {
  id: string;
  occurred_at: string;
  location: string;
  summary: string;
  reported_by: string;
  injury_observed?: boolean;
  police_called?: boolean;
  ems_called?: boolean;
}

export default function IncidentsPage() {
  const router = useRouter();
  const { signOut, isSignedIn } = useAuth();
  const tenantId = useTenantId();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    occurred_at: new Date().toISOString().slice(0, 16),
    location: "",
    summary: "",
    reported_by: "",
    injury_observed: false,
    police_called: false,
    ems_called: false,
  });

  useEffect(() => {
    if (!isSignedIn) {
      router.push("/login");
    }
  }, [isSignedIn, router]);

  useEffect(() => {
    async function fetchIncidents() {
      if (!tenantId) {
        setIncidents([]);
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(`${API_URL}/api/venues/${tenantId}/incidents`);
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
  }, [tenantId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId) return;
    
    setSubmitting(true);

    try {
      const res = await fetch(`${API_URL}/api/venues/${tenantId}/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...formData,
          occurred_at: new Date(formData.occurred_at).toISOString(),
        }),
      });
      
      if (!res.ok) throw new Error("Failed to submit");

      toastSuccess("Incident reported successfully");
      setShowForm(false);
      setFormData({
        occurred_at: new Date().toISOString().slice(0, 16),
        location: "",
        summary: "",
        reported_by: "",
        injury_observed: false,
        police_called: false,
        ems_called: false,
      });
      
      const updated = await fetch(`${API_URL}/api/venues/${tenantId}/incidents`);
      if (updated.ok) {
        const data = await updated.json();
        setIncidents(Array.isArray(data) ? data : []);
      }
    } catch (error) {
      toastError("Failed to report incident");
      console.error(error);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignOut = () => {
    signOut();
    router.push("/login");
  };

  if (!isSignedIn || loading) {
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Incidents</h1>
          <p className="page-subtitle">
            Report and track incidents at your venue
          </p>
        </div>
        <button onClick={handleSignOut} className="btn btn-ghost">
          <LogOut size={18} />
          Sign Out
        </button>
      </header>

      <div className="page-actions">
        <button className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
          <Plus size={18} />
          Report Incident
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="incident-form animate-fade-in">
          <div className="form-row">
            <div className="input-wrapper">
              <label className="input-label">Date & Time</label>
              <input
                type="datetime-local"
                className="input-field"
                value={formData.occurred_at}
                onChange={(e) => setFormData({ ...formData, occurred_at: e.target.value })}
                required
              />
            </div>
            <div className="input-wrapper">
              <label className="input-label">Location</label>
              <input
                type="text"
                className="input-field"
                placeholder="e.g., rear bar, dance floor"
                value={formData.location}
                onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="input-wrapper">
            <label className="input-label">Description</label>
            <textarea
              className="input-field form-textarea"
              placeholder="Describe what happened..."
              value={formData.summary}
              onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
              required
            />
          </div>

          <div className="input-wrapper">
            <label className="input-label">Reported By</label>
            <input
              type="text"
              className="input-field"
              placeholder="Your name or role"
              value={formData.reported_by}
              onChange={(e) => setFormData({ ...formData, reported_by: e.target.value })}
              required
            />
          </div>

          <div className="checkbox-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formData.injury_observed}
                onChange={(e) => setFormData({ ...formData, injury_observed: e.target.checked })}
              />
              <span>Injury observed</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formData.police_called}
                onChange={(e) => setFormData({ ...formData, police_called: e.target.checked })}
              />
              <span>Police called</span>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={formData.ems_called}
                onChange={(e) => setFormData({ ...formData, ems_called: e.target.checked })}
              />
              <span>EMS called</span>
            </label>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Submitting..." : "Submit Report"}
            </button>
          </div>
        </form>
      )}

      <div className="incidents-section">
        <h3>Recent Incidents</h3>
        <div className="incidents-list">
          {incidents.length > 0 ? (
            incidents.map((incident) => (
              <div key={incident.id} className="incident-card">
                <div className="incident-icon">
                  <AlertTriangle size={20} />
                </div>
                <div className="incident-info">
                  <h4>{incident.summary.split(".")[0]}</h4>
                  <p className="incident-desc">{incident.summary}</p>
                  <div className="incident-meta">
                    <span>
                      <Calendar size={12} />
                      {new Date(incident.occurred_at).toLocaleDateString()}
                    </span>
                    <span>
                      <MapPin size={12} />
                      {incident.location}
                    </span>
                    <span>
                      <User size={12} />
                      {incident.reported_by}
                    </span>
                  </div>
                  <div className="incident-flags">
                    {incident.injury_observed && (
                      <span className="flag-tag flag-danger">Injury</span>
                    )}
                    {incident.police_called && (
                      <span className="flag-tag flag-warning">Police</span>
                    )}
                    {incident.ems_called && (
                      <span className="flag-tag flag-info">EMS</span>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="page-empty">
              <ShieldAlert size={48} />
              <h3>No Incidents Reported</h3>
              <p>Your venue has a clean record</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
