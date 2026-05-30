import { Colors } from "../theme/colors";
/**
 * Mobile typed API client for operator→broker PolicyRequest endpoints.
 *
 * MIRROR OF frontend/src/lib/policyRequests.ts — same wire shapes, routed
 * through the shared `api.request` helper in client.ts.
 */
import { api } from './client';

// ─── Wire types ─────────────────────────────────────────────────────────

export type PolicyRequestType = 'renewal' | 'cancellation' | 'coi' | 'coverage_change';
export type PolicyRequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

export interface PolicyRequest {
  id: string;
  policy_id: string;
  venue_id: string;
  request_type: PolicyRequestType;
  status: PolicyRequestStatus;
  requested_by: string;
  note: string;
  payload: Record<string, unknown>;
  decided_by: string | null;
  decision_note: string | null;
  decided_at: string | null;
  // What an approval created, for deep-linking (execute-on-approval).
  result_entity_type?: 'submission' | 'certificate' | 'policy' | null;
  result_entity_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CoveragePolicy {
  id: string;
  policy_number: string | null;
  venue_id: string;
  carrier_id: string;
  status: string;
  effective_date: string;
  expiration_date: string;
  annual_premium: string;
  coverage_lines: string[];
}

export const REQUEST_TYPE_LABEL: Record<PolicyRequestType, string> = {
  renewal: 'Renewal',
  cancellation: 'Cancellation',
  coi: 'Certificate of insurance',
  coverage_change: 'Coverage change',
};

export const REQUEST_TYPE_HINT: Record<PolicyRequestType, string> = {
  renewal: 'Ask your broker to re-quote this policy before it expires.',
  cancellation: 'Request to end this policy early. Your broker confirms terms.',
  coi: 'Request a certificate of insurance for a landlord, venue, or vendor.',
  coverage_change: 'Ask to adjust limits, add a location, or change coverage.',
};

export const REQUEST_STATUS_LABEL: Record<PolicyRequestStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  declined: 'Declined',
  cancelled: 'Withdrawn',
};

/** Glyph + color per status — same visual language as claim-tokens. */
export const REQUEST_STATUS_COLOR: Record<PolicyRequestStatus, string> = {
  pending: Colors.warning,
  approved: Colors.success,
  declined: Colors.error,
  cancelled: Colors.textMuted,
};

// ─── Request bodies ─────────────────────────────────────────────────────

export interface CreatePolicyRequestBody {
  request_type: PolicyRequestType;
  note?: string;
  payload?: Record<string, unknown>;
}

// ─── Endpoints ──────────────────────────────────────────────────────────

export const policyRequestsApi = {
  coverageForVenue: (venueId: string) =>
    api.request<CoveragePolicy[]>(`/api/venues/${venueId}/policies`),

  create: (policyId: string, body: CreatePolicyRequestBody) =>
    api.request<PolicyRequest>(`/api/policies/${policyId}/requests`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  list: (params: { venue_id?: string; policy_id?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    return api.request<PolicyRequest[]>(`/api/policy-requests${qs ? `?${qs}` : ''}`);
  },

  listForPolicy: (policyId: string) =>
    api.request<PolicyRequest[]>(`/api/policies/${policyId}/requests`),

  decide: (requestId: string, decision: 'approved' | 'declined', decisionNote?: string) =>
    api.request<PolicyRequest>(`/api/policy-requests/${requestId}/decide`, {
      method: 'POST',
      body: JSON.stringify({ decision, decision_note: decisionNote ?? null }),
    }),

  cancel: (requestId: string) =>
    api.request<PolicyRequest>(`/api/policy-requests/${requestId}/cancel`, { method: 'POST' }),
};
