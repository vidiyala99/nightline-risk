/**
 * Operator-facing incident status transitions.
 *
 * Kept a strict SUBSET of the backend lifecycle
 * (app/lifecycles.py `INCIDENT_TRANSITIONS`), so the UI never offers a
 * transition the API would 422. The floor-useful ones are exposed (close from
 * open, archive a closed incident). `closed_archived` is terminal.
 *
 * Pure data (no React Native imports) so it's unit-testable — colors are
 * resolved to theme tokens at the call site via a small map.
 */
export type TransitionColor = 'info' | 'success' | 'warning' | 'muted';

export interface IncidentTransition {
  label: string;
  next: string;
  color: TransitionColor;
}

export const STATUS_TRANSITIONS: Record<string, IncidentTransition[]> = {
  open: [
    { label: 'Move to Review', next: 'under_review', color: 'info' },
    { label: 'Close Incident', next: 'closed', color: 'success' },
  ],
  under_review: [
    { label: 'Close Incident', next: 'closed', color: 'success' },
    { label: 'Reopen', next: 'open', color: 'warning' },
  ],
  closed: [
    { label: 'Reopen', next: 'open', color: 'warning' },
    { label: 'Archive', next: 'closed_archived', color: 'muted' },
  ],
  closed_archived: [],
};
