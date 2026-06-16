"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useRole, useTenantId, useAuth } from "@/contexts/AuthContext";
import { Building2, MapPin, Users, Plus, ArrowRight, X, Edit2, Check } from "lucide-react";
import Link from "next/link";
import { toastSuccess, toastError } from "@/lib/toast";
import { authHeaders } from "@/lib/authFetch";
import { TierBadge, type Tier as UiTier } from "@/components/ui/TierBadge";
import { SearchInput } from "@/components/ui/SearchInput";
import { FilterSelect } from "@/components/ui/FilterSelect";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Venue {
  id: string;
  name: string;
  address?: string;
  capacity?: number;
  venue_type?: string;
  renewal_date?: string;
  years_in_operation?: number;
  // Broker roster reads /api/portfolio, which carries live risk posture.
  tier?: string;
  total_score?: number;
  borough?: string;
}

const VENUE_TYPES = [
  "bar", "nightclub", "music venue and bar", "nightclub and performance space",
  "outdoor music venue", "outdoor bar and music venue", "DIY music venue and bar",
  "restaurant and bar", "lounge",
];

const EMPTY_FORM = { name: "", address: "", capacity: "", venue_type: "bar", renewal_date: "", years_in_operation: "" };

const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };
type VenueSort = "tier" | "score" | "renewal" | "name";

