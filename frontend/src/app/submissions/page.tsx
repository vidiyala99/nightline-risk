"use client";

/**
 * /submissions — the broker placement kanban.
 *
 * Columns map to lifecycle states (Open / In Market / Quoting / Recently
 * Closed). Each card shows venue, effective date, coverage line chips, and
 * age in market. Status transitions are surfaced as buttons on each card
 * — drag-drop UI is deferred to a future commit since drop-target
 * validation requires consulting the transition matrix on every dragover,
 * which is fiddlier than the value justifies for a portfolio piece.
 *
 * The transition matrix IS fetched on mount and used to render only the
 * legal next-state buttons per card. That's the value of the
 * `GET /api/submissions/transitions` endpoint — single source of truth
 * for what's allowed.
 */
import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusPill } from "@/components/ui/StatusPill";
import {
  placementApi,
  PlacementApiError,
  Submission,
  SubmissionStatus,
  STATUS_LABEL,
  STATUS_TONE,
  TransitionMatrix,
} from "@/lib/placement";

// Visible columns + their lifecycle states. We collapse the four terminal
// states into one "Recently closed" column so the kanban stays scannable.
const COLUMNS: { id: string; label: string; statuses: SubmissionStatus[] }[] = [
  { id: "open",       label: "Open",       statuses: ["open"] },
  { id: "in_market",  label: "In Market",  statuses: ["in_market"] },
  { id: "quoting",    label: "Quoting",    statuses: ["quoting"] },
  { id: "closed",     label: "Recently Closed", statuses: ["bound", "lost", "declined", "withdrawn"] },
];

const ALL_STATUSES: SubmissionStatus[] = [
  "open", "in_market", "quoting", "bound", "lost", "declined", "withdrawn",
];

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
}

function SubmissionCard({
  sub,
  transitions,
  onAdvance,
  onWithdraw,
}: {
  sub: Submission;
  transitions: TransitionMatrix | null;
  onAdvance: (sub: Submission, to: SubmissionStatus) => void;
  onWithdraw: (sub: Submission) => void;
}) {
  const allowed = (transitions?.[sub.status] ?? []) as SubmissionStatus[];
  const inMarketAge = daysSince(sub.submitted_at);

  return (
    <div className="submission-card">
      <div className="submission-card__head">
        <Link
          href={`/submissions/${sub.id}`}
          className="submission-card__venue"
        >
          {sub.venue_id}
        </Link>
        <StatusPill tone={STATUS_TONE[sub.status]}>
          {STATUS_LABEL[sub.status]}
        </StatusPill>
      </div>

      <div className="submission-card__meta">
        <span>Effective {sub.effective_date}</span>
        {inMarketAge !== null && (
          <span>· {inMarketAge}d in market</span>
        )}
      </div>

      {sub.coverage_lines.length > 0 && (
        <div className="submission-card__lines">
          {sub.coverage_lines.map(line => (
            <span key={line} className="submission-card__chip">
              {line}
            </span>
          ))}
        </div>
      )}

      <div className="submission-card__actions">
        {allowed
          .filter(s => s !== "withdrawn")  // withdrawn has its own button below
          .map(target => (
            <button
              key={target}
              type="button"
              className="submission-card__btn"
              onClick={() => onAdvance(sub, target)}
            >
              → {STATUS_LABEL[target]}
            </button>
          ))
        }
        {allowed.includes("withdrawn") && (
          <button
            type="button"
            className="submission-card__btn submission-card__btn--danger"
            onClick={() => onWithdraw(sub)}
          >
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}

export default function SubmissionsPage() {
  const [loading, setLoading] = useState(true);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [transitions, setTransitions] = useState<TransitionMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [subs, mtx] = await Promise.all([
        placementApi.listSubmissions(
          showClosed ? { status: ALL_STATUSES.join(",") } : {},
        ),
        placementApi.getTransitions(),
      ]);
      setSubmissions(subs);
      setTransitions(mtx);
    } catch (e) {
      const msg = e instanceof PlacementApiError ? e.message : "Failed to load submissions";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [showClosed]);

  const byColumn = useMemo(() => {
    const result: Record<string, Submission[]> = Object.fromEntries(
      COLUMNS.map(c => [c.id, []]),
    );
    for (const sub of submissions) {
      const col = COLUMNS.find(c => c.statuses.includes(sub.status));
      if (col) result[col.id].push(sub);
    }
    return result;
  }, [submissions]);

  const handleAdvance = async (sub: Submission, _to: SubmissionStatus) => {
    // Real "advance" semantics depend on the target. For now route to
    // the detail page where the broker chooses carriers / records quotes
    // / selects. The kanban surfaces the available transition as a
    // navigation cue, not an in-place mutation, so we don't accidentally
    // skip required workflow steps.
    window.location.href = `/submissions/${sub.id}`;
  };

  const handleWithdraw = async (sub: Submission) => {
    const reason = window.prompt(
      `Withdraw submission for ${sub.venue_id}? Enter a reason:`,
    );
    if (!reason || !reason.trim()) return;
    try {
      await placementApi.withdrawSubmission(sub.id, reason.trim());
      await load();
    } catch (e) {
      alert(e instanceof PlacementApiError ? e.message : "Withdraw failed");
    }
  };

  return (
    <div className="placement-page">
      <PageHeader
        eyebrow="Placement"
        title="Submissions"
        subtitle="Active broker book. Open ↦ In Market ↦ Quoting ↦ Bound."
        actions={
          <>
            <label className="placement-page__toggle">
              <input
                type="checkbox"
                checked={showClosed}
                onChange={e => setShowClosed(e.target.checked)}
              />
              Show closed
            </label>
            <Link href="/submissions/new" className="btn btn-primary btn-sm">
              + New Submission
            </Link>
          </>
        }
      />

      {error && (
        <div className="placement-page__error">
          {error}
        </div>
      )}

      {loading ? (
        <div className="placement-page__loading">Loading…</div>
      ) : (
        <div className="submission-kanban" data-testid="submission-kanban">
          {COLUMNS.map(col => {
            const cards = byColumn[col.id] ?? [];
            const isClosed = col.id === "closed";
            if (isClosed && !showClosed) return null;
            return (
              <section key={col.id} className="submission-kanban__col">
                <header className="submission-kanban__col-head">
                  <span className="submission-kanban__col-label">{col.label}</span>
                  <span className="submission-kanban__col-count">
                    {cards.length}
                  </span>
                </header>
                <div className="submission-kanban__col-body">
                  {cards.length === 0 ? (
                    <div className="submission-kanban__empty">
                      No submissions
                    </div>
                  ) : (
                    cards.map(sub => (
                      <SubmissionCard
                        key={sub.id}
                        sub={sub}
                        transitions={transitions}
                        onAdvance={handleAdvance}
                        onWithdraw={handleWithdraw}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
