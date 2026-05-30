import { detailLine, resultLabel } from './policyRequestView';
import type { PolicyRequest } from '../api/policyRequests';

function req(overrides: Partial<PolicyRequest>): PolicyRequest {
  return {
    id: 'preq-1', policy_id: 'pol-1', venue_id: 'v1', request_type: 'renewal',
    status: 'approved', requested_by: 'op', note: '', payload: {},
    decided_by: 'b1', decision_note: null, decided_at: '2026-05-30',
    result_entity_type: null, result_entity_id: null,
    created_at: '2026-05-30', updated_at: '2026-05-30', ...overrides,
  };
}

describe('detailLine', () => {
  it('summarizes a cancellation date', () => {
    expect(detailLine(req({ request_type: 'cancellation', payload: { cancellation_date: '2026-09-01' } })))
      .toBe('Out by 2026-09-01');
  });
  it('summarizes a COI holder', () => {
    expect(detailLine(req({ request_type: 'coi', payload: { certificate_holder: 'Wythe LLC' } })))
      .toBe('Holder: Wythe LLC');
  });
  it('returns null when the payload has nothing to summarize', () => {
    expect(detailLine(req({ request_type: 'renewal', payload: {} }))).toBeNull();
  });
});

describe('resultLabel', () => {
  it('confirms each approved result entity', () => {
    expect(resultLabel(req({ result_entity_type: 'submission' }))).toBe('✓ Renewal submission created');
    expect(resultLabel(req({ result_entity_type: 'certificate' }))).toBe('✓ Certificate issued');
    expect(resultLabel(req({ result_entity_type: 'policy' }))).toBe('✓ Policy cancelled');
  });
  it('returns null when the request is not approved', () => {
    expect(resultLabel(req({ status: 'pending', result_entity_type: 'submission' }))).toBeNull();
  });
  it('returns null for an approved decision-only request (no result entity)', () => {
    expect(resultLabel(req({ result_entity_type: null }))).toBeNull();
  });
});
