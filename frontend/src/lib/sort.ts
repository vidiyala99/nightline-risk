/**
 * Shared list-ordering convention: most-actionable-first, recency as tiebreaker.
 *
 * One place defines what "needs attention" means per entity so every list view
 * agrees (and so the client matches the backend ORDER BY, which reads the same
 * priority maps in app/lifecycles.py). Higher weight sorts first.
 *
 * Usage:
 *   const sorted = [...rows].sort(actionableFirst(incidentUrgency, r => r.occurred_at));
 *   const sorted = [...rows].sort(byStatusPriority(CLAIM_PRIORITY, r => r.status, r => r.created_at));
 */

// ─── Status priority maps (mirror app/lifecycles.py) ──────────────────────

export const INCIDENT_STATUS_PRIORITY: Record<string, number> = {
  open: 100,
  under_review: 60,
  closed: 10,
  closed_archived: 0,
};

export const CLAIM_STATUS_PRIORITY: Record<string, number> = {
  notified: 100,
  reopened: 95,
  acknowledged: 80,
  under_investigation: 70,
  reserved: 60,
  settling: 50,
  closed_paid: 10,
  closed_denied: 10,
  closed_dropped: 5,
};

export const SUBMISSION_STATUS_PRIORITY: Record<string, number> = {
  quoting: 100,
  in_market: 80,
  open: 60,
  bound: 20,
  lost: 5,
  declined: 5,
  withdrawn: 5,
};

/** Higher severity sorts first. Mirrors lib/risk.ts SEVERITY_COLOR keys. */
export const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

// ─── Comparators ──────────────────────────────────────────────────────────

const recency = (v: unknown): number => {
  const t = new Date(String(v ?? "")).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Compose an "actionable-first" comparator from a weight function. Higher
 * weight first; newer `dateOf` breaks ties (newest first). `dateOf` defaults to
 * a no-op so a pure weight sort is `actionableFirst(weightFn)`.
 */
export function actionableFirst<T>(
  weightOf: (row: T) => number,
  dateOf: (row: T) => unknown = () => 0,
): (a: T, b: T) => number {
  return (a, b) =>
    weightOf(b) - weightOf(a) || recency(dateOf(b)) - recency(dateOf(a));
}

/** Sort by a status-priority map, newest `dateOf` breaking ties. */
export function byStatusPriority<T>(
  priority: Record<string, number>,
  statusOf: (row: T) => string,
  dateOf: (row: T) => unknown = () => 0,
): (a: T, b: T) => number {
  return actionableFirst((row) => priority[statusOf(row)] ?? 0, dateOf);
}

/** Sort by severity (critical→unknown), newest `dateOf` breaking ties. */
export function bySeverity<T>(
  severityOf: (row: T) => string,
  dateOf: (row: T) => unknown = () => 0,
): (a: T, b: T) => number {
  return actionableFirst((row) => SEVERITY_WEIGHT[severityOf(row)] ?? 0, dateOf);
}

/** Plain newest-first by a date field. */
export function byRecency<T>(dateOf: (row: T) => unknown): (a: T, b: T) => number {
  return (a, b) => recency(dateOf(b)) - recency(dateOf(a));
}

// ─── Incident urgency (status + signal boosts) ────────────────────────────

export interface IncidentLike {
  id: string;
  status: string;
  injury_observed?: boolean;
  police_called?: boolean;
  ems_called?: boolean;
}

/**
 * Triage weight for an incident: status priority plus signal boosts, with
 * already-filed incidents sinking (a claim is in motion — less to do here).
 * Lifted from the old inline incidents/page.tsx helper so it's reused, not
 * re-implemented per surface. `hasClaim` lets callers that fetch the claim feed
 * (web + mobile) sink filed incidents; omit it when that data isn't loaded.
 */
export function incidentUrgency(i: IncidentLike, hasClaim = false): number {
  let score = INCIDENT_STATUS_PRIORITY[i.status] ?? 0;
  if (hasClaim) score -= 50;
  if (i.injury_observed) score += 8;
  if (i.police_called) score += 4;
  if (i.ems_called) score += 4;
  return score;
}
