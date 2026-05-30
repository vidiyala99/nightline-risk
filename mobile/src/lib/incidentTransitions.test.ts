import { STATUS_TRANSITIONS } from './incidentTransitions';

// Oracle = backend app/lifecycles.py INCIDENT_TRANSITIONS (the source of truth).
// The mobile matrix MUST be a subset so the UI never offers a transition the
// API would 422.
const BACKEND_INCIDENT_TRANSITIONS: Record<string, string[]> = {
  open: ['under_review', 'closed', 'closed_archived'],
  under_review: ['open', 'closed', 'closed_archived'],
  closed: ['open', 'under_review', 'closed_archived'],
  closed_archived: [],
};

describe('mobile incident STATUS_TRANSITIONS', () => {
  it('only offers transitions the backend lifecycle allows', () => {
    for (const [from, opts] of Object.entries(STATUS_TRANSITIONS)) {
      for (const opt of opts) {
        expect(BACKEND_INCIDENT_TRANSITIONS[from] ?? []).toContain(opt.next);
      }
    }
  });

  it('lets an operator close an open incident from the floor', () => {
    expect(STATUS_TRANSITIONS.open.map((o) => o.next)).toContain('closed');
  });

  it('does not offer transitions out of the terminal closed_archived state', () => {
    expect(STATUS_TRANSITIONS.closed_archived ?? []).toHaveLength(0);
  });
});
