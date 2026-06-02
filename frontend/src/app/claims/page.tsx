"use client";

/**
 * /claims — carrier-side claims list across the broker's whole book.
 *
 * One cross-policy `GET /api/claims` call (`claimsApi.listClaims`) returns
 * every claim in the broker's book. Policy metadata (venue, policy_number)
 * is then fetched in parallel only for the policies actually referenced by
 * returned claims — typically far fewer than the broker's total policies.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FileSpreadsheet } from "lucide-react";

import { ClaimStatusPill } from "@/components/claims/ClaimStatusPill";
import { PageHeader } from "@/components/ui/PageHeader";
import { useAuth, useTenantId } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { claimsApi, totalPaidFromClaim, type Claim } from "@/lib/claims";
import { formatLedgerMoney, isClosedStatus } from "@/lib/claim-tokens";
import { policiesApi, type Policy } from "@/lib/policies";

interface Row extends Claim {
  policy: Policy;
}

type Filter = "open" | "all" | "closed";

export default function CarrierClaimsListPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";

  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");

  useEffect(() => {
    if (!isLoaded || !isBroker) return;
    let cancelled = false;
    async function load() {
      setError(null);
      try {
        // One cross-policy call replaces the per-policy aggregation that
        // shipped in slice 2. Policy metadata (venue, policy_number) is
        // fetched in parallel only for the policies actually referenced
        // by returned claims — typically far fewer than total policies.
        // PolicyDetail upcasts to Policy here since Row only needs the
        // base shape; the table never reads endorsements/certificates.
        const claims = await claimsApi.listClaims();
        const policyIds = Array.from(new Set(claims.map((c) => c.policy_id)));
        const policies = await Promise.all(
          policyIds.map((pid) =>
            policiesApi.getPolicy(pid).catch(() => null),
          ),
        );
        const policyById = new Map<string, Policy>();
        for (const p of policies) {
          if (p) policyById.set(p.id, p as Policy);
        }
        const all: Row[] = [];
        for (const c of claims) {
          const policy = policyById.get(c.policy_id);
          if (policy) all.push({ ...c, policy });
        }
        if (!cancelled) setRows(all);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load claims");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isBroker]);

  const visible = useMemo(() => {
    if (!rows) return [];
    if (filter === "all") return rows;
    if (filter === "closed") return rows.filter((r) => isClosedStatus(r.status));
    return rows.filter((r) => !isClosedStatus(r.status));
  }, [rows, filter]);

  if (!isLoaded) {
    return null;
  }

  if (!isBroker) {
    return <OperatorClaimsTracker />;
  }

  return (
    <div className="claims-portfolio">
      <PageHeader
        eyebrow="BROKER · PORTFOLIO"
        title="Carrier claims"
        accent="every loss in view"
        subtitle="Every reported loss across your book of bound policies."
      />

      <div className="claims-portfolio__filters" role="group" aria-label="Filter by status">
        {(["open", "closed", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            className={
              filter === f
                ? "claims-portfolio__filter claims-portfolio__filter--active"
                : "claims-portfolio__filter"
            }
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
          >
            {f === "open" ? "Open" : f === "closed" ? "Closed" : "All"}
            {rows && (
              <span className="claims-portfolio__filter-count">
                {f === "all"
                  ? rows.length
                  : f === "closed"
                    ? rows.filter((r) => isClosedStatus(r.status)).length
                    : rows.filter((r) => !isClosedStatus(r.status)).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {error ? (
        <div className="policies-empty" role="alert">
          {error}
        </div>
      ) : rows === null ? (
        <div className="claims-section__skeleton" aria-busy="true">
          <div /><div /><div /><div />
        </div>
      ) : visible.length === 0 ? (
        <div className="policies-empty">
          {rows.length === 0
            ? "No carrier claims in your book yet. File one from a policy detail page."
            : "No claims match the current filter."}
        </div>
      ) : (
        <div className="policies-table-wrap">
          <table className="policies-table" aria-label="Carrier claims portfolio">
            <thead>
              <tr>
                <th scope="col">Claim</th>
                <th scope="col">Venue</th>
                <th scope="col">Policy</th>
                <th scope="col">Coverage</th>
                <th scope="col">Status</th>
                <th scope="col" style={{ textAlign: "right" }}>Reserve</th>
                <th scope="col" style={{ textAlign: "right" }}>Paid</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/claims/${r.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(`/claims/${r.id}`);
                    }
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <td className="policies-table__mono">
                    {r.carrier_claim_number ?? r.id}
                  </td>
                  <td>{r.policy.venue_id}</td>
                  <td className="policies-table__mono">{r.policy.policy_number ?? r.policy.id}</td>
                  <td>{r.coverage_line.toUpperCase()}</td>
                  <td><ClaimStatusPill status={r.status} reopenCount={r.reopen_count} /></td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatLedgerMoney(r.current_reserve)}
                  </td>
                  <td
                    className="policies-table__mono"
                    style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}
                  >
                    {formatLedgerMoney(totalPaidFromClaim(r))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Operator claims tracker ───────────────────────────────────────────────
// Aggregate "where do all my claims stand" view for an operator's own venue.
// Mirrors the per-incident claim-status status model (Reported → Sent →
// Approved → Filed → Resolved) so the operator sees ONE consistent claim
// journey across Home feed → this tracker → per-incident claim-status.
// Reuses the existing incident-status-feed endpoint — no new backend.

const CLAIMS_API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";
const TERMINAL_CLAIM_STATUS = new Set(["closed_paid", "closed_denied", "closed_dropped"]);
const TERMINAL_PROPOSAL_STATE = new Set(["paid", "denied", "rejected_by_broker"]);

interface ClaimFeedRow {
  incident_id: string;
  summary: string;
  occurred_at: string;
  status: string;
  proposal_state: string | null;
  claim_status: string | null;
  coverage_decision: "covered" | "denied" | "reservation_of_rights" | null;
  coverage_rationale: string | null;
}
type ClaimsFilter = "active" | "all" | "resolved";

function claimIsResolved(r: ClaimFeedRow): boolean {
  return (!!r.claim_status && TERMINAL_CLAIM_STATUS.has(r.claim_status))
    || (!!r.proposal_state && TERMINAL_PROPOSAL_STATE.has(r.proposal_state));
}
function claimIsFiled(r: ClaimFeedRow): boolean {
  return !claimIsResolved(r) && (!!r.claim_status || r.proposal_state === "filed_with_carrier");
}
function claimStatusLabel(r: ClaimFeedRow): { text: string; color: string } {
  const ps = r.proposal_state, cs = r.claim_status;
  if (ps === "paid" || cs === "closed_paid") return { text: "Claim paid", color: "var(--accent-ink)" };
  if (ps === "denied" || cs === "closed_denied") return { text: "Claim denied by carrier", color: "var(--state-error)" };
  if (cs === "closed_dropped") return { text: "Claim withdrawn", color: "var(--text-secondary)" };
  if (ps === "rejected_by_broker") return { text: "Declined by broker", color: "var(--state-error)" };
  if (ps === "filed_with_carrier" || cs) return { text: "Filed with the carrier", color: "var(--accent-ink)" };
  if (ps === "approved") return { text: "Approved — filing with carrier", color: "var(--accent-ink)" };
  if (ps === "needs_more_info") return { text: "Broker needs more info", color: "var(--state-warning)" };
  return { text: "Awaiting your broker's decision", color: "var(--accent-ink)" };
}
function claimSteps(r: ClaimFeedRow): { label: string; lit: boolean }[] {
  const ps = r.proposal_state ?? "";
  const cs = r.claim_status ?? "";
  return [
    { label: "Reported", lit: true },
    { label: "Sent", lit: !!r.proposal_state },
    { label: "Approved", lit: ["approved", "filed_with_carrier", "paid", "denied"].includes(ps) },
    { label: "Filed", lit: ["filed_with_carrier", "paid", "denied"].includes(ps) || !!r.claim_status },
    { label: "Resolved", lit: ["paid", "denied"].includes(ps) || TERMINAL_CLAIM_STATUS.has(cs) },
  ];
}

function CoverageBadge({ decision, rationale }: { decision: ClaimFeedRow["coverage_decision"]; rationale: string | null }) {
  if (!decision) return null;
  const map: Record<NonNullable<typeof decision>, { label: string; color: string; bg: string }> = {
    covered:                { label: "Covered",                color: "var(--state-success, #16a34a)", bg: "rgba(22,163,74,0.10)" },
    reservation_of_rights:  { label: "Reservation of rights",  color: "var(--state-warning, #ca8a04)", bg: "rgba(202,138,4,0.10)" },
    denied:                 { label: "Denied",                 color: "var(--state-error, #dc2626)",  bg: "rgba(220,38,38,0.10)" },
  };
  const { label, color, bg } = map[decision];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span className="text-xs" style={{
        display: "inline-block", padding: "2px 8px", borderRadius: 10, fontWeight: 700,
        color, background: bg, border: `1px solid ${color}`, letterSpacing: "0.01em",
      }}>
        Coverage: {label}
      </span>
      {rationale && (
        <span className="text-xs" style={{ color: "var(--text-secondary)", fontStyle: "italic" }}>
          — {rationale}
        </span>
      )}
    </span>
  );
}

function OperatorClaimsTracker() {
  const tenantId = useTenantId();
  const [rows, setRows] = useState<ClaimFeedRow[] | null>(null);
  const [filter, setFilter] = useState<ClaimsFilter>("active");

  useEffect(() => {
    if (!tenantId) { setRows([]); return; }
    let cancelled = false;
    (async () => {
      const res = await fetch(`${CLAIMS_API_URL}/api/venues/${tenantId}/incident-status-feed`, { headers: authHeaders() });
      const data = res.ok ? await res.json() : [];
      if (!cancelled) setRows(Array.isArray(data) ? data : []);
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  // Only incidents that have entered the claim journey (a proposal or a claim).
  const claims = (rows ?? []).filter((r) => r.proposal_state != null || r.claim_status != null);
  const resolvedCount = claims.filter(claimIsResolved).length;
  const filedCount = claims.filter(claimIsFiled).length;
  const inFlightCount = claims.length - resolvedCount - filedCount;

  const visible = claims.filter((r) => {
    if (filter === "all") return true;
    if (filter === "resolved") return claimIsResolved(r);
    return !claimIsResolved(r);
  });

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">CLAIMS<span className="lc-eyebrow__sep" />OPERATOR · VENUE</span>
          <h1 className="lc-display">Your <em>claims</em></h1>
          <p className="lc-sub">Every incident you&apos;ve sent to your broker — and exactly where each one stands.</p>
        </div>
        <div className="lc-hero__meta">
          <div className="lc-meta-cell"><span className="lc-stat-label">In flight</span><strong style={{ color: inFlightCount > 0 ? "var(--accent-ink)" : undefined }}>{inFlightCount.toString().padStart(2, "0")}</strong></div>
          <div className="lc-meta-cell"><span className="lc-stat-label">Filed</span><strong>{filedCount.toString().padStart(2, "0")}</strong></div>
          <div className="lc-meta-cell"><span className="lc-stat-label">Resolved</span><strong>{resolvedCount.toString().padStart(2, "0")}</strong></div>
        </div>
      </section>

      <div className="lc-rule" role="group" aria-label="Filter claims">
        {(["active", "all", "resolved"] as ClaimsFilter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
            style={{
              padding: "6px 14px", borderRadius: 14, minHeight: 36, cursor: "pointer", fontSize: "0.8rem", fontWeight: 600,
              border: filter === f ? "1px solid var(--brand-primary)" : "1px solid var(--border-subtle)",
              background: filter === f ? "rgba(200,240,0,0.08)" : "var(--bg-surface)",
              color: filter === f ? "var(--accent-ink)" : "var(--text-secondary)",
            }}>
            {f === "active" ? "Active" : f === "all" ? "All" : "Resolved"}
            <span className="font-mono" style={{ marginLeft: 6, opacity: 0.7 }}>
              {f === "all" ? claims.length : f === "resolved" ? resolvedCount : inFlightCount + filedCount}
            </span>
          </button>
        ))}
        <div className="lc-rule__line" />
      </div>

      {rows === null ? (
        <div className="page-loading"><div className="loading-spinner" /></div>
      ) : claims.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><FileSpreadsheet size={48} /></div>
          <h2>No claims yet</h2>
          <p>When you send an incident to your broker, track its journey here. Start from <Link href="/incidents">Incidents</Link>.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon"><FileSpreadsheet size={48} /></div>
          <h2>Nothing here</h2>
          <p>No claims match the current filter.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          {visible.map((r) => {
            const steps = claimSteps(r);
            const currentIdx = steps.map((s) => s.lit).lastIndexOf(true);
            const label = claimStatusLabel(r);
            const dateLabel = (() => {
              const d = new Date(r.occurred_at);
              return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
            })();
            return (
              <Link key={r.incident_id} href={`/incidents/${r.incident_id}/claim-status`} className="lc-card"
                style={{ textDecoration: "none", display: "block" }}
                aria-label={`${r.summary} — ${label.text}`}>
                <div className="lc-card__inner" style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                    <span className="text-sm" title={r.summary} style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.summary}</span>
                    <span className="text-xs" style={{ color: label.color, fontWeight: 600 }}>{label.text}</span>
                    {r.coverage_decision && (
                      <CoverageBadge decision={r.coverage_decision} rationale={r.coverage_rationale} />
                    )}
                    <div className="flex items-center" aria-hidden="true" style={{ gap: 8, flexWrap: "wrap" }}>
                      {steps.map((s, i) => (
                        <span key={s.label} className="text-xs" style={{ color: s.lit ? "var(--accent-ink)" : "var(--text-muted)", fontWeight: i === currentIdx ? 700 : 400 }}>
                          {s.lit ? "● " : "○ "}{s.label}{i === currentIdx ? " · now" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
                    {dateLabel && <span className="text-xs text-muted font-mono">{dateLabel}</span>}
                    <ArrowRight size={15} className="text-muted" aria-hidden="true" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
