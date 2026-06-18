"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, Check } from "lucide-react";
import {
  fetchExposure,
  filterFindingsForVenue,
  findingToAdvicePayload,
  recordCoverageAdvice,
  type Finding,
} from "@/lib/intelligence";
import { SEVERITY_COLOR } from "@/lib/risk";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

/** The broker's queue depth — folded into this panel as a subordinate footer so
 *  the dashboard has ONE attention surface, not two. `expiringRenewals` is
 *  passed in because it derives from portfolio data the panel doesn't fetch. */
export interface BrokerQueues {
  expiringRenewals: number;
}

/** One queue counter → a number, a label, and a deep-link. Hidden at 0, mirroring
 *  the old BrokerTriageStrip's TriageCell. Pure navigation: no severity, never a
 *  Finding — these counts must never touch the calibration loop. */
function QueueTile({ n, label, href }: { n: number; label: string; href: string }) {
  if (n <= 0) return null;
  return (
    <Link href={href} className="lc-exposure__queue-tile" style={{ textDecoration: "none" }}>
      <span className="lc-exposure__queue-num">{n}</span>
      <span className="lc-exposure__queue-label">{label}</span>
    </Link>
  );
}

/**
 * Proactive "Attention / Exposure" panel — the deterministic surface of the
 * Risk Intelligence Layer. Requires no question from the user: it tells them
 * what matters now, why (with click-through citations), and what to do next.
 *
 * A busy venue can surface 100+ findings. Rendering them all is a wall an
 * operator can't scan mid-shift, so the panel is a triage surface: sorted
 * most-urgent-first, filterable by severity, and paginated to PAGE_SIZE rows
 * so each page is digestible. Vertical = the rows in a page; horizontal = the
 * Prev/Next pager across pages.
 */
const PAGE_SIZE = 5;

