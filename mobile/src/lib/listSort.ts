/**
 * Shared mobile list-ordering convention — the React Native mirror of the web
 * `frontend/src/lib/sort.ts` and the backend STATUS_PRIORITY maps in
 * app/lifecycles.py. Most-actionable-first, recency as tiebreaker.
 *
 * Mobile screens that "trust the backend" already inherit the correct order
 * from the API's ORDER BY. Use these only where a screen sorts client-side and
 * would otherwise OVERRIDE that order with pure recency.
 */

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

/** Higher severity sorts first. Mirrors the web SEVERITY_WEIGHT. */
export const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0,
};

const recency = (v: unknown): number => {
  const t = new Date(String(v ?? '')).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** Higher weight first; newer `dateOf` breaks ties (newest first). */
export function actionableFirst<T>(
  weightOf: (row: T) => number,
  dateOf: (row: T) => unknown = () => 0,
): (a: T, b: T) => number {
  return (a, b) => weightOf(b) - weightOf(a) || recency(dateOf(b)) - recency(dateOf(a));
}

/** Sort by a status-priority map, newest `dateOf` breaking ties. */
export function byStatusPriority<T>(
  priority: Record<string, number>,
  statusOf: (row: T) => string,
  dateOf: (row: T) => unknown = () => 0,
): (a: T, b: T) => number {
  return actionableFirst((row) => priority[statusOf(row)] ?? 0, dateOf);
}

/** Plain newest-first by a date field. */
export function byRecency<T>(dateOf: (row: T) => unknown): (a: T, b: T) => number {
  return (a, b) => recency(dateOf(b)) - recency(dateOf(a));
}

/** Sort by severity (critical→unknown), newest `dateOf` breaking ties. */
export function bySeverity<T>(
  severityOf: (row: T) => string,
  dateOf: (row: T) => unknown = () => 0,
): (a: T, b: T) => number {
  return actionableFirst((row) => SEVERITY_WEIGHT[severityOf(row)] ?? 0, dateOf);
}

/** Plain soonest-first by a date field (e.g. policy expiration). */
export function byAscDate<T>(dateOf: (row: T) => unknown): (a: T, b: T) => number {
  return (a, b) => recency(dateOf(a)) - recency(dateOf(b));
}

export interface IncidentLike {
  status: string;
  injury_observed?: boolean;
  police_called?: boolean;
  ems_called?: boolean;
}

/**
 * Triage weight for an incident — status priority + injury/police/EMS boosts,
 * with already-filed incidents sinking. Mirrors web lib/sort.ts incidentUrgency
 * so a broker sees the same order on both platforms.
 */
export function incidentUrgency(i: IncidentLike, hasClaim = false): number {
  let score = INCIDENT_STATUS_PRIORITY[i.status] ?? 0;
  if (hasClaim) score -= 50;
  if (i.injury_observed) score += 8;
  if (i.police_called) score += 4;
  if (i.ems_called) score += 4;
  return score;
}
