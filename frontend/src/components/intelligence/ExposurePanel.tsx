"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronLeft, ChevronRight, Check } from "lucide-react";
import {
  fetchExposure,
  findingToAdvicePayload,
  recordCoverageAdvice,
  type Finding,
} from "@/lib/intelligence";
import { SEVERITY_COLOR } from "@/lib/risk";

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

export function ExposurePanel() {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const [page, setPage] = useState(0);
  // Per-finding E&O acknowledgement state (idle → loading → done / failed).
  const [ack, setAck] = useState<Record<string, "loading" | "done" | "failed">>({});

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
        ? [...findings].sort(
            (a, b) => (SEVERITY_WEIGHT[a.severity] ?? 9) - (SEVERITY_WEIGHT[b.severity] ?? 9),
          )
        : [],
    [findings],
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

  if (error) return null; // degrade silently — never block the dashboard
  if (findings === null) return null; // loading: no skeleton needed for v1
  if (sorted.length === 0) {
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
          <b>{counts.all}</b> open
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
