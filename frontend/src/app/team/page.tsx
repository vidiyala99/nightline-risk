"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth, useRole, useTenantId } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { Plus, Users, Copy, Mail } from "lucide-react";

import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Input } from "@/components/ds/input";
import { Label } from "@/components/ds/label";
import { Badge } from "@/components/ds/badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;

interface StaffMember {
  id: string;
  venue_id: string;
  name: string;
  email: string;
  role: string;
}

// Operator's "Floor Team" — provision and view staff logins for the venue.
// Each staff member gets a set-password link the operator relays. "Paper & Ink"
// — migrated to ds/ primitives; explicit colours on every text element.
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
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Failed to add staff");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-end justify-between gap-6 py-10">
        <div>
          <span className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-wider text-[#5A6E00]">
            <span className="size-1.5 rounded-[2px] bg-primary" aria-hidden />
            Floor team
            <span className="text-muted-foreground">· {isBroker ? "Broker" : "Operator"}</span>
          </span>
          <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
            Your <span className="text-[#5A6E00]" style={SCRIPT}>floor team</span>
          </h1>
          <p className="mt-2 max-w-[60ch] text-[15px] text-muted-foreground">
            Give security, bar, and door staff a login so they can report incidents straight from the floor.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-3 text-center">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Staff</div>
          <div className="mt-0.5 text-2xl font-semibold text-foreground">{staff.length.toString().padStart(2, "0")}</div>
        </div>
      </section>

      {!venueId ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
          <Users size={48} className="text-muted-foreground" />
          <h3 className="text-lg font-semibold text-foreground">No venue in scope</h3>
          <p className="text-sm text-muted-foreground">Open this from a venue to manage its floor team.</p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            {/* add-staff form */}
            <Card className="gap-4 p-6">
              <div className="flex items-center gap-2">
                <span className="size-1.5 rounded-full bg-primary" aria-hidden />
                <span className="text-sm font-semibold text-foreground">Add a staff member</span>
              </div>
              <form id="addstaff-form" onSubmit={handleAdd} className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="staff-name" className="text-foreground">Name</Label>
                  <Input id="staff-name" type="text" placeholder="e.g., Dana Ruiz" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" required />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="staff-email" className="text-foreground">Work email</Label>
                  <Input id="staff-email" type="email" placeholder="name@venue.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
                </div>
              </form>
            </Card>

            {/* invite link OR summary */}
            <Card className="gap-3 p-6">
              <Button type="submit" form="addstaff-form" disabled={submitting} className="w-full border border-foreground/15">
                <Plus className="size-3.5" />
                {submitting ? "Adding…" : "Add to team"}
              </Button>
              {invite ? (
                <div>
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <Mail size={12} aria-hidden className="text-[#5A6E00]" /> Set-password link · {invite.name}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Send this to {invite.name} to set a password and sign in. Expires in 1 hour.
                  </p>
                  <code className="mt-2 block break-all text-xs text-muted-foreground">{invite.url}</code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2 text-foreground"
                    onClick={() => { navigator.clipboard?.writeText(invite.url); toastSuccess("Link copied"); }}
                  >
                    <Copy className="size-3.5" /> Copy link
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Adding a member generates a one-hour set-password link to relay to them.
                </p>
              )}
            </Card>
          </div>

          {/* staff list */}
          <div className="mt-6 flex flex-col gap-3">
            {staff.length > 0 ? (
              staff.map((s) => (
                <Card key={s.id} className="flex-row items-center gap-4 py-4">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Users size={20} aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1 px-0">
                    <div className="flex items-center justify-between gap-3">
                      <h4 className="font-semibold text-foreground">{s.name}</h4>
                      <Badge variant="muted">STAFF</Badge>
                    </div>
                    <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Mail size={12} />{s.email}
                    </div>
                  </div>
                </Card>
              ))
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
                <Users size={48} className="text-muted-foreground" />
                <h3 className="text-lg font-semibold text-foreground">No staff yet</h3>
                <p className="text-sm text-muted-foreground">Add your floor team above so they can report incidents.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
