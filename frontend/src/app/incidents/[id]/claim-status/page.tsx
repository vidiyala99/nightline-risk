"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, AlertTriangle, Clock } from "lucide-react";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ClaimStatusResponse {
  incident_status: string;
  proposal: { exists: boolean; state: string | null };
  claim: { exists: boolean; status: string | null };
}
interface IncidentClaim {
  id: string; incident_id: string | null; carrier_claim_number: string | null;
  coverage_line: string; status: string; current_reserve: string;
}

export default function ClaimStatusPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [summary, setSummary] = useState("");
  const [cs, setCs] = useState<ClaimStatusResponse | null>(null);
  const [claim, setClaim] = useState<IncidentClaim | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/login"); }, [isLoaded, isSignedIn, router]);
  useEffect(() => { if (isLoaded && isSignedIn && !isOperator) router.replace(`/incidents/${id}`); }, [isLoaded, isSignedIn, isOperator, id, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isOperator) return;
    let cancelled = false;
    (async () => {
      const incRes = await fetch(`${API_URL}/api/incidents/${id}`, { headers: authHeaders() });
      const inc = incRes.ok ? await incRes.json() : null;
      const csRes = await fetch(`${API_URL}/api/incidents/${id}/claim-status`, { headers: authHeaders() });
      const csData = csRes.ok ? await csRes.json() : null;
      let matched: IncidentClaim | null = null;
      if (inc?.venue_id) {
        const clRes = await fetch(`${API_URL}/api/venues/${inc.venue_id}/claims`, { headers: authHeaders() });
        if (clRes.ok) {
          const rows: IncidentClaim[] = await clRes.json();
          matched = rows.find((c) => c.incident_id === id) ?? null;
        }
      }
      if (cancelled) return;
      setSummary(inc?.summary ?? "");
      setCs(csData);
      setClaim(matched);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isLoaded, isSignedIn, isOperator]);

  if (!isLoaded || loading || !isOperator) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const ps = cs?.proposal.state ?? null;
  const steps = [
    { label: "Reported", lit: true },
    { label: "Sent to broker", lit: !!cs?.proposal.exists },
    { label: "Approved", lit: !!ps && ["approved", "filed_with_carrier", "paid", "denied"].includes(ps) },
    { label: "Filed", lit: (!!ps && ["filed_with_carrier", "paid", "denied"].includes(ps)) || !!cs?.claim.exists },
    { label: "Resolved", lit: (!!ps && ["paid", "denied"].includes(ps)) || (!!cs?.claim.status && ["closed_paid", "closed_denied", "closed_dropped"].includes(cs.claim.status)) },
  ];
  const reserve = claim ? Number(claim.current_reserve) : 0;

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <button onClick={() => router.push(`/incidents/${id}`)} className="flex items-center gap-xs text-secondary text-sm" style={{ background: "none", border: "none", cursor: "pointer", padding: "16px 0", minHeight: 44 }}>
        <ArrowLeft size={14} /> Back to incident
      </button>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">OPERATOR<span className="lc-eyebrow__sep" />CLAIM STATUS</span>
          <h1 className="lc-display">Claim <em>status</em></h1>
          <p className="lc-sub">{summary}</p>
        </div>
      </section>

      {!cs?.proposal.exists && !claim ? (
        <div className="lc-card"><div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="text-sm" style={{ margin: 0 }}>This incident hasn&apos;t been filed as a claim — it&apos;s a recommendation right now.</p>
          <Link href={`/incidents/${id}/decision`} className="text-sm" style={{ color: "var(--accent-ink)", textDecoration: "none" }}>View decision →</Link>
        </div></div>
      ) : (
        <>
          <div className="lc-card mb-md"><div className="lc-card__inner">
            <div role="list" aria-label="Claim status" className="flex gap-sm" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {steps.map((step) => (
                <div key={step.label} role="listitem" className="flex items-center gap-xs" style={{ padding: "4px 10px", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)" }}>
                  {step.lit
                    ? <CheckCircle2 size={13} style={{ color: "var(--accent-ink)", flexShrink: 0 }} aria-hidden="true" />
                    : <Circle size={13} className="text-muted" style={{ flexShrink: 0 }} aria-hidden="true" />}
                  <span className="text-xs" style={{ color: step.lit ? "var(--accent-ink)" : undefined }}>{step.label}</span>
                </div>
              ))}
            </div>
            {ps === "rejected_by_broker" && <p className="text-xs mt-sm flex items-center gap-xs" style={{ color: "var(--state-error)" }}><AlertTriangle size={12} aria-hidden="true" />Declined by broker</p>}
            {ps === "needs_more_info" && <p className="text-xs mt-sm flex items-center gap-xs" style={{ color: "var(--state-warning)" }}><Clock size={12} aria-hidden="true" />Info requested</p>}
          </div></div>

          {claim && (
            <div className="lc-card"><div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="text-xs uppercase tracking-wide text-secondary">Carrier claim</div>
              <div className="text-sm">
                {claim.carrier_claim_number ? `Claim ${claim.carrier_claim_number}` : "Claim opened"}
                {" · "}{claim.coverage_line.toUpperCase()}
                {" · "}<span style={{ textTransform: "capitalize" }}>{claim.status.replace(/_/g, " ")}</span>
                {reserve > 0 && <> · reserved <span className="font-mono">${reserve.toLocaleString()}</span></>}
              </div>
            </div></div>
          )}
        </>
      )}
    </div>
  );
}
