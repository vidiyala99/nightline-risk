"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTenantId, useAuth, useRole } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import { authHeaders } from "@/lib/authFetch";
import { CheckSquare, Upload, Clock, AlertCircle, X } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ComplianceItem {
  id: string;
  title?: string;
  description: string;
  severity: string;
}

interface VenueWithCompliance {
  id: string;
  name: string;
  venue_type: string;
  compliance_actions: number;
}

export default function CompliancePage() {
  return (
    <Suspense fallback={<div className="page-loading"><div className="loading-spinner" /></div>}>
      <CompliancePageInner />
    </Suspense>
  );
}

function CompliancePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const isBroker = role === "broker" || role === "admin";

  // ?venue=<id> scopes the page to a single venue's queue (operator-style
  // detail view) regardless of role. Set by sidebar navigation from a
  // venue's /terminal page or by the dashboard Compliance stat card.
  const filterVenueId = searchParams.get("venue");
  const [filterVenueName, setFilterVenueName] = useState<string | null>(null);

  // Effective venue id used by the queue/upload paths
  const detailVenueId = filterVenueId ?? (!isBroker ? tenantId : null);

  // Operator/detail state
  const [complianceItems, setComplianceItems] = useState<ComplianceItem[]>([]);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Broker portfolio state (only when no ?venue filter)
  const [brokerVenues, setBrokerVenues] = useState<VenueWithCompliance[]>([]);

  // All venues for the broker dropdown (independent of compliance counts)
  const [allVenues, setAllVenues] = useState<Array<{ id: string; name: string }>>([]);

  const [loading, setLoading] = useState(true);

  // Populate the broker venue picker
  useEffect(() => {
    if (!isBroker) return;
    fetch(`${API_URL}/api/venues`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setAllVenues(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [isBroker]);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    async function fetchCompliance() {
      try {
        // Detail view (single venue) — used when ?venue is set OR for operators
        if (detailVenueId) {
          const res = await fetch(`${API_URL}/api/venues/${detailVenueId}/live`, { headers: authHeaders() });
          if (res.ok) {
            const state = await res.json();
            setComplianceItems(state.compliance_queue || []);
          } else {
            setComplianceItems([]);
          }
        } else if (isBroker) {
          // Broker portfolio summary
          const res = await fetch(`${API_URL}/api/portfolio`, { headers: authHeaders() });
          if (res.ok) {
            const venues: VenueWithCompliance[] = await res.json();
            setBrokerVenues(venues.filter((v) => (v.compliance_actions ?? 0) > 0));
          }
        } else {
          // Operator without tenant_id (mid-onboarding)
          setComplianceItems([]);
        }
      } catch (error) {
        console.error("Failed to fetch compliance:", error);
      } finally {
        setLoading(false);
      }
    }
    if (isLoaded && isSignedIn) fetchCompliance();
  }, [detailVenueId, isBroker, isLoaded, isSignedIn]);

  // Look up filter venue name for the chip
  useEffect(() => {
    if (!filterVenueId) { setFilterVenueName(null); return; }
    let cancelled = false;
    fetch(`${API_URL}/api/venues/${filterVenueId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) setFilterVenueName(data?.name ?? filterVenueId); })
      .catch(() => { if (!cancelled) setFilterVenueName(filterVenueId); });
    return () => { cancelled = true; };
  }, [filterVenueId]);

  const handleUpload = async (itemId: string, event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !detailVenueId) return;
    setUploadingId(itemId);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_URL}/api/venues/${detailVenueId}/compliance/${itemId}/upload`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      toastSuccess("Evidence uploaded successfully");
      setComplianceItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch (error) {
      toastError("Failed to upload evidence");
    } finally {
      setUploadingId(null);
      const input = document.getElementById(`upload-${itemId}`) as HTMLInputElement | null;
      if (input) input.value = "";
    }
  };

  const handleWaive = async (itemId: string) => {
    if (!detailVenueId) return;
    const reason = window.prompt(
      "Resolve / waive this compliance item without operator evidence?\nOptionally note why (recorded in the audit trail):",
      "",
    );
    if (reason === null) return; // cancelled
    setResolvingId(itemId);
    try {
      const res = await fetch(`${API_URL}/api/venues/${detailVenueId}/compliance/${itemId}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ reason: reason || null }),
      });
      if (!res.ok) throw new Error("Resolve failed");
      toastSuccess("Compliance item resolved");
      setComplianceItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch {
      toastError("Failed to resolve item");
    } finally {
      setResolvingId(null);
    }
  };

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const showDetailView = !!detailVenueId;
  const openItemCount = complianceItems.length;

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            COMPLIANCE
            <span className="lc-eyebrow__sep" />
            {filterVenueId
              ? (filterVenueName ?? filterVenueId).toUpperCase()
              : isBroker ? "BROKER · PORTFOLIO" : "OPERATOR · QUEUE"}
          </span>
          <h1 className="lc-display">
            {isBroker ? <>Portfolio <em>compliance</em></> : <>Tonight's <em>checks</em></>}
          </h1>
          <p className="lc-sub">
            {filterVenueId
              ? `Compliance queue for ${filterVenueName ?? filterVenueId}.`
              : isBroker
                ? "Pending compliance actions across your insured venues. Clear them to keep coverage in force."
                : "Complete the actions below to keep your coverage in good standing tonight."}
          </p>
        </div>

        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Open</span>
            <strong style={{ color: openItemCount > 0 ? "var(--state-warning)" : undefined }}>
              {openItemCount.toString().padStart(2, "0")}
            </strong>
          </div>
          {isBroker && (
            <div className="lc-meta-cell" style={{ borderLeft: "none" }}>
              <span className="lc-stat-label" style={{ display: "block", marginBottom: 6 }}>Venue</span>
              <select
                id="compliance-venue-filter"
                value={filterVenueId ?? ""}
                onChange={(e) => {
                  const next = e.target.value;
                  router.push(next ? `/compliance?venue=${encodeURIComponent(next)}` : "/compliance");
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
                  width: "100%",
                  maxWidth: 220,
                }}
              >
                <option value="">All venues ({allVenues.length})</option>
                {allVenues.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name ?? v.id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </section>

      {filterVenueId && (
        <div className="mb-lg" style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}>
          <span className="text-xs uppercase tracking-wide text-muted font-mono">Filtered by</span>
          <button
            onClick={() => router.push("/compliance")}
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

      {showDetailView ? (
        // Detail view — single venue's compliance queue (operator default OR ?venue= filter)
        complianceItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><CheckSquare size={48} /></div>
            <h2>All Clear</h2>
            <p>No pending compliance actions at this time.</p>
          </div>
        ) : (
          <div className="compliance-grid">
            {complianceItems.map((item) => (
              <Link
                key={item.id}
                href={`/compliance/${encodeURIComponent(detailVenueId!)}/${encodeURIComponent(item.id)}`}
                className="compliance-card"
                style={{ display: "block", textDecoration: "none", color: "inherit" }}
              >
                <div className="compliance-header">
                  <AlertCircle size={18} />
                  <span>{item.title || item.id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
                  {item.id.startsWith("STARTER_") && (
                    <span
                      title="Onboarding task — not a risk flag"
                      style={{
                        fontFamily: "var(--font-mono)", fontSize: "0.6rem", fontWeight: 700,
                        letterSpacing: "0.05em", padding: "1px 6px", color: "var(--text-secondary)",
                        background: "var(--bg-surface)", border: "1px solid var(--border-default)",
                      }}
                    >
                      STARTER
                    </span>
                  )}
                </div>
                <p className="compliance-desc">{item.description}</p>
                <div className="compliance-meta">
                  <span className="severity-tag">
                    <Clock size={12} />
                    {item.severity}
                  </span>
                </div>
                {!isBroker ? (
                  // stopPropagation only — preventDefault would block the
                  // label→input file picker activation (per HTML spec, a
                  // click whose defaultPrevented is true on a label does
                  // not forward to the associated input).
                  <div
                    className="compliance-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="file"
                      accept="video/*,image/*,application/pdf"
                      className="visually-hidden"
                      id={`upload-${item.id}`}
                      onChange={(e) => handleUpload(item.id, e)}
                    />
                    <label
                      htmlFor={`upload-${item.id}`}
                      className={`btn btn-secondary${uploadingId === item.id ? " disabled" : ""}`}
                      style={{ cursor: uploadingId === item.id ? "not-allowed" : "pointer" }}
                    >
                      {uploadingId === item.id ? (
                        <><div className="loading-spinner loading-spinner-sm" />Uploading...</>
                      ) : (
                        <><Upload size={18} />Upload Evidence</>
                      )}
                    </label>
                  </div>
                ) : (
                  <div
                    className="compliance-actions"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                  >
                    <button
                      type="button"
                      className={`btn btn-secondary${resolvingId === item.id ? " disabled" : ""}`}
                      onClick={() => handleWaive(item.id)}
                      disabled={resolvingId === item.id}
                    >
                      {resolvingId === item.id ? (
                        <><div className="loading-spinner loading-spinner-sm" />Resolving...</>
                      ) : (
                        <><CheckSquare size={18} />Resolve / Waive</>
                      )}
                    </button>
                  </div>
                )}
              </Link>
            ))}
          </div>
        )
      ) : isBroker ? (
        // Broker portfolio summary — venues with pending compliance actions
        brokerVenues.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon"><CheckSquare size={48} /></div>
            <h2>All Clear</h2>
            <p>No pending compliance actions across portfolio.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-lg">
            {brokerVenues.map((venue) => (
              <div
                key={venue.id}
                className="card"
                style={{ cursor: "pointer" }}
                onClick={() => router.push(`/compliance?venue=${encodeURIComponent(venue.id)}`)}
              >
                <div className="flex items-center justify-between mb-md">
                  <div>
                    <div className="text-xxs uppercase tracking-wide text-secondary mb-xs">{venue.venue_type?.replace(/_/g, " ")}</div>
                    <h3 className="text-lg font-bold">{venue.name ?? venue.id}</h3>
                  </div>
                  <span className="text-2xl font-bold" style={{ color: "var(--state-warning)" }}>
                    {venue.compliance_actions}
                    <span className="text-xs text-secondary ml-xs">pending</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        // Operator without tenant_id (mid-onboarding)
        <div className="empty-state">
          <div className="empty-icon"><CheckSquare size={48} /></div>
          <h2>No Venue Yet</h2>
          <p>Set up your venue first to see compliance actions.</p>
        </div>
      )}
    </div>
  );
}
