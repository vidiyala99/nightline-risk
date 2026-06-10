"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useTenantId, useRole, roleHome } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { AlertTriangle } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// Floor-staff incident report — the staff persona's primary screen. Files
// against the staff member's own venue (tenant_id); the backend attributes it
// to them (reported_by_staff_id) and runs the normal evaluation pipeline.
export default function StaffReportPage() {
  const router = useRouter();
  const { user, isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();

  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    occurred_at: "",
    location: "",
    summary: "",
    reported_by: "",
    injury_observed: false,
    police_called: false,
    ems_called: false,
  });

  // Prefill the reporter name once the user hydrates.
  useEffect(() => {
    if (user?.name) setForm((f) => (f.reported_by ? f : { ...f, reported_by: user.name }));
  }, [user?.name]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) { router.replace("/"); return; }
    // Non-staff personas have their own richer flows — send them home.
    if (role && role !== "staff") router.replace(roleHome(role));
  }, [isLoaded, isSignedIn, role, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId) { toastError("Your account isn't linked to a venue yet."); return; }
    if (!form.occurred_at) { toastError("Please enter when it happened."); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/venues/${tenantId}/incidents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ ...form, occurred_at: new Date(form.occurred_at).toISOString() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.detail?.message || err?.detail || `Server error ${res.status}`);
      }
      toastSuccess("Report submitted. Thank you.");
      router.push("/my-reports");
    } catch (err: any) {
      toastError(err?.message || "Failed to submit report");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isSignedIn) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            REPORT
            <span className="lc-eyebrow__sep" />
            FLOOR STAFF
          </span>
          <h1 className="lc-display">Report an <em>incident</em></h1>
          <p className="lc-sub">Tell us what happened on the floor. Your manager and broker pick it up from here.</p>
        </div>
      </section>

      <div className="form-shell" style={{ maxWidth: 960, margin: "0 auto" }}>
      <form id="report-form" onSubmit={handleSubmit} className="incident-form" style={{ maxWidth: "none", margin: 0 }}>
        <div className="incident-form-header">
          <div className="incident-form-dot" />
          <span className="incident-form-header-label">Incident Report</span>
        </div>

        <div className="form-row">
          <div className="input-wrapper">
            <label className="input-label">When did it happen?</label>
            <input
              type="datetime-local"
              className="input-field"
              value={form.occurred_at}
              onChange={(e) => setForm({ ...form, occurred_at: e.target.value })}
              required
            />
          </div>
          <div className="input-wrapper">
            <label className="input-label">Where?</label>
            <input
              type="text"
              className="input-field"
              placeholder="e.g., rear bar, dance floor, front door"
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              autoComplete="off"
              required
            />
          </div>
        </div>

        <div className="input-wrapper">
          <label className="input-label">What happened?</label>
          <textarea
            className="input-field form-textarea"
            placeholder="Describe what you saw — who was involved, what was done..."
            value={form.summary}
            onChange={(e) => setForm({ ...form, summary: e.target.value })}
            required
          />
        </div>

        <div className="input-wrapper">
          <label className="input-label">Your name</label>
          <input
            type="text"
            className="input-field"
            placeholder="Your name"
            value={form.reported_by}
            onChange={(e) => setForm({ ...form, reported_by: e.target.value })}
            required
          />
        </div>

        <div className="checkbox-group">
          <label className="checkbox-label"><input type="checkbox" checked={form.injury_observed} onChange={(e) => setForm({ ...form, injury_observed: e.target.checked })} /><span>Someone was injured</span></label>
          <label className="checkbox-label"><input type="checkbox" checked={form.police_called} onChange={(e) => setForm({ ...form, police_called: e.target.checked })} /><span>Police were called</span></label>
          <label className="checkbox-label"><input type="checkbox" checked={form.ems_called} onChange={(e) => setForm({ ...form, ems_called: e.target.checked })} /><span>EMS / ambulance was called</span></label>
        </div>

      </form>

      <aside className="form-summary">
        <div className="form-summary__actions">
          <button type="submit" form="report-form" className="btn btn-primary btn-sm" disabled={submitting}>
            <AlertTriangle size={14} aria-hidden style={{ marginRight: 4, verticalAlign: "-2px" }} />
            {submitting ? "Submitting…" : "Submit Report"}
          </button>
        </div>
        <div className="form-summary__title">This report</div>
        <dl style={{ margin: 0 }}>
          <div className="form-summary__row"><dt>When</dt><dd>{form.occurred_at ? form.occurred_at.replace("T", " ") : "—"}</dd></div>
          <div className="form-summary__row"><dt>Where</dt><dd>{form.location || "—"}</dd></div>
          <div className="form-summary__row"><dt>Reporter</dt><dd>{form.reported_by || "—"}</dd></div>
        </dl>
        {(form.injury_observed || form.police_called || form.ems_called) && (
          <div className="form-summary__note" style={{ color: "var(--tier-d)" }}>
            Flagged: {[form.injury_observed && "Injury", form.police_called && "Police", form.ems_called && "EMS"].filter(Boolean).join(" · ")}
          </div>
        )}
      </aside>
      </div>
    </div>
  );
}
