"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole, roleHome } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { AlertTriangle, CheckCircle2, Clock, Calendar, MapPin, Plus, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Badge } from "@/components/ds/badge";

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
const STATUS_BADGE: Record<IncidentStatus, "destructive" | "warning" | "success"> = {
  open: "destructive",
  under_review: "warning",
  closed: "success",
};
const STATUS_ICON_TINT: Record<IncidentStatus, string> = {
  open: "bg-destructive/10 text-destructive",
  under_review: "bg-warning/15 text-warning-foreground",
  closed: "bg-success/15 text-success",
};

const DISPLAY = { fontFamily: "var(--font-display)" } as const;

// "Paper & Ink" floor-staff "My Reports" — the incidents this staff member
// filed (server scopes via /api/incidents/mine to reported_by_staff_id).
// Read-only. Migrated to the ds/ primitives; every text element carries an
// explicit colour (the migration rule).
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
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-end justify-between gap-6 py-10">
        <div>
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            My reports
            <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
            Floor staff
          </span>
          <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
            What you&apos;ve reported
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            Every incident you&apos;ve filed, and where it stands.
          </p>
        </div>
        <Button onClick={() => router.push("/report")} className="border border-foreground/15">
          <Plus className="size-4" /> New report
        </Button>
      </section>

      {/* ── list ───────────────────────────────────────────────────────── */}
      {incidents.length > 0 ? (
        <div className="flex flex-col gap-3">
          {incidents.map((incident) => {
            const Icon = STATUS_ICON[incident.status] ?? AlertTriangle;
            return (
              <Card key={incident.id} className="flex-row items-start gap-4 py-4">
                <div className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${STATUS_ICON_TINT[incident.status]}`}>
                  <Icon size={20} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1 px-0">
                  <div className="flex items-start justify-between gap-3">
                    <h4 className="font-semibold text-foreground">{incident.summary.split(".")[0]}</h4>
                    <Badge variant={STATUS_BADGE[incident.status]}>{STATUS_LABEL[incident.status]}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{incident.summary}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Calendar size={12} />{new Date(incident.occurred_at).toLocaleDateString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin size={12} />{incident.location}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
          <ShieldAlert size={48} className="text-muted-foreground" />
          <h3 className="text-lg font-semibold text-foreground">No reports yet</h3>
          <p className="text-sm text-muted-foreground">When you file an incident, it shows up here.</p>
        </div>
      )}
    </div>
  );
}
