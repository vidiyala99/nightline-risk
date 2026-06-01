/**
 * Mobile typed API client for the broker policies surface.
 *
 * MIRROR OF frontend/src/lib/policies.ts — same wire shapes, same call
 * signatures, routed through `api.request` (client.ts) for shared auth.
 *
 * Money fields are STRINGS on the wire — format only at render via
 * formatLedgerMoney (claim-tokens.ts). Keep in sync with the web mirror.
 */
import { api } from './client';
import { Colors } from '../theme/colors';

// ─── Wire types (match backend/app/api/v1/policies.py) ───────────────────

export type PolicyStatus =
  | 'bound_pending_number'
  | 'active'
  | 'cancelled'
  | 'non_renewed'
  | 'lapsed'
  | 'expired';

export interface Policy {
  id: string;
  policy_number: string | null;
  submission_id: string;
  bound_quote_id: string;
  venue_id: string;
  carrier_id: string;
  status: PolicyStatus;
  effective_date: string;
  expiration_date: string;
  annual_premium: string;
  commission_amount: string;
  commission_rate: string;
  commission_paid_at: string | null;
  coverage_lines: string[];
  terms_snapshot: Record<string, unknown>;
  snapshot_hash: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  cancellation_method: 'pro_rata' | 'short_rate' | null;
  refund_amount: string | null;
  bound_at: string | null;
}

export interface Endorsement {
  id: string;
  policy_id: string;
  endorsement_type: string;
  effective_date: string;
  description: string;
  premium_change: string;
  tax_change: string;
  terms_diff: Record<string, unknown>;
  issued_at: string;
  created_by: string;
}

export interface CertificateOfInsurance {
  id: string;
  policy_id: string;
  certificate_holder: string;
  certificate_holder_address: string;
  additional_insured: boolean;
  additional_insured_scope: string | null;
  description_of_operations: string;
  status: 'active' | 'superseded' | 'cancelled';
  issued_at: string;
  expires_on: string;
  pdf_path: string | null;
  issued_by: string;
}

export interface PolicyDetail extends Policy {
  endorsements: Endorsement[];
  certificates: CertificateOfInsurance[];
}

// ─── Status label + color maps ───────────────────────────────────────────

export const POLICY_STATUS_LABEL: Record<PolicyStatus, string> = {
  bound_pending_number: 'Pending number',
  active: 'Active',
  cancelled: 'Cancelled',
  non_renewed: 'Non-renewed',
  lapsed: 'Lapsed',
  expired: 'Expired',
};

export const POLICY_STATUS_COLOR: Record<PolicyStatus, string> = {
  bound_pending_number: Colors.warning,
  active: Colors.success,
  cancelled: Colors.error,
  non_renewed: Colors.textMuted,
  lapsed: Colors.textMuted,
  expired: Colors.textMuted,
};

// ─── Endpoints ────────────────────────────────────────────────────────────

export const policiesApi = {
  /** Bind a selected quote into a policy. Used by the submission flow. */
  bind: (
    qid: string,
    body: { policy_number?: string; effective_date?: string; term_length_days?: number } = {},
  ) =>
    api.request<Policy>(`/api/quotes/${qid}/bind`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  list: (params: { status?: string; venue_id?: string; carrier_id?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return api.request<Policy[]>(`/api/policies${qs ? `?${qs}` : ''}`);
  },

  get: (pid: string) => api.request<PolicyDetail>(`/api/policies/${pid}`),

  assignNumber: (pid: string, policy_number: string) =>
    api.request<Policy>(`/api/policies/${pid}/policy-number`, {
      method: 'PATCH',
      body: JSON.stringify({ policy_number }),
    }),

  cancel: (
    pid: string,
    body: { reason: string; method: 'pro_rata' | 'short_rate'; cancellation_date: string },
  ) =>
    api.request<Policy>(`/api/policies/${pid}/cancel`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // End-of-life transitions. expire/reinstate take no reason; non-renew and
  // lapse record one. Mirrors the web policies client.
  expire: (pid: string, reason = '') =>
    api.request<Policy>(`/api/policies/${pid}/expire`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  nonRenew: (pid: string, reason: string) =>
    api.request<Policy>(`/api/policies/${pid}/non-renew`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  lapse: (pid: string, reason: string) =>
    api.request<Policy>(`/api/policies/${pid}/lapse`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  reinstate: (pid: string, reason = '') =>
    api.request<Policy>(`/api/policies/${pid}/reinstate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  // Authoring — mid-term endorsement + certificate issuance. terms_diff shape
  // is type-specific (see EndorsePolicyScreen.buildTermsDiff); the backend
  // re-validates. Mirrors web policiesApi.issueEndorsement / issueCertificate.
  issueEndorsement: (
    pid: string,
    body: {
      endorsement_type: string;
      effective_date: string;
      terms_diff: Record<string, unknown>;
      premium_change?: string;
      tax_change?: string;
      description?: string;
    },
  ) =>
    api.request<Endorsement>(`/api/policies/${pid}/endorsements`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  issueCertificate: (
    pid: string,
    body: {
      certificate_holder: string;
      certificate_holder_address: string;
      description_of_operations: string;
      expires_on: string;
      additional_insured?: boolean;
      additional_insured_scope?: string | null;
    },
  ) =>
    api.request<CertificateOfInsurance>(`/api/policies/${pid}/certificates`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
