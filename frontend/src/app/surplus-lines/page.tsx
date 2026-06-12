"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { ShieldCheck, FileText, Send, Check, X, Download } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Filing {
  id: string;
  policy_id: string;
  venue_id: string;
  state: string;
  status: string;
  taxable_premium: string;
  surplus_lines_tax: string;
  stamping_fee: string;
  total_charges: string;
  filing_deadline: string;
  diligent_search_complete: boolean;
  export_list_exempt: boolean;
  transaction_id: string | null;
  documents: string[];
}

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-warning",
  filed: "badge-info",
  confirmed: "badge-success",
  void: "badge-error",
};

function money(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isOverdue(f: Filing): boolean {
  if (f.status === "confirmed" || f.status === "void") return false;
  const deadline = new Date(f.filing_deadline);
  if (Number.isNaN(deadline.getTime())) return false;
  return deadline.getTime() < Date.now();
}

export default function SurplusLinesPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const [filings, setFilings] = useState<Filing[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  const load = () => {
    fetch(`${API_URL}/api/surplus-lines/filings`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setFilings(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const act = async (id: string, action: "file" | "confirm" | "void") => {
    setBusy(id);
    try {
      const body =
        action === "confirm"
          ? JSON.stringify({ transaction_id: `ELANY-${Date.now()}` })
          : action === "void"
            ? JSON.stringify({ reason: "Voided by broker" })
            : undefined;
      const res = await fetch(`${API_URL}/api/surplus-lines/filings/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body,
      });
      if (!res.ok) {
        let message = `Server error ${res.status}`;
        try {
          const detail = (await res.json())?.detail;
          if (detail?.message) message = detail.message;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }
      toastSuccess(
        action === "file" ? "Filed" : action === "confirm" ? "Confirmed" : "Voided"
      );
      load();
    } catch (e: any) {
      toastError(e?.message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  // The document endpoint is broker-gated and needs the auth header, so a bare
  // <a href> would 401 — fetch the blob and open it client-side (same pattern as
  // downloadLossRunCsv / downloadDefensePackagePdf).
  const downloadDoc = async (id: string, kind: string) => {
    try {
      const res = await fetch(
        `${API_URL}/api/surplus-lines/filings/${id}/documents/${kind}`,
        { headers: authHeaders() }
      );
      if (!res.ok) throw new Error(`Couldn't download ${kind} (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoke after a tick so the new tab has time to read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: any) {
      toastError(e?.message || "Download failed");
    }
  };

  if (!isSignedIn || loading)
    return (
      <div className="page-loading">
        <div className="loading-spinner" />
      </div>
    );

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">COMPLIANCE<span className="lc-eyebrow__sep" />SURPLUS LINES</span>
          <h1 className="lc-display">Surplus-lines <em>filings</em></h1>
          <p className="lc-sub">
            Track ELANY filings — premium tax, stamping fees, diligent-search status, and deadlines.
          </p>
        </div>
      </section>

      <div className="incidents-list stagger-children">
        {filings.length > 0 ? (
          // Overdue-first, then soonest deadline — a missed ELANY filing is the
          // urgent item, so it must not sit in arbitrary server order.
          [...filings]
            .sort((a, b) =>
              (isOverdue(b) ? 1 : 0) - (isOverdue(a) ? 1 : 0) ||
              new Date(a.filing_deadline).getTime() - new Date(b.filing_deadline).getTime())
            .map((f) => {
            const overdue = isOverdue(f);
            const canFile = f.status === "pending";
            const canConfirm = f.status === "filed";
            const canVoid = f.status !== "void" && f.status !== "confirmed";
            const acting = busy === f.id;
            return (
              <div key={f.id} className="incident-card" style={{ cursor: "default" }}>
                <div className="incident-icon">
                  <ShieldCheck size={20} aria-hidden />
                </div>
                <div className="incident-info">
                  <div className="incident-header-row">
                    <h4>Policy {f.policy_id}</h4>
                    <span className={`badge ${STATUS_BADGE[f.status] || "badge-neutral"}`}>
                      {f.status}
                    </span>
                  </div>
                  <p className="incident-desc">
                    {f.state} · Taxable premium {money(f.taxable_premium)} · SL tax (3.6%){" "}
                    {money(f.surplus_lines_tax)} · ELANY stamping (0.15%) {money(f.stamping_fee)} ·{" "}
                    Total charges {money(f.total_charges)}
                  </p>
                  <div className="incident-meta">
                    {overdue ? (
                      <span className="badge badge-error">
                        Overdue · due {f.filing_deadline}
                      </span>
                    ) : (
                      <span>Filing deadline {f.filing_deadline}</span>
                    )}
                    <span>
                      {f.diligent_search_complete
                        ? "Diligent search ✓"
                        : "Diligent search incomplete"}
                    </span>
                    {f.export_list_exempt && <span>Export-list exempt</span>}
                    {f.transaction_id && <span>Txn {f.transaction_id}</span>}
                  </div>

                  {f.documents.length > 0 && (
                    <div className="flex gap-xs" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
                      {f.documents.map((kind) => (
                        <button
                          key={kind}
                          className="btn btn-sm btn-ghost"
                          onClick={() => downloadDoc(f.id, kind)}
                        >
                          <Download size={14} /> {kind}
                        </button>
                      ))}
                    </div>
                  )}

                  {(canFile || canConfirm || canVoid) && (
                    <div className="flex gap-xs" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
                      {canFile && (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={acting}
                          onClick={() => act(f.id, "file")}
                        >
                          <Send size={14} /> File
                        </button>
                      )}
                      {canConfirm && (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={acting}
                          onClick={() => act(f.id, "confirm")}
                        >
                          <Check size={14} /> Confirm
                        </button>
                      )}
                      {canVoid && (
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={acting}
                          onClick={() => act(f.id, "void")}
                        >
                          <X size={14} /> Void
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="page-empty">
            <FileText size={48} />
            <h3>No filings</h3>
            <p>No surplus-lines filings yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}
