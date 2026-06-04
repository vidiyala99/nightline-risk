"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { Inbox, Check, X, AlertTriangle } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ReviewItem {
  id: string; venue_id: string; source: string; raw_text: string;
  proposed_kind: string; confidence: number; rationale: string | null;
}

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
    } catch (e: any) { toastError(e?.message || "Failed to resolve"); }
  };

  if (!isSignedIn || loading) return <div className="page-loading"><div className="loading-spinner" /></div>;

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">REVIEW QUEUE<span className="lc-eyebrow__sep" />COMMS</span>
          <h1 className="lc-display">Triage <em>signals</em></h1>
          <p className="lc-sub">Low-confidence classifications from Slack, tickets, and texts — confirm, correct, or dismiss.</p>
        </div>
      </section>

      <div className="incidents-list stagger-children">
        {items.length > 0 ? items.map((it) => (
          <div key={it.id} className="incident-card" style={{ cursor: "default" }}>
            <div className="incident-icon"><Inbox size={20} aria-hidden /></div>
            <div className="incident-info">
              <div className="incident-header-row">
                <h4>{it.raw_text.slice(0, 80)}</h4>
                <span className="badge badge-warning">
                  {it.proposed_kind} · {Math.round(it.confidence * 100)}%
                </span>
              </div>
              <p className="incident-desc">{it.raw_text}</p>
              <div className="incident-meta">
                <span>{it.source}</span>{it.rationale && <span>{it.rationale}</span>}
              </div>
              <div className="flex gap-xs" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
                <button className="btn btn-sm btn-primary" onClick={() => resolve(it.id, "confirm")}>
                  <Check size={14} /> Confirm {it.proposed_kind}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => resolve(it.id, "correct", "incident")}>
                  <AlertTriangle size={14} /> It&apos;s an incident
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => resolve(it.id, "correct", "compliance")}>
                  Compliance
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => resolve(it.id, "dismiss")}>
                  <X size={14} /> Dismiss
                </button>
              </div>
            </div>
          </div>
        )) : (
          <div className="page-empty"><Inbox size={48} /><h3>Queue clear</h3><p>No comms signals waiting for review.</p></div>
        )}
      </div>
    </div>
  );
}
