/**
 * Pure presentational helpers for the PolicyRequests screen — extracted so they
 * can be unit-tested without rendering React Native (mirrors the web lib's
 * approvalResultLink). Type-only import keeps this module free of expo runtime
 * deps so the jest test stays a plain logic test.
 */
import type { PolicyRequest } from '../api/policyRequests';

/** One-line summary of a request's payload, or null when there's nothing extra. */
export function detailLine(r: PolicyRequest): string | null {
  const p = r.payload || {};
  if (r.request_type === 'cancellation' && p.cancellation_date) return `Out by ${p.cancellation_date}`;
  if (r.request_type === 'coi' && p.certificate_holder) return `Holder: ${p.certificate_holder}`;
  return null;
}

/**
 * What an approval produced (execute-on-approval). Shown as confirmation text:
 * the detail screens live in other navigators, so we surface the outcome here
 * rather than risk a cross-stack deep-link (web has the live link). Returns null
 * unless the request is approved AND recorded a result entity (e.g. not a
 * decision-only coverage_change).
 */
export function resultLabel(r: PolicyRequest): string | null {
  if (r.status !== 'approved' || !r.result_entity_type) return null;
  switch (r.result_entity_type) {
    case 'submission': return '✓ Renewal submission created';
    case 'certificate': return '✓ Certificate issued';
    case 'policy': return '✓ Policy cancelled';
    default: return null;
  }
}
