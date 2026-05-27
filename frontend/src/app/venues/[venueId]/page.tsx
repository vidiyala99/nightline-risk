"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { ArrowLeft } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Venue {
  id?: string;
  name?: string;
  venue_type?: string;
  address?: string;
  capacity?: number;
  years_in_operation?: number;
  security_level?: string;
  current_carrier?: string;
  renewal_date?: string;
}

function humanize(value?: string): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function VenueProfilePage() {
  const { venueId } = useParams<{ venueId: string }>();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();

  const [venue, setVenue] = useState<Venue | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!venueId || !isSignedIn) return;
    let cancelled = false;
    fetch(`${API_URL}/api/venues/${venueId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) setVenue(data); })
      .catch(() => { if (!cancelled) setVenue(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [venueId, isSignedIn]);

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const name = venue?.name ?? "Venue";
  const rows: { label: string; value: string }[] = [
    { label: "Venue Type", value: humanize(venue?.venue_type) },
    { label: "Address", value: venue?.address || "—" },
    { label: "Capacity", value: venue?.capacity != null ? `${venue.capacity.toLocaleString()} pax` : "—" },
    { label: "Years in Operation", value: venue?.years_in_operation != null ? String(venue.years_in_operation) : "—" },
    { label: "Security Level", value: humanize(venue?.security_level) },
    { label: "Current Carrier", value: venue?.current_carrier || "—" },
    { label: "Renewal Date", value: venue?.renewal_date || "—" },
  ];

  return (
    <div className="theme-venue page">
      <div className="mb-md">
        <Link
          href={`/risk-profile/${venueId}`}
          style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.85rem" }}
        >
          <ArrowLeft size={16} /> Back to Risk Profile
        </Link>
      </div>

      <span className="lc-eyebrow">Business Profile</span>
      <h1 className="lc-display" style={{ fontSize: "clamp(1.75rem, 4vw, 2.5rem)", marginBottom: "var(--space-lg)" }}>{name}</h1>

      {!venue ? (
        <div className="card"><p className="text-secondary">Venue details unavailable.</p></div>
      ) : (
        <div className="card" style={{ maxWidth: 560 }}>
          {rows.map((row, i) => (
            <div
              key={row.label}
              className="flex items-center justify-between"
              style={{
                gap: 16,
                padding: "14px 0",
                borderTop: i > 0 ? "1px solid var(--border-subtle)" : undefined,
              }}
            >
              <span className="text-xs uppercase tracking-wide text-secondary">{row.label}</span>
              <span className="text-sm font-mono" style={{ textAlign: "right" }}>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
