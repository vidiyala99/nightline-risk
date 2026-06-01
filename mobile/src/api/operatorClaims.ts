/**
 * Operator claim-journey feed — mobile counterpart to web's OperatorClaimsTracker
 * (frontend/src/app/claims/page.tsx). Reuses the existing incident-status-feed
 * endpoint (no new backend) and exposes the same plain-language status model the
 * web page uses: Reported → Sent → Approved → Filed → Resolved.
 *
 * A routed ClaimProposal is NOT a carrier Claim (ADR-0004) — status reflects the
 * proposal's broker-review state until a real Claim row exists.
 */
import { api } from './client';

export interface ClaimFeedRow {
  incident_id: string;
  summary: string;
  occurred_at: string;
  status: string;
  proposal_state: string | null;
  claim_status: string | null;
}

export const operatorClaimsApi = {
  feed: (venueId: string) =>
    api.request<ClaimFeedRow[]>(`/api/venues/${venueId}/incident-status-feed`),
};

const TERMINAL_CLAIM_STATUS = new Set(['closed_paid', 'closed_denied', 'closed_dropped']);
const TERMINAL_PROPOSAL_STATE = new Set(['paid', 'denied', 'rejected_by_broker']);

/** An incident has entered the claim journey once a proposal or claim exists. */
export function isClaimRow(r: ClaimFeedRow): boolean {
  return r.proposal_state != null || r.claim_status != null;
}

export function claimIsResolved(r: ClaimFeedRow): boolean {
  return (!!r.claim_status && TERMINAL_CLAIM_STATUS.has(r.claim_status))
    || (!!r.proposal_state && TERMINAL_PROPOSAL_STATE.has(r.proposal_state));
}

export function claimIsFiled(r: ClaimFeedRow): boolean {
  return !claimIsResolved(r) && (!!r.claim_status || r.proposal_state === 'filed_with_carrier');
}

export type ClaimTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

/** Plain-language headline mirroring web claimStatusLabel(). */
export function claimStatusLabel(r: ClaimFeedRow): { text: string; tone: ClaimTone } {
  const ps = r.proposal_state, cs = r.claim_status;
  if (ps === 'paid' || cs === 'closed_paid') return { text: 'Claim paid', tone: 'success' };
  if (ps === 'denied' || cs === 'closed_denied') return { text: 'Claim denied by carrier', tone: 'error' };
  if (cs === 'closed_dropped') return { text: 'Claim withdrawn', tone: 'neutral' };
  if (ps === 'rejected_by_broker') return { text: 'Declined by broker', tone: 'error' };
  if (ps === 'filed_with_carrier' || cs) return { text: 'Filed with the carrier', tone: 'info' };
  if (ps === 'approved') return { text: 'Approved — filing with carrier', tone: 'success' };
  if (ps === 'needs_more_info') return { text: 'Broker needs more info', tone: 'warning' };
  return { text: "Awaiting your broker's decision", tone: 'info' };
}

/** Reported → Sent → Approved → Filed → Resolved, lit per row (mirrors web claimSteps). */
export function claimSteps(r: ClaimFeedRow): { label: string; lit: boolean }[] {
  const ps = r.proposal_state ?? '';
  const cs = r.claim_status ?? '';
  return [
    { label: 'Reported', lit: true },
    { label: 'Sent', lit: !!r.proposal_state },
    { label: 'Approved', lit: ['approved', 'filed_with_carrier', 'paid', 'denied'].includes(ps) },
    { label: 'Filed', lit: ['filed_with_carrier', 'paid', 'denied'].includes(ps) || !!r.claim_status },
    { label: 'Resolved', lit: ['paid', 'denied'].includes(ps) || TERMINAL_CLAIM_STATUS.has(cs) },
  ];
}