// Explicit triage order — most urgent first. We sort/filter on this rather
// than on severity_rank so the ordering is self-evident at the call site and
// independent of how the backend numbers ranks.
const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];
type SeverityFilter = "all" | Severity;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function ExposurePanel(
  { venueId, brokerQueues }: { venueId?: string; brokerQueues?: BrokerQueues | null } = {},
) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const [page, setPage] = useState(0);
  // Per-finding E&O acknowledgement state (idle → loading → done / failed).
  const [ack, setAck] = useState<Record<string, "loading" | "done" | "failed">>({});

  // Broker queue depth — fetched independently of findings so a findings error
  // never hides the (cheap, always-relevant) queue counts, and vice versa.
  const brokerQueuesEnabled = !!brokerQueues;
  const [qProposals, setQProposals] = useState(0);
  const [qRequests, setQRequests] = useState(0);
  useEffect(() => {
    if (!brokerQueuesEnabled) return;
    let active = true;
    (async () => {
      try {
        const [p, r] = await Promise.all([
          fetch(`${API_URL}/api/claim-proposals?status=pending_broker_review`, { headers: authHeaders() }),
          fetch(`${API_URL}/api/policy-requests`, { headers: authHeaders() }),
        ]);
        if (!active) return;
        if (p.ok) {
          const d = await p.json();
          setQProposals(Array.isArray(d) ? d.length : 0);
        }
        if (r.ok) {
          const d = await r.json();
          setQRequests(
            Array.isArray(d)
              ? d.filter((x: { status: string }) => ["requested", "pending", "open"].includes(x.status)).length
              : 0,
          );
        }
      } catch {
        /* queues are best-effort navigation — degrade silently */
      }
    })();
    return () => {
      active = false;
    };
  }, [brokerQueuesEnabled]);

  // GUARDRAIL: this total drives ONLY the footer's visibility — never the header
  // count. The header "N open · M need eyes" stays findings-only (see below), so
  // raw queue volume can't dilute the judgment signal.
  const queueTotal = brokerQueuesEnabled
    ? qProposals + qRequests + (brokerQueues?.expiringRenewals ?? 0)
    : 0;
  const queueFooter =
    queueTotal > 0 ? (
      <div className="lc-exposure__queues">
        <div className="lc-exposure__queues-label lc-stat-label">Your queues</div>
        <div className="lc-exposure__queue-tiles">
          <QueueTile n={qProposals} label="proposals to decide" href="/work-queue" />
          <QueueTile n={brokerQueues?.expiringRenewals ?? 0} label="renewals expiring (60d)" href="/renewals" />
          <QueueTile n={qRequests} label="open requests" href="/policy-requests" />
        </div>
      </div>
    ) : null;

  async function acknowledge(f: Finding) {
    const payload = findingToAdvicePayload(f);
    if (!payload || ack[f.id] === "loading" || ack[f.id] === "done") return;
    setAck((s) => ({ ...s, [f.id]: "loading" }));
    try {
      await recordCoverageAdvice(payload);
      setAck((s) => ({ ...s, [f.id]: "done" }));
    } catch {
      setAck((s) => ({ ...s, [f.id]: "failed" }));
    }
  }

  useEffect(() => {
    let active = true;
    fetchExposure()
      .then((r) => active && setFindings(r.findings))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  // Reset to the first page whenever the operator changes the severity lens.
  useEffect(() => {
    setPage(0);
  }, [filter]);

  // Stable sort: most-urgent severity first, backend order preserved within a
  // severity. Computed once per fetch so paging never reshuffles rows.
  const sorted = useMemo(
    () =>
      findings
        ? [...filterFindingsForVenue(findings, venueId)].sort(
            (a, b) => (SEVERITY_WEIGHT[a.severity] ?? 9) - (SEVERITY_WEIGHT[b.severity] ?? 9),
          )
        : [],
    [findings, venueId],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sorted.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of sorted) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [sorted]);

  const visible = useMemo(
    () => (filter === "all" ? sorted : sorted.filter((f) => f.severity === filter)),
    [sorted, filter],
  );

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // Clamp in render so a shrinking filtered set can't strand us on an empty page.
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const pageItems = visible.slice(start, start + PAGE_SIZE);
  // "need eyes" = the urgent bucket (critical + high), mirroring the broker book.
  const urgent = counts.critical + counts.high;

  // Findings failed to load, but the queue footer is independent — still surface
  // it if anything's queued. Otherwise degrade silently (never block the dashboard).
  if (error) {
    return queueFooter ? (
      <section aria-label="What needs attention" className="lc-exposure">
        {queueFooter}
      </section>
    ) : null;
  }
  if (findings === null) return null; // loading: no skeleton needed for v1
  // Truly empty only when there are no findings AND nothing queued. With queued
  // items we fall through to the normal render (header "0 open" + footer).
  if (sorted.length === 0 && queueTotal === 0) {
    return (
      <section aria-label="What needs attention" className="lc-exposure">
        <p style={{ color: "var(--text-tertiary)" }}>✓ Nothing needs your attention right now.</p>
      </section>
    );
  }

  return (
    <section aria-label="What needs attention" className="lc-exposure">
      <div className="lc-exposure__head">
        <h2 className="lc-exposure__title">
          <AlertTriangle size={18} aria-hidden /> What needs your attention
        </h2>
        <span className="lc-exposure__kpi">
          {/* GUARDRAIL: findings-only count. Queue depth lives in the footer and
              must never inflate this number — that's what keeps the judgment
              signal ("need eyes") clean. */}
          <b data-testid="exposure-open-count">{counts.all}</b> open
          {urgent > 0 && (
            <>
              {" · "}
              <span className="hi">{urgent} need eyes</span>
            </>
          )}
        </span>

        <div className="lc-exposure__chips" role="group" aria-label="Filter by severity">
          <button
            type="button"
            className="lc-triage__chip"
            data-active={filter === "all"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All · {counts.all}
          </button>
          {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <button
              key={s}
              type="button"
              className="lc-triage__chip"
              data-active={filter === s}
              aria-pressed={filter === s}
              onClick={() => setFilter(s)}
            >
              {SEVERITY_LABEL[s]} · {counts[s]}
            </button>
          ))}
        </div>
      </div>

      <ul className="lc-exposure__list">
        {pageItems.map((f) => (
          <li
            key={f.id}
            className="lc-exposure__row"
            style={{ ["--sev-color" as string]: SEVERITY_COLOR[f.severity] ?? "var(--text-tertiary)" }}
          >
            <div className="lc-exposure__row-main">
              <span className="lc-exposure__sev">{SEVERITY_LABEL[f.severity as Severity] ?? f.severity}</span>
              <Link href={f.subject.href} className="lc-exposure__subject" title={f.subject.label || f.subject.entity_id}>
                {f.subject.label || f.subject.entity_id}
              </Link>
              <p className="lc-exposure__why">{f.why[0]?.excerpt}</p>
            </div>
            <div className="lc-exposure__row-aside">
              <Link href={f.recommended_action.href} className="lc-exposure__action">
                {f.recommended_action.label} →
              </Link>
              {findingToAdvicePayload(f) && (
                <AcknowledgeButton state={ack[f.id]} onClick={() => acknowledge(f)} />
              )}
            </div>
          </li>
        ))}
      </ul>

      {visible.length > PAGE_SIZE && (
        <div className="lc-exposure__pager">
          <span className="lc-exposure__pager-info" aria-live="polite">
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, visible.length)} of {visible.length}
          </span>
          <div className="lc-exposure__pager-controls">
            <button
              type="button"
              className="lc-exposure__pager-btn"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage === 0}
              aria-label="Previous page"
            >
              <ChevronLeft size={16} aria-hidden /> Prev
            </button>
            <span className="lc-exposure__pager-page">
              Page {safePage + 1} of {pageCount}
            </span>
            <button
              type="button"
              className="lc-exposure__pager-btn"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              aria-label="Next page"
            >
              Next <ChevronRight size={16} aria-hidden />
            </button>
          </div>
        </div>
      )}

      {/* Your queues — subordinate navigation footer (broker only). */}
      {queueFooter}
    </section>
  );
}

/**
 * Records the broker's E&O acknowledgement of a coverage finding. Three states:
 * idle (record), loading (disabled feedback), done (✓ icon + text — never colour
 * alone). A failed POST degrades to a retry rather than silently swallowing.
 */
function AcknowledgeButton({
  state,
  onClick,
}: {
  state: "loading" | "done" | "failed" | undefined;
  onClick: () => void;
}) {
  if (state === "done") {
    return (
      <span
        className="lc-exposure__ack lc-exposure__ack--done"
        role="status"
        aria-live="polite"
        style={{ color: "var(--state-success)", display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        <Check size={13} aria-hidden /> Acknowledged
      </span>
    );
  }
  const loading = state === "loading";
  return (
    <button
      type="button"
      className="lc-exposure__ack"
      onClick={onClick}
      disabled={loading}
      aria-label="Acknowledge this coverage exposure for the E&O record"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "3px 10px",
        fontSize: "0.72rem",
        fontFamily: "var(--font-mono)",
        color: state === "failed" ? "var(--state-warning)" : "var(--accent-ink)",
        background: "transparent",
        border: `1px solid ${state === "failed" ? "var(--state-warning)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-sm)",
        cursor: loading ? "default" : "pointer",
        opacity: loading ? 0.6 : 1,
      }}
    >
      {loading ? "Recording…" : state === "failed" ? "Retry acknowledge" : "Acknowledge (E&O)"}
    </button>
  );
}
