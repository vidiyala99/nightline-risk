"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { toastSuccess, toastError } from "@/lib/toast";
import { authHeaders } from "@/lib/authFetch";
import { ArrowLeft, Upload, Clock, AlertCircle, CheckSquare, FileText } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ComplianceItem {
  id: string;
  title?: string;
  description: string;
  severity: string;
}

interface CitationChip {
  source_id: string;
  source_type: string;
  excerpt: string;
  doc_id: string | null;
  node_id: string | null;
  page_start: number | null;
  page_end: number | null;
  path: string | null;
  clause_id: string | null;
}

function formatPageAnchor(start: number | null, end: number | null): string {
  if (start === null) return "";
  if (end === null || end === start) return ` · p.${start}`;
  return ` · p.${start}–${end}`;
}

function humanize(id: string) {
  return id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ComplianceDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isBroker = role === "broker" || role === "admin";

  const venueId = String(params?.venueId ?? "");
  const itemId = String(params?.itemId ?? "");

  const [item, setItem] = useState<ComplianceItem | null>(null);
  const [venueName, setVenueName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [citation, setCitation] = useState<CitationChip | null>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    if (!venueId || !itemId) return;
    let cancelled = false;
    async function fetchItem() {
      try {
        const res = await fetch(`${API_URL}/api/venues/${venueId}/live`, { headers: authHeaders() });
        if (!res.ok) {
          if (!cancelled) setItem(null);
          return;
        }
        const state = await res.json();
        const queue: ComplianceItem[] = state.compliance_queue ?? [];
        const found = queue.find((q) => q.id === itemId) ?? null;
        if (!cancelled) setItem(found);
      } catch (error) {
        console.error("Failed to fetch compliance item:", error);
        if (!cancelled) setItem(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (isLoaded && isSignedIn) fetchItem();
    return () => { cancelled = true; };
  }, [venueId, itemId, isLoaded, isSignedIn]);

  useEffect(() => {
    if (!venueId) return;
    let cancelled = false;
    fetch(`${API_URL}/api/venues/${venueId}`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled) setVenueName(data?.name ?? venueId); })
      .catch(() => { if (!cancelled) setVenueName(venueId); });
    return () => { cancelled = true; };
  }, [venueId]);

  useEffect(() => {
    if (!venueId || !itemId) return;
    let cancelled = false;
    fetch(`${API_URL}/api/venues/${venueId}/compliance/${itemId}/citation`)
      .then((r) => (r.ok ? r.json() : { citation: null }))
      .then((data) => { if (!cancelled) setCitation(data.citation ?? null); })
      .catch(() => { if (!cancelled) setCitation(null); });
    return () => { cancelled = true; };
  }, [venueId, itemId]);

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_URL}/api/venues/${venueId}/compliance/${itemId}/upload`, {
        method: "POST",
        headers: authHeaders(),
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");
      toastSuccess("Evidence uploaded successfully");
      router.push(`/compliance?venue=${encodeURIComponent(venueId)}`);
    } catch {
      toastError("Failed to upload evidence");
      setUploading(false);
    }
  };

  const handleWaive = async () => {
    const reason = window.prompt(
      "Resolve / waive this compliance item without operator evidence?\nOptionally note why (recorded in the audit trail):",
      "",
    );
    if (reason === null) return; // cancelled
    setResolving(true);
    try {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/compliance/${itemId}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ reason: reason || null }),
      });
      if (!res.ok) throw new Error("Resolve failed");
      toastSuccess("Compliance item resolved");
      router.push(`/compliance?venue=${encodeURIComponent(venueId)}`);
    } catch {
      toastError("Failed to resolve item");
      setResolving(false);
    }
  };

  if (!isSignedIn || loading) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const backHref = `/compliance?venue=${encodeURIComponent(venueId)}`;

  return (
    <div className="theme-venue page">
      <div className="mb-md">
        <Link
          href={backHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            color: "var(--text-secondary)",
            fontSize: "0.85rem",
            textDecoration: "none",
          }}
        >
          <ArrowLeft size={14} />
          Back to {venueName ?? "queue"}
        </Link>
      </div>

      {item ? (
        <>
          <header className="page-header">
            <div>
              <h1>{item.title || humanize(item.id)}</h1>
              <p className="page-subtitle">
                {venueName ? `Compliance action for ${venueName}` : "Compliance action"}
              </p>
            </div>
          </header>

          <div className="compliance-card" style={{ maxWidth: 720 }}>
            <div className="compliance-header">
              <AlertCircle size={18} />
              <span>{item.title || humanize(item.id)}</span>
            </div>
            <p className="compliance-desc">{item.description}</p>
            <div className="compliance-meta">
              <span className="severity-tag">
                <Clock size={12} />
                {item.severity}
              </span>
            </div>
            {citation && (
              <div
                role="note"
                aria-label="Policy clause this evidence resolves"
                style={{
                  marginTop: "var(--space-md)",
                  padding: "var(--space-sm)",
                  background: "var(--bg-elevated)",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <div className="flex items-center gap-sm mb-xs">
                  <FileText size={12} />
                  <span
                    className="text-xs font-mono"
                    style={{
                      color:
                        citation.source_type === "policy_exclusion"
                          ? "var(--state-warning)"
                          : "var(--brand-primary)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {citation.path ?? citation.source_type.replace("_", " ")}
                    {formatPageAnchor(citation.page_start, citation.page_end)}
                  </span>
                </div>
                <p
                  className="text-xs text-secondary"
                  style={{ lineHeight: 1.5, margin: 0 }}
                >
                  {citation.excerpt.length > 180
                    ? citation.excerpt.slice(0, 180) + "…"
                    : citation.excerpt}
                </p>
              </div>
            )}
            {!isBroker ? (
              <div className="compliance-actions">
                <input
                  type="file"
                  accept="video/*,image/*,application/pdf"
                  className="visually-hidden"
                  id={`upload-${itemId}`}
                  onChange={handleUpload}
                />
                <label
                  htmlFor={`upload-${itemId}`}
                  className={`btn btn-secondary${uploading ? " disabled" : ""}`}
                  style={{ cursor: uploading ? "not-allowed" : "pointer" }}
                >
                  {uploading ? (
                    <><div className="loading-spinner loading-spinner-sm" />Uploading...</>
                  ) : (
                    <><Upload size={18} />Upload Evidence</>
                  )}
                </label>
              </div>
            ) : (
              <div className="compliance-actions">
                <button
                  type="button"
                  className={`btn btn-secondary${resolving ? " disabled" : ""}`}
                  onClick={handleWaive}
                  disabled={resolving}
                >
                  {resolving ? (
                    <><div className="loading-spinner loading-spinner-sm" />Resolving...</>
                  ) : (
                    <><CheckSquare size={18} />Resolve / Waive</>
                  )}
                </button>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">
          <div className="empty-icon"><CheckSquare size={48} /></div>
          <h2>Item not found</h2>
          <p>This compliance item has been resolved or no longer exists.</p>
          <Link href={backHref} className="btn btn-secondary" style={{ marginTop: "var(--space-md)" }}>
            <ArrowLeft size={16} />
            Back to queue
          </Link>
        </div>
      )}
    </div>
  );
}
