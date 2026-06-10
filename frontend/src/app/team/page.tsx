"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth, useRole, useTenantId } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { Plus, Users, Copy, Mail } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface StaffMember {
  id: string;
  venue_id: string;
  name: string;
  email: string;
  role: string;
}

// Operator's "Floor Team" — provision and view staff logins for the venue.
// Each staff member gets a set-password link the operator relays.
export default function TeamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const isBroker = role === "broker" || role === "admin";

  const venueId = searchParams.get("venue") ?? tenantId ?? null;

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [invite, setInvite] = useState<{ name: string; url: string } | null>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/");
  }, [isLoaded, isSignedIn, router]);

  const load = () => {
    if (!venueId) { setLoading(false); return; }
    fetch(`${API_URL}/api/venues/${venueId}/staff`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setStaff(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(load, [venueId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!venueId) { toastError("No venue in scope."); return; }
    if (!name.trim() || !email.trim()) { toastError("Name and email are required."); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/staff`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: name.trim(), email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail?.message || data?.detail || `Server error ${res.status}`);
      const url = `${window.location.origin}/reset-password?token=${encodeURIComponent(data.set_password_token)}`;
      setInvite({ name: data.name, url });
      toastSuccess(`${data.name} added to the floor team`);
      setName(""); setEmail("");
      load();
    } catch (err: any) {
      toastError(err?.message || "Failed to add staff");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            FLOOR TEAM
            <span className="lc-eyebrow__sep" />
            {isBroker ? "BROKER" : "OPERATOR"}
          </span>
          <h1 className="lc-display">Your <em>floor team</em></h1>
          <p className="lc-sub">Give security, bar, and door staff a login so they can report incidents straight from the floor.</p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Staff</span>
            <strong>{staff.length.toString().padStart(2, "0")}</strong>
          </div>
        </div>
      </section>

      {!venueId ? (
        <div className="page-empty">
          <Users size={48} />
          <h3>No venue in scope</h3>
          <p>Open this from a venue to manage its floor team.</p>
        </div>
      ) : (
        <>
          <div className="form-shell" style={{ maxWidth: 960, margin: "0 0 var(--space-xl)" }}>
          <form id="addstaff-form" onSubmit={handleAdd} className="incident-form" style={{ maxWidth: "none", margin: 0 }}>
            <div className="incident-form-header">
              <div className="incident-form-dot" />
              <span className="incident-form-header-label">Add a staff member</span>
            </div>
            <div className="form-row">
              <div className="input-wrapper">
                <label className="input-label">Name</label>
                <input type="text" className="input-field" placeholder="e.g., Dana Ruiz" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
              </div>
              <div className="input-wrapper">
                <label className="input-label">Work email</label>
                <input type="email" className="input-field" placeholder="name@venue.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
              </div>
            </div>
          </form>

          <aside className="form-summary">
            <div className="form-summary__actions">
              <button type="submit" form="addstaff-form" className="btn btn-primary btn-sm" disabled={submitting}>
                <Plus size={14} aria-hidden style={{ marginRight: 4, verticalAlign: "-2px" }} />
                {submitting ? "Adding…" : "Add to team"}
              </button>
            </div>
            {invite ? (
              <div>
                <div className="form-summary__title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Mail size={12} aria-hidden style={{ color: "var(--accent-ink)" }} /> Set-password link · {invite.name}
                </div>
                <p className="text-xs text-secondary" style={{ margin: "0 0 8px" }}>
                  Send this to {invite.name} to set a password and sign in. Expires in 1 hour.
                </p>
                <code className="text-xs" style={{ wordBreak: "break-all", display: "block", color: "var(--text-secondary)", marginBottom: 8 }}>
                  {invite.url}
                </code>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => { navigator.clipboard?.writeText(invite.url); toastSuccess("Link copied"); }}
                >
                  <Copy size={14} aria-hidden style={{ marginRight: 4, verticalAlign: "-2px" }} /> Copy link
                </button>
              </div>
            ) : (
              <>
                <div className="form-summary__title">Floor team</div>
                <dl style={{ margin: 0 }}>
                  <div className="form-summary__row"><dt>Staff</dt><dd>{staff.length}</dd></div>
                </dl>
                <div className="form-summary__note">
                  Adding a member generates a one-hour set-password link to relay to them.
                </div>
              </>
            )}
          </aside>
          </div>

          <div className="incidents-section">
            <div className="incidents-list stagger-children">
              {staff.length > 0 ? (
                staff.map((s) => (
                  <div key={s.id} className="incident-card" style={{ cursor: "default" }}>
                    <div className="incident-icon"><Users size={20} aria-hidden="true" /></div>
                    <div className="incident-info">
                      <div className="incident-header-row">
                        <h4>{s.name}</h4>
                        <span className="badge">STAFF</span>
                      </div>
                      <div className="incident-meta">
                        <span><Mail size={12} />{s.email}</span>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="page-empty">
                  <Users size={48} />
                  <h3>No staff yet</h3>
                  <p>Add your floor team above so they can report incidents.</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
