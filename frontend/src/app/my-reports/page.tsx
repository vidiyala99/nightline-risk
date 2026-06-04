"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole, roleHome } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { AlertTriangle, CheckCircle2, Clock, Calendar, MapPin, Plus, ShieldAlert } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type IncidentStatus = "open" | "under_review" | "closed";
interface Incident {
  id: string;
  occurred_at: string;
  location: string;
  summary: string;
  status: IncidentStatus;
}

const STATUS_LABEL: Record<IncidentStatus, string> = {
  open: "Open",
  under_review: "Under Review",
  closed: "Closed",
};
const STATUS_ICON: Record<IncidentStatus, typeof AlertTriangle> = {
  open: AlertTriangle,
  under_review: Clock,
  closed: CheckCircle2,
};

// Floor-staff "My Reports" — the incidents this staff member filed (server
// scopes via /api/incidents/mine to reported_by_staff_id). Read-only.
export default function MyReportsPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { router.replace("/"); return; }
    if (role && role !== "staff") router.replace(roleHome(role));
  }, [isLoaded, isSignedIn, role, router]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/incidents/mine`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (!cancelled) setIncidents(Array.isArray(data) ? data : []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            MY REPORTS
            <span className="lc-eyebrow__sep" />
            FLOOR STAFF
          </span>
          <h1 className="lc-display">What you've <em>reported</em></h1>
          <p className="lc-sub">Every incident you've filed, and where it stands.</p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell" style={{ borderLeft: "none" }}>
            <button className="btn btn-primary" onClick={() => router.push("/report")}>
              <Plus size={16} /> New Report
            </button>
          </div>
        </div>
      </section>

      <div className="incidents-section">
        <div className="incidents-list stagger-children">
          {incidents.length > 0 ? (
            incidents.map((incident) => {
              const Icon = STATUS_ICON[incident.status] ?? AlertTriangle;
              return (
                <div key={incident.id} className={`incident-card incident-card--${incident.status}`}>
                  <div className={`incident-icon incident-icon--${incident.status}`}>
                    <Icon size={20} aria-hidden="true" />
                  </div>
                  <div className="incident-info">
                    <div className="incident-header-row">
                      <h4>{incident.summary.split(".")[0]}</h4>
                      <span className={`badge ${incident.status === "open" ? "badge-error" : incident.status === "under_review" ? "badge-warning" : "badge-success"}`}>
                        {STATUS_LABEL[incident.status]}
                      </span>
                    </div>
                    <p className="incident-desc">{incident.summary}</p>
                    <div className="incident-meta">
                      <span><Calendar size={12} />{new Date(incident.occurred_at).toLocaleDateString()}</span>
                      <span><MapPin size={12} />{incident.location}</span>
                    </div>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="page-empty">
              <ShieldAlert size={48} />
              <h3>No reports yet</h3>
              <p>When you file an incident, it shows up here.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
