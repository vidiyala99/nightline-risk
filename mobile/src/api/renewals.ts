/**
 * Mobile typed API client for Phase 4 renewals endpoints.
 *
 * MIRROR OF frontend/src/lib/renewals.ts — same wire shapes, same call
 * signatures. Routed through the existing `api.request` helper in
 * client.ts, so auth + JSON envelope handling is shared.
 *
 * Money values (annual_premium, projected_loss_adjustment,
 * prior_annual_premium, loss_adjustment) come back as STRINGS — parse
 * only at render time via formatLedgerMoney from claim-tokens.ts.
 */
import { api } from './client';

// ─── Wire types (match backend/app/api/v1/renewals.py response shapes) ───

export interface RenewalDue {
  policy_id: string;
  policy_number: string | null;
  venue_id: string;
  expiration_date: string; // ISO date
  annual_premium: string; // Decimal as string
  loss_ratio: string; // Decimal as string
  claim_count: number;
  projected_loss_adjustment: string; // Decimal as string
}

export interface RenewResult {
  submission: {
    id: string;
    venue_id: string;
    status: string;
    prior_policy_id: string;
    coverage_lines: string[];
    requested_limits: Record<string, unknown>;
    effective_date: string; // ISO date
  };
  yoy_context: {
    prior_policy_id: string;
    prior_annual_premium: string; // Decimal as string
    prior_coverage_lines: string[];
    loss_ratio: string; // Decimal as string
    claim_count: number;
    loss_adjustment: string; // Decimal as string
  };
}

// ─── Endpoints ──────────────────────────────────────────────────────────

export const renewalsApi = {
  /** List policies expiring within `withinDays` days (default 60). */
  due: (withinDays = 60): Promise<RenewalDue[]> =>
    api.request<RenewalDue[]>(`/api/renewals/due?within_days=${withinDays}`),

  /** Create a renewal submission for a policy. */
  renew: (policyId: string, effectiveDate: string): Promise<RenewResult> =>
    api.request<RenewResult>(`/api/policies/${policyId}/renew`, {
      method: 'POST',
      body: JSON.stringify({ effective_date: effectiveDate }),
    }),
};
