/**
 * Carrier adjuster desk — mobile API + helpers (Phase 2 carrier persona).
 * Mirrors the web `src/lib/adjusting.ts` and the backend endpoints:
 *   GET  /api/adjusting/queue
 *   GET  /api/adjusting/claims/{cid}
 *   POST /api/adjusting/claims/{cid}/decide-coverage
 *   POST /api/adjusting/claims/{cid}/reserve
 *   POST /api/adjusting/claims/{cid}/payment
 *   POST /api/adjusting/claims/{cid}/close
 * Money arrives as STRINGS (broker-platform JSON convention).
 */
import { API_URL, api, getToken } from './client';

export type CoverageDecision = 'covered' | 'denied' | 'reservation_of_rights';

export interface AdjusterQueueRow {
  claim_id: string;
  carrier_claim_number: string | null;
  venue_id: string | null;
  venue_name: string | null;
  coverage_line: string;
  status: string;
  coverage_decision: CoverageDecision | null;
  current_reserve: string;
  total_paid: string;
}

export interface ReserveHint {
  low: string;
  high: string;
  severity_band: string;
  basis: string;
}

export interface Payment {
  id: string;
  payment_type: string;
  amount: string;
  paid_on: string;
  description: string | null;
  recorded_by: string;
}

export interface ReserveChange {
  id: string;
  from_amount: string;
  to_amount: string;
  change_reason: string;
  changed_at: string;
}

export interface AdjusterClaimDetail {
  id: string;
  carrier_claim_number: string | null;
  status: string;
  coverage_line: string;
  coverage_decision: CoverageDecision | null;
  coverage_rationale: string | null;
  current_reserve: string;
  indemnity_paid_to_date: string;
  expense_paid_to_date: string;
  recoveries_to_date: string;
  final_indemnity: string | null;
  fnol_submitted_at: string;
  date_of_loss: string;
  adjuster_name: string | null;
  adjuster_email: string | null;
  defense_package_id: string | null;
  snapshot_hash: string;
  closed_at: string | null;
  reopen_count: number;
  reopened_at: string | null;
  policy_id: string;
  payments: Payment[];
  reserve_changes: ReserveChange[];
}

export interface AdjusterClaimResponse {
  claim: AdjusterClaimDetail;
  venue_id: string | null;
  date_of_loss: string;
  payments: Payment[];
  reserve_history: ReserveChange[];
  reserve_hint: ReserveHint | null;
}

export async function fetchAdjusterQueue(): Promise<AdjusterQueueRow[]> {
  return api.request<AdjusterQueueRow[]>('/api/adjusting/queue');
}

export async function fetchAdjusterClaim(cid: string): Promise<AdjusterClaimResponse> {
  return api.request<AdjusterClaimResponse>(`/api/adjusting/claims/${cid}`);
}

/** POST helper — mirrors underwriteQuote pattern. */
async function post(path: string, body: unknown): Promise<unknown> {
  const token = await getToken();
  const res = await fetch(`${API_URL}/api/adjusting/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      const detail = body?.detail;
      message = typeof detail === 'string' ? detail : detail?.message ?? message;
    } catch {
      // non-JSON error body — keep status message
    }
    throw new Error(message);
  }
  return res.json();
}

export function decideCoverage(
  cid: string,
  decision: CoverageDecision,
  rationale: string,
): Promise<unknown> {
  return post(`claims/${cid}/decide-coverage`, { decision, rationale });
}

export function adjustReserve(
  cid: string,
  new_reserve: string,
  change_reason: string,
): Promise<unknown> {
  return post(`claims/${cid}/reserve`, { new_reserve, change_reason });
}

export function approvePayment(
  cid: string,
  amount: string,
  payment_type: string,
  paid_on: string,
  description: string,
): Promise<unknown> {
  return post(`claims/${cid}/payment`, { amount, payment_type, paid_on, description });
}

export function closeClaim(
  cid: string,
  disposition: string,
  final_indemnity?: string,
): Promise<unknown> {
  return post(`claims/${cid}/close`, { disposition, final_indemnity });
}