export default function VenuesPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded, user, refreshUser } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const extraVenueIds = user?.extra_venue_ids ?? [];
  const extraIdsKey = extraVenueIds.join(",");
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Partial<Venue>>({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [searchQuery, setSearchQuery] = useState("");
  // Broker roster controls (operators have ≤ a few venues — no need to filter/sort).
  const [vtype, setVtype] = useState("all");
  const [borough, setBorough] = useState("all");
  const [sort, setSort] = useState<VenueSort>("tier");

  const isBroker = role === "broker" || role === "admin";
  const isOperator = role === "venue_operator";

  const types = useMemo(
    () => Array.from(new Set(venues.map(v => v.venue_type).filter(Boolean))).sort() as string[],
    [venues],
  );
  const boroughs = useMemo(
    () => Array.from(new Set(venues.map(v => v.borough).filter(Boolean))).sort() as string[],
    [venues],
  );

  const filteredVenues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const out = venues.filter(v => {
      if (isBroker && vtype !== "all" && v.venue_type !== vtype) return false;
      if (isBroker && borough !== "all" && v.borough !== borough) return false;
      if (q) {
        const hay = `${v.name} ${v.address ?? ""} ${v.venue_type ?? ""} ${v.borough ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (!isBroker) return out;
    return [...out].sort((a, b) => {
      if (sort === "score") return (b.total_score ?? 0) - (a.total_score ?? 0);
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "renewal") return (a.renewal_date || "9999").localeCompare(b.renewal_date || "9999");
      // tier A→D, then score desc as tiebreaker
      const t = (TIER_ORDER[a.tier ?? ""] ?? 9) - (TIER_ORDER[b.tier ?? ""] ?? 9);
      return t !== 0 ? t : (b.total_score ?? 0) - (a.total_score ?? 0);
    });
  }, [venues, searchQuery, isBroker, vtype, borough, sort]);

  useEffect(() => {
    // Wait for auth to hydrate before redirecting — otherwise a cold load /
    // refresh / deep-link bounces a logged-in user to /login (hydration race).
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    async function fetchVenues() {
      // Brokers read the portfolio rollup so the roster carries live risk
      // posture (tier/score/borough) — same source as the dashboard Book.
      try {
        const res = await fetch(`${API_URL}/api/portfolio?source=book`, { headers: authHeaders() });
        const data = await res.json();
        setVenues(Array.isArray(data) ? data : []);
      } catch {
        setVenues([]);
      } finally {
        setLoading(false);
      }
    }

    async function fetchVenueById(id: string): Promise<Venue | null> {
      try {
        const res = await fetch(`${API_URL}/api/venues/${id}`, {
          headers: authHeaders(),
        });
        return res.ok ? ((await res.json()) as Venue) : null;
      } catch {
        return null;
      }
    }

    async function fetchOperatorVenue() {
      if (!tenantId) { setLoading(false); return; }
      const ids = extraIdsKey ? extraIdsKey.split(",") : [];
      try {
        const [primary, ...extras] = await Promise.all([
          fetchVenueById(tenantId),
          ...ids.map(fetchVenueById),
        ]);
        setVenues([primary, ...extras].filter((v): v is Venue => v != null));
      } catch {
        setVenues([]);
      } finally {
        setLoading(false);
      }
    }

    if (isBroker) fetchVenues();
    else fetchOperatorVenue();
  }, [isBroker, tenantId, extraIdsKey]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim()) { toastError("Venue name is required"); return; }
    setSubmitting(true);
    try {
      const body: Record<string, any> = {
        ...formData,
        capacity: formData.capacity ? parseInt(formData.capacity) : 300,
        years_in_operation: formData.years_in_operation ? parseInt(formData.years_in_operation) : 1,
      };
      // For operators adding their first (primary) venue, pin it to the tenant ID.
      const isFirstOperatorVenue = isOperator && venues.length === 0 && !!tenantId;
      if (isFirstOperatorVenue) body.id = tenantId;

      const res = await fetch(`${API_URL}/api/venues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Failed to add venue");
      }
      const newVenue = await res.json();

      // Operator extras must be linked to the user so they show up cross-device
      // and on subsequent loads. Brokers see all venues via /api/portfolio already.
      if (isOperator && !isFirstOperatorVenue) {
        const token = localStorage.getItem("auth_token");
        if (token) {
          await fetch(`${API_URL}/api/auth/me/extra-venues/${newVenue.id}`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
          });
          await refreshUser();
        }
      }

      setVenues(prev => [...prev, newVenue]);
      setShowForm(false);
      setFormData(EMPTY_FORM);
      toastSuccess(`${newVenue.name} added successfully`);
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Failed to add venue");
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = (venue: Venue) => {
    setEditingId(venue.id);
    setEditData({
      name: venue.name,
      address: venue.address ?? "",
      capacity: venue.capacity,
      venue_type: venue.venue_type ?? "bar",
      years_in_operation: venue.years_in_operation,
    });
  };

  const saveEdit = async (venueId: string) => {
    setSavingEdit(true);
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(editData),
      });
      if (!res.ok) throw new Error("Failed to update venue");
      const updated = await res.json();
      setVenues(prev => prev.map(v => v.id === venueId ? { ...v, ...updated } : v));
      setEditingId(null);
      toastSuccess("Venue updated");
    } catch {
      toastError("Failed to save changes");
    } finally {
      setSavingEdit(false);
    }
  };

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const venueCount = venues.length;
  const filteredCount = filteredVenues.length;

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <style>{`
        .vn-controls { display:flex; flex-wrap:wrap; gap:var(--space-sm); align-items:center; margin-bottom:var(--space-md); }
        .vn-controls .lc-search { flex:1 1 220px; margin-bottom:0; }
        .vn-card-meta { display:flex; flex-direction:column; align-items:flex-end; gap:4px; }
        .vn-card-score { font-family:var(--font-mono); font-size:0.85rem; color:var(--text-secondary); }
      `}</style>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">
            VENUES
            <span className="lc-eyebrow__sep" />
            {isBroker ? "BROKER · PORTFOLIO" : "OPERATOR · PROPERTIES"}
          </span>
          <h1 className="lc-display">
            {isBroker ? <>Portfolio <em>venues</em></> : <>Your <em>venues</em></>}
          </h1>
          <p className="lc-sub">
            {isBroker
              ? "Every venue you underwrite — capacity, address, renewal date, and live risk posture in one list."
              : "Add and maintain the venues you operate. Each one drives its own risk profile and premium quote."}
          </p>
        </div>

        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Total</span>
            <strong>{venueCount.toString().padStart(2, "0")}</strong>
          </div>
          {isBroker && (searchQuery.trim() || vtype !== "all" || borough !== "all") && (
            <div className="lc-meta-cell">
              <span className="lc-stat-label">Showing</span>
              <strong>{filteredCount.toString().padStart(2, "0")}</strong>
            </div>
          )}
          {!isBroker && (
            <div className="lc-meta-cell" style={{ borderLeft: "none" }}>
              <button data-testid="add-venue" className="btn btn-primary" onClick={() => setShowForm(true)}>
                <Plus size={16} /> Add Venue
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Add Venue Modal */}
      {showForm && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: "var(--space-xl)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowForm(false); }}
        >
          <div className="card" style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto" }}>
            <div className="flex justify-between items-center mb-xl">
              <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Add Venue</h2>
              <button onClick={() => setShowForm(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-secondary)" }}>
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col gap-lg">
              <div className="form-group">
                <label className="form-label">Venue Name *</label>
                <input className="input-field" placeholder="e.g. The Blue Room" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} required />
              </div>
              <div className="form-group">
                <label className="form-label">Venue Type</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                  {VENUE_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setFormData({ ...formData, venue_type: t })}
                      style={{
                        padding: "6px 14px",
                        borderRadius: "8px",
                        border: `1px solid ${formData.venue_type === t ? "var(--brand-primary)" : "rgba(255,255,255,0.1)"}`,
                        background: formData.venue_type === t ? "rgba(200,240,0,0.08)" : "var(--bg-surface)",
                        color: formData.venue_type === t ? "var(--accent-ink)" : "var(--text-tertiary)",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.15s",
                        textTransform: "capitalize",
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Address</label>
                <input className="input-field" placeholder="123 Main St, Brooklyn, NY" value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} />
              </div>
              <div className="form-row">
                <div className="input-wrapper">
                  <label className="input-label">Capacity</label>
                  <input className="input-field" type="number" placeholder="300" min={1} value={formData.capacity} onChange={(e) => setFormData({ ...formData, capacity: e.target.value })} />
                </div>
                <div className="input-wrapper">
                  <label className="input-label">Years in Operation</label>
                  <input className="input-field" type="number" placeholder="3" min={0} value={formData.years_in_operation} onChange={(e) => setFormData({ ...formData, years_in_operation: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Policy Renewal Date</label>
                <input className="input-field" type="date" value={formData.renewal_date} onChange={(e) => setFormData({ ...formData, renewal_date: e.target.value })} />
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? "Adding..." : "Add Venue"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isBroker && (
        <div className="vn-controls">
          <SearchInput
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder="Search venues, types, addresses…"
          />
          {boroughs.length > 0 && (
            <FilterSelect
              ariaLabel="Borough"
              value={borough}
              onChange={setBorough}
              options={[{ value: "all", label: "All boroughs" }, ...boroughs.map(b => ({ value: b, label: b }))]}
            />
          )}
          <FilterSelect
            ariaLabel="Venue type"
            value={vtype}
            onChange={setVtype}
            options={[{ value: "all", label: "All types" }, ...types.map(t => ({ value: t, label: t }))]}
          />
          <FilterSelect
            ariaLabel="Sort by"
            value={sort}
            onChange={(v) => setSort(v as VenueSort)}
            options={[
              { value: "tier", label: "Sort: tier" },
              { value: "score", label: "Sort: score" },
              { value: "renewal", label: "Sort: renewal" },
              { value: "name", label: "Sort: name" },
            ]}
          />
        </div>
      )}

      <div className="lc-rule">
        <span className="lc-rule__label">Roster</span>
        <span className="lc-rule__count">
          {searchQuery.trim() || vtype !== "all" || borough !== "all" ? `${filteredCount} / ${venueCount}` : String(venueCount).padStart(2, "0")} venues
        </span>
        <div className="lc-rule__line" />
      </div>

      <div className="venues-grid" data-testid="venues-grid">
        {filteredVenues.map((venue) => {
          // Both personas drill into the venue's risk profile — the canonical
          // venue-detail surface. (The live terminal was retired.)
          const detailHref = `/risk-profile/${venue.id}`;
          return (
          <div key={venue.id} data-testid="venue-card" className="venue-card" style={{ textDecoration: "none", display: "block" }}>
            {editingId === venue.id ? (
              /* Inline edit form */
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", width: "100%" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", color: "var(--text-tertiary)", textTransform: "uppercase" }}>Editing</span>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button onClick={() => setEditingId(null)} className="btn btn-ghost" style={{ padding: "4px 10px", fontSize: "0.75rem" }}>Cancel</button>
                    <button onClick={() => saveEdit(venue.id)} className="btn btn-primary" disabled={savingEdit} style={{ padding: "4px 12px", fontSize: "0.75rem" }}>
                      {savingEdit ? "Saving..." : <><Check size={13} /> Save</>}
                    </button>
                  </div>
                </div>
                <input className="input-field" placeholder="Venue name" value={editData.name ?? ""} onChange={(e) => setEditData({ ...editData, name: e.target.value })} style={{ fontSize: "0.9rem" }} />
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                  {VENUE_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setEditData({ ...editData, venue_type: t })}
                      style={{
                        padding: "5px 12px",
                        borderRadius: "8px",
                        border: `1px solid ${editData.venue_type === t ? "var(--brand-primary)" : "rgba(255,255,255,0.1)"}`,
                        background: editData.venue_type === t ? "rgba(200,240,0,0.08)" : "var(--bg-surface)",
                        color: editData.venue_type === t ? "var(--accent-ink)" : "var(--text-tertiary)",
                        fontSize: "0.72rem",
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.15s",
                        textTransform: "capitalize",
                      }}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <input className="input-field" placeholder="Address" value={editData.address ?? ""} onChange={(e) => setEditData({ ...editData, address: e.target.value })} style={{ fontSize: "0.9rem" }} />
                <div style={{ display: "flex", gap: "8px" }}>
                  <input className="input-field" type="number" placeholder="Capacity" value={editData.capacity ?? ""} onChange={(e) => setEditData({ ...editData, capacity: parseInt(e.target.value) || undefined })} style={{ fontSize: "0.9rem" }} />
                  <input className="input-field" type="number" placeholder="Years open" value={editData.years_in_operation ?? ""} onChange={(e) => setEditData({ ...editData, years_in_operation: parseInt(e.target.value) || undefined })} style={{ fontSize: "0.9rem" }} />
                </div>
              </div>
            ) : (
              /* Read view */
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", width: "100%", gap: "8px" }}>
                <Link href={detailHref} style={{ textDecoration: "none", display: "flex", gap: "12px", alignItems: "flex-start", flex: 1, color: "inherit" }}>
                  <div className="venue-icon"><Building2 size={24} /></div>
                  <div className="venue-info">
                    <h3>{venue.name}</h3>
                    {venue.venue_type && (
                      <p className="venue-address" style={{ color: "var(--text-tertiary)", textTransform: "uppercase", fontSize: "0.7rem", letterSpacing: "0.05em" }}>
                        {venue.venue_type}{venue.borough ? ` · ${venue.borough}` : ""}
                      </p>
                    )}
                    {venue.address && <p className="venue-address"><MapPin size={12} />{venue.address}</p>}
                    {venue.capacity && (
                      <p className="venue-capacity">
                        <Users size={12} />
                        Cap. {venue.capacity.toLocaleString()}
                        {venue.renewal_date && <span style={{ marginLeft: "8px", color: "var(--text-tertiary)" }}>· Renewal {venue.renewal_date}</span>}
                      </p>
                    )}
                  </div>
                </Link>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
                  {isBroker && venue.tier && (
                    <div className="vn-card-meta">
                      <TierBadge tier={venue.tier as UiTier} />
                      {venue.total_score != null && <span className="vn-card-score">{venue.total_score}</span>}
                    </div>
                  )}
                  {!isBroker && (
                    <button
                      onClick={() => startEdit(venue)}
                      style={{ background: "none", border: "1px solid var(--border-subtle)", borderRadius: "6px", padding: "5px 8px", cursor: "pointer", color: "var(--text-tertiary)", display: "flex", alignItems: "center", gap: "4px", fontSize: "0.75rem" }}
                    >
                      <Edit2 size={12} /> Edit
                    </button>
                  )}
                  <Link href={detailHref} style={{ color: "inherit" }} title={isBroker ? "Open risk profile" : "Open terminal"}>
                    <ArrowRight size={20} className="venue-arrow" />
                  </Link>
                </div>
              </div>
            )}
          </div>
          );
        })}
      </div>

      {filteredVenues.length === 0 && !loading && (
        <div className="page-empty">
          <Building2 size={48} />
          <h3>No Venues Yet</h3>
          <p>{searchQuery.trim() || vtype !== "all" || borough !== "all" ? "No venues match this view" : isBroker ? "No venues on record yet" : "Set up your venue to generate a risk profile and premium quote"}</p>
          {!isBroker && (
            <button className="btn btn-primary" style={{ marginTop: "16px" }} onClick={() => setShowForm(true)}>
              <Plus size={16} /> Add Your Venue
            </button>
          )}
        </div>
      )}
    </div>
  );
}
