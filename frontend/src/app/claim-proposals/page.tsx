"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AlertTriangle, ArrowLeft, FileSpreadsheet } from "lucide-react";
import type { ClaimProposal } from "@/app/underwriter/[id]/page";
import { ResponsiveTable } from "@/components/ui/ResponsiveTable";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const STATE_LABEL: Record<ClaimProposal["state"], string> = {
  pending_broker_review: "Pending",
  approved: "Approved",
  rejected_by_broker: "Rejected",
  needs_more_info: "Info requested",
  filed_with_carrier: "Filed",
  paid: "Paid",
  denied: "Denied",
};

const STATE_COLOR: Record<ClaimProposal["state"], string> = {
  pending_broker_review: "var(--state-warning)",
  approved: "var(--brand-primary)",
  rejected_by_broker: "var(--state-error)",
  needs_more_info: "var(--state-warning)",
  filed_with_carrier: "var(--brand-primary)",
  paid: "var(--brand-primary)",
  denied: "var(--state-error)",
};

type StateFilter = "all" | ClaimProposal["state"];
type SortKey = "proposed_at" | "venue_id" | "state";

export default function ClaimsPortfolioPage() {
  const router = useRouter();
  const { user, isLoaded } = useAuth();
  const isBroker = user?.role === "broker" || user?.role === "admin";
  const isOperator = user?.role === "venue_operator";

  // Operators see only their own venues (primary tenant + any extras).
  // Brokers see the full cross-venue list.
  const operatorScope = useMemo(() => {
    if (!isOperator || !user) return null;
    const scope = new Set<string>();
    if (user.tenant_id) scope.add(user.tenant_id);
    (user.extra_venue_ids || []).forEach((v) => scope.add(v));
    return scope;
  }, [isOperator, user]);

  const [proposals, setProposals] = useState<ClaimProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StateFilter>("all");
  const [sort, setSort] = useState<SortKey>("proposed_at");
  const [overrideOnly, setOverrideOnly] = useState(false);
  // Broker-only cross-venue override calibration. Null until first fetch.
  const [overrideStats, setOverrideStats] = useState<{
    override_total: number;
    override_approved: number;
    override_rejected: number;
    override_right_rate: number | null;
    non_override_right_rate: number | null;
  } | null>(null);

  // Broker-only: prioritized pending queue for the inbox section.
  const [pendingQueue, setPendingQueue] = useState<any[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const proposalsRes = await fetch(`${API_URL}/api/claim-proposals`, { headers: authHeaders() });
        if (proposalsRes.ok) {
          const all: ClaimProposal[] = await proposalsRes.json();
          // Server returns everything; client filters to the operator's
          // scope when applicable. Brokers see all.
          const scoped = operatorScope
            ? all.filter((p) => operatorScope.has(p.venue_id))
            : all;
          setProposals(scoped);
        }
        // Cross-venue stats are a broker-only surface. Skip the fetch for
        // operators — their per-venue calibration lives on /risk-profile.
        if (isBroker) {
          const statsRes = await fetch(`${API_URL}/api/override-stats`);
          if (statsRes.ok) setOverrideStats(await statsRes.json());

          // Prioritized pending inbox — highest-priority proposals first.
          const queueRes = await fetch(
            `${API_URL}/api/claim-proposals?status=pending_broker_review&sort=priority`,
            { headers: authHeaders() },
          );
          if (queueRes.ok) setPendingQueue(await queueRes.json());
        }
      } finally {
        setLoading(false);
      }
    }
    if (isLoaded && user) load();
  }, [isLoaded, user, operatorScope, isBroker]);

  const visible = useMemo(() => {
    let result = proposals;
    if (filter !== "all") result = result.filter((p) => p.state === filter);
    if (overrideOnly) result = result.filter((p) => p.override_recommendation);
    if (sort === "proposed_at") {
      result = [...result].sort(
        (a, b) => new Date(b.proposed_at).getTime() - new Date(a.proposed_at).getTime()
      );
    } else if (sort === "venue_id") {
      result = [...result].sort((a, b) => a.venue_id.localeCompare(b.venue_id));
    } else if (sort === "state") {
      result = [...result].sort((a, b) => a.state.localeCompare(b.state));
    }
    return result;
  }, [proposals, filter, sort, overrideOnly]);

  if (!isLoaded) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const pendingCount = proposals.filter((p) => p.state === "pending_broker_review").length;
  const overrideCount = proposals.filter((p) => p.override_recommendation).length;
  const pageSubtitle = isBroker
    ? "Cross-venue claim proposals awaiting your decision, filed status, and override calibration."
    : "Your filed and pending claim proposals — track broker decisions and override outcomes.";
  const roleLabel = isBroker ? "BROKER · PORTFOLIO" : "OPERATOR · MY CLAIMS";

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <button
            className="lc-link"
            onClick={() => router.push("/dashboard")}
            style={{ background: "none", border: "none", padding: 0, marginBottom: 12, cursor: "pointer", color: "var(--text-tertiary)" }}
          >
            <ArrowLeft size={12} style={{ display: "inline", marginRight: 4 }} />
            Dashboard
          </button>
          <span className="lc-eyebrow">
            CLAIMS
            <span className="lc-eyebrow__sep" />
            {roleLabel}
          </span>
          <h1 className="lc-display">
            {isBroker ? <>Claims <em>portfolio</em></> : <>My <em>claims</em></>}
          </h1>
          <p className="lc-sub">{pageSubtitle}</p>
        </div>

        <div className="lc-hero__meta">
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Proposals</span>
            <strong>{proposals.length.toString().padStart(2, "0")}</strong>
          </div>
          <div className="lc-meta-cell">
            <span className="lc-stat-label">Pending</span>
            <strong style={{ color: pendingCount > 0 ? "var(--state-warning)" : undefined }}>
              {pendingCount.toString().padStart(2, "0")}
            </strong>
          </div>
          {isBroker && (
            <div className="lc-meta-cell">
              <span className="lc-stat-label">Overrides</span>
              <strong style={{ color: overrideCount > 0 ? "var(--state-warning)" : undefined }}>
                {overrideCount.toString().padStart(2, "0")}
              </strong>
            </div>
          )}
        </div>
      </section>

      {/* Broker-only: prioritized inbox of pending proposals.
          Highest-priority first, each row shows venue, file/review signal,
          confidence %, and approx median payout. Clicking navigates to the
          broker packet-review screen. */}
      {isBroker && (
        <div className="lc-card mb-lg">
          <div className="lc-card__inner">
            <div className="flex items-center justify-between mb-md" style={{ flexWrap: "wrap", gap: "var(--space-sm)" }}>
              <h2 className="card-title" style={{ margin: 0 }}>Awaiting review</h2>
              <span
                className="text-xs font-mono"
                style={{
                  color: pendingQueue.length > 0 ? "var(--state-warning)" : "var(--text-secondary)",
                  border: `1px solid ${pendingQueue.length > 0 ? "var(--state-warning)" : "var(--border-subtle)"}`,
                  borderRadius: "var(--radius-sm)",
                  padding: "2px 8px",
                }}
              >
                {pendingQueue.length} pending
              </span>
            </div>
            {pendingQueue.length === 0 ? (
              <p className="text-muted" style={{ margin: 0, fontSize: "var(--text-sm)" }}>
                No proposals awaiting review.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
                {pendingQueue.map((p: any) => {
                  const s = p.recommendation_snapshot || {};
                  const median = s.expected_payout?.median_usd ?? 0;
                  const conf = Math.round((s.confidence ?? 0) * 100);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => router.push(`/underwriter/${p.packet_id}`)}
                      aria-label={`Review proposal for ${p.venue_id}, confidence ${conf} percent`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-md)",
                        width: "100%",
                        textAlign: "left",
                        minHeight: 44,
                        cursor: "pointer",
                        background: "var(--bg-surface)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-md)",
                        padding: "10px var(--space-md)",
                        color: "var(--text-primary)",
                      }}
                    >
                      <span
                        className="font-display"
                        style={{ fontWeight: 600, flex: 1, fontSize: "var(--text-sm)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {p.venue_id}
                      </span>
                      <span
                        className={s.should_file ? "badge badge-warning" : "badge badge-info"}
                        style={{ flexShrink: 0 }}
                      >
                        {s.should_file ? "File" : "Review"}
                      </span>
                      <span className="font-mono text-muted" style={{ flexShrink: 0, fontSize: "var(--text-sm)" }}>
                        {conf}%
                      </span>
                      <span className="font-mono" style={{ flexShrink: 0, fontSize: "var(--text-sm)" }}>
                        ~${Number(median).toLocaleString()}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Broker-only: cross-venue override calibration summary.
          One-glance signal for "are operator overrides well-calibrated across
          the whole portfolio?" — sits above filters so it's the first thing
          a broker sees on this page. */}
      {isBroker && overrideStats && overrideStats.override_total > 0 && (() => {
        const right = overrideStats.override_right_rate;
        const baseline = overrideStats.non_override_right_rate;
        const decided = overrideStats.override_approved + overrideStats.override_rejected;
        const rateColor =
          right == null
            ? "var(--text-secondary)"
            : baseline == null
            ? "var(--brand-primary)"
            : right >= baseline
            ? "var(--brand-primary)"
            : right >= baseline * 0.6
            ? "var(--state-warning)"
            : "var(--state-error)";
        const delta = right != null && baseline != null ? Math.round((right - baseline) * 100) : null;
        return (
          <div className="lc-card mb-lg" style={{ borderLeft: `3px solid ${rateColor}` }}>
            <div className="lc-card__inner flex items-center justify-between flex-wrap gap-md">
              <div>
                <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>
                  Portfolio override calibration
                </p>
                <p className="text-xs text-secondary" style={{ margin: "4px 0 0" }}>
                  Operator-override approval rate compared to recommender-supported proposals
                </p>
              </div>
              <div className="flex gap-lg items-baseline">
                <div>
                  <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>Overrides</p>
                  <p className="text-2xl font-bold font-mono" style={{ color: rateColor, margin: 0 }}>
                    {right == null ? "—" : `${Math.round(right * 100)}%`}
                  </p>
                  <p className="text-xs text-secondary" style={{ margin: 0 }}>
                    {decided} of {overrideStats.override_total} decided
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>Baseline</p>
                  <p className="text-2xl font-bold font-mono text-secondary" style={{ margin: 0 }}>
                    {baseline == null ? "—" : `${Math.round(baseline * 100)}%`}
                  </p>
                  <p className="text-xs text-secondary" style={{ margin: 0 }}>Non-overrides</p>
                </div>
                {delta != null && (
                  <div>
                    <p className="text-xs uppercase tracking-wide text-secondary" style={{ margin: 0 }}>Δ</p>
                    <p
                      className="text-2xl font-bold font-mono"
                      style={{
                        color: delta >= 0 ? "var(--brand-primary)" : "var(--state-error)",
                        margin: 0,
                      }}
                    >
                      {delta >= 0 ? "+" : ""}{delta} pp
                    </p>
                    <p className="text-xs text-secondary" style={{ margin: 0 }}>vs baseline</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      <div className="lc-card mb-lg">
        <div className="lc-card__inner flex gap-md items-end flex-wrap">
          <div>
            <label className="text-xs uppercase tracking-wide text-secondary block mb-xs">State</label>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as StateFilter)}
              className="text-sm p-sm"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)" }}
            >
              <option value="all">All</option>
              <option value="pending_broker_review">Pending</option>
              <option value="needs_more_info">Info requested</option>
              <option value="approved">Approved</option>
              <option value="rejected_by_broker">Rejected</option>
              <option value="filed_with_carrier">Filed</option>
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-secondary block mb-xs">Sort by</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="text-sm p-sm"
              style={{ background: "var(--bg-surface)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-sm)", color: "var(--text-primary)" }}
            >
              <option value="proposed_at">Newest first</option>
              <option value="venue_id">Venue</option>
              <option value="state">State</option>
            </select>
          </div>
          {isBroker && (
            <label className="flex items-center gap-sm text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={overrideOnly}
                onChange={(e) => setOverrideOnly(e.target.checked)}
              />
              Show overrides only
            </label>
          )}
        </div>
      </div>

      <div className="lc-rule">
        <span className="lc-rule__label">Proposals</span>
        <span className="lc-rule__count">
          {filter !== "all" || overrideOnly
            ? `${visible.length} / ${proposals.length}`
            : String(proposals.length).padStart(2, "0")}
        </span>
        <div className="lc-rule__line" />
      </div>

      {loading ? (
        <div className="page-loading"><div className="loading-spinner" /></div>
      ) : visible.length === 0 ? (
        <div className="lc-card">
          <div className="lc-card__inner flex flex-col items-center gap-md text-center" style={{ padding: "48px 24px" }}>
            <FileSpreadsheet size={32} className="text-secondary" />
            <p className="text-sm text-secondary">
              {proposals.length === 0
                ? isBroker
                  ? "No claim proposals yet across your portfolio."
                  : "You haven't proposed any claims yet. Propose one from a packet's Claim Decision section."
                : "No claim proposals match the current filters."}
            </p>
          </div>
        </div>
      ) : (
        <ResponsiveTable headers={["Venue", "State", "Flags", "Proposed"]}>
          {visible.map((p) => {
            const overrideTag = p.override_recommendation;
            const openPacket = () => router.push(`/claim-proposals/${p.packet_id}`);
            return (
              <tr
                key={p.id}
                role="button"
                tabIndex={0}
                onClick={openPacket}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openPacket();
                  }
                }}
                style={{
                  cursor: "pointer",
                  ...(overrideTag ? { background: "rgba(255,153,0,0.04)" } : {}),
                }}
              >
                <td data-label="Venue" className="font-mono text-xs">{p.venue_id}</td>
                <td data-label="State">
                  <span
                    className="text-xs font-mono px-sm py-xs"
                    style={{
                      color: STATE_COLOR[p.state],
                      border: `1px solid ${STATE_COLOR[p.state]}`,
                      borderRadius: "var(--radius-sm)",
                      textTransform: "uppercase",
                    }}
                  >
                    {STATE_LABEL[p.state]}
                  </span>
                </td>
                <td data-label="Flags">
                  {overrideTag ? (
                    <span className="text-xs font-mono" style={{ color: "var(--state-warning)" }}>
                      <AlertTriangle size={12} style={{ display: "inline", marginRight: 4 }} />
                      OVERRIDE · {(p.override_reason ?? "").replace(/_/g, " ")}
                    </span>
                  ) : (
                    <span className="text-xs text-secondary">—</span>
                  )}
                </td>
                <td data-label="Proposed" className="text-xs text-secondary">
                  {new Date(p.proposed_at).toLocaleString()}
                </td>
              </tr>
            );
          })}
        </ResponsiveTable>
      )}
    </div>
  );
}
