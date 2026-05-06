"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useRole, useTenantId, useAuth } from "@/contexts/AuthContext";
import { Building2, MapPin, Users, Plus, ArrowRight, LogOut } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Venue {
  id: string;
  name: string;
  address?: string;
  capacity?: number;
}

export default function VenuesPage() {
  const router = useRouter();
  const { signOut, isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const tenantId = useTenantId();
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);

  const isBroker = role === "broker" || role === "admin";

  useEffect(() => {
    if (!isSignedIn) {
      router.push("/login");
    }
  }, [isSignedIn, router]);

  useEffect(() => {
    async function fetchVenues() {
      try {
        const res = await fetch(`${API_URL}/api/venues`);
        const data = await res.json();
        setVenues(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error("Failed to fetch venues:", error);
        setVenues([]);
      } finally {
        setLoading(false);
      }
    }

    if (isBroker) {
      fetchVenues();
    } else if (tenantId) {
      setVenues([{ id: tenantId, name: "My Venue" }]);
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [isBroker, tenantId]);

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
    <div className="page theme-venue">
      <header className="page-header">
        <div>
          <h1>Venues</h1>
          <p className="page-subtitle">
            {isBroker
              ? "Manage your insured venues"
              : "Your venue information"}
          </p>
        </div>
        <button onClick={handleSignOut} className="btn btn-ghost">
          <LogOut size={18} />
          Sign Out
        </button>
      </header>

      {isBroker && (
        <div className="page-actions">
          <button className="btn btn-primary">
            <Plus size={18} />
            Add Venue
          </button>
        </div>
      )}

      <div className="venues-grid">
        {venues.map((venue) => (
          <div key={venue.id} className="venue-card">
            <div className="venue-icon">
              <Building2 size={24} />
            </div>
            <div className="venue-info">
              <h3>{venue.name}</h3>
              {venue.address && (
                <p className="venue-address">
                  <MapPin size={14} />
                  {venue.address}
                </p>
              )}
              {venue.capacity && (
                <p className="venue-capacity">
                  <Users size={14} />
                  Capacity: {venue.capacity}
                </p>
              )}
            </div>
            <ArrowRight size={20} className="venue-arrow" />
          </div>
        ))}
      </div>

      {venues.length === 0 && !loading && (
        <div className="page-empty">
          <Building2 size={48} />
          <h3>No Venues Found</h3>
          <p>
            {isBroker
              ? "Add your first venue to get started"
              : "Contact your administrator for venue access"}
          </p>
        </div>
      )}
    </div>
  );
}
