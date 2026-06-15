"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { Inbox, Check, X, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Badge } from "@/components/ds/badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const DISPLAY = { fontFamily: "var(--font-display)" } as const;
const SCRIPT = { fontFamily: "var(--font-caveat)" } as const;

interface ReviewItem {
  id: string; venue_id: string; source: string; raw_text: string;
  proposed_kind: string; confidence: number; rationale: string | null;
}

// "Paper & Ink" comms-review queue — low-confidence comms classifications to
// confirm / correct / dismiss. Migrated to the ds/ primitives; every text
// element carries an explicit colour (the migration rule).
export default function CommsReviewPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/"); }, [isLoaded, isSignedIn, router]);

  const load = () => {
    fetch(`${API_URL}/api/comms/review`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resolve = async (id: string, decision: string, kind?: string) => {
    try {
      const res = await fetch(`${API_URL}/api/comms/review/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ decision, kind }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      toastSuccess("Resolved");
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { toastError(e instanceof Error ? e.message : "Failed to resolve"); }
  };

  if (!isSignedIn || loading) return <div className="page-loading"><div className="loading-spinner" /></div>;

  return (
    <div className="relative min-h-screen overflow-x-clip px-[clamp(20px,4vw,56px)] pb-16">
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <section className="py-10">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Review queue
          <span className="h-1 w-1 rounded-full bg-primary" aria-hidden />
          Comms
        </span>
        <h1 className="mt-3 text-[2.4rem] font-bold leading-[1.05] tracking-tight text-foreground" style={DISPLAY}>
          Triage{" "}
          <span className="text-[#5A6E00]" style={SCRIPT}>signals</span>
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15px] text-muted-foreground">
          Low-confidence classifications from Slack, tickets, and texts — confirm, correct, or dismiss.
        </p>
      </section>

      {/* ── queue ──────────────────────────────────────────────────────── */}
      {items.length > 0 ? (
        <div className="flex flex-col gap-3">
          {[...items].sort((a, b) => a.confidence - b.confidence).map((it) => (
            <Card key={it.id} className="flex-row items-start gap-4 py-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Inbox size={20} aria-hidden />
              </div>
              <div className="min-w-0 flex-1 px-0">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="min-w-0 truncate font-semibold text-foreground">{it.raw_text.slice(0, 80)}</h4>
                  <Badge variant="warning" className="shrink-0">
                    {it.proposed_kind} · {Math.round(it.confidence * 100)}%
                  </Badge>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{it.raw_text}</p>
                <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>{it.source}</span>{it.rationale && <span>{it.rationale}</span>}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => resolve(it.id, "confirm")} className="border border-foreground/15">
                    <Check className="size-3.5" /> Confirm {it.proposed_kind}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => resolve(it.id, "correct", "incident")} className="text-foreground">
                    <AlertTriangle className="size-3.5" /> It&apos;s an incident
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => resolve(it.id, "correct", "compliance")} className="text-foreground">
                    Compliance
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => resolve(it.id, "dismiss")} className="text-muted-foreground">
                    <X className="size-3.5" /> Dismiss
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
          <Inbox size={48} className="text-muted-foreground" />
          <h3 className="text-lg font-semibold text-foreground">Queue clear</h3>
          <p className="text-sm text-muted-foreground">No comms signals waiting for review.</p>
        </div>
      )}
    </div>
  );
}
