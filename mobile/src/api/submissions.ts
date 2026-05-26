/**
 * Mobile typed API client for Phase 1 placement (submissions + quotes).
 *
 * MIRROR OF frontend/src/lib/placement.ts — same wire shapes, same call
 * signatures. Routed through the existing `api.request` helper in
 * client.ts, so auth + JSON envelope handling is shared.
 *
 * Money values inside premium_breakdown / requested_limits come back as
 * STRINGS — parse only at render time via formatLedgerMoney
 * (claim-tokens.ts). Keep this file in sync with the web mirror.
 */
import { api } from './client';
import { Colors } from '../theme/colors';

// ─── Wire types (match backend/app/api/v1/placement.py) ──────────────────

export type SubmissionStatus =
  | 'open'
  | 'in_market'
  | 'quoting'
  | 'bound'
  | 'lost'
  | 'declined'
  | 'withdrawn';

export type QuoteStatus =
  | 'requested'
  | 'pending'
  | 'quoted'
  | 'declined'
  | 'expired'
  | 'bound'
  | 'withdrawn';

export interface RequestedLimitsLine {
  per_occurrence?: string;
  aggregate?: string | null;
  deductible?: string;
}

export interface Submission {
  id: string;
  venue_id: string;
  assigned_producer_id: string | null;
  status: SubmissionStatus;
  effective_date: string;
  coverage_lines: string[];
  requested_limits: Record<string, RequestedLimitsLine>;
  prior_policy_id: string | null;
  notes: string;
  submitted_at: string | null;
  bound_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PremiumBreakdownLine {
  base?: string;
  tier_multiplier?: string;
  line_multiplier?: string;
  loss_adjustment?: string;
  premium: string;
  per_occurrence_limit?: string;
  aggregate_limit?: string | null;
  deductible?: string;
}

export interface PremiumBreakdown {
  carrier_id?: string;
  venue_id?: string;
  tier?: string;
  market_type?: string;
  lines: Record<string, PremiumBreakdownLine>;
  fees: { policy_fee: string; surplus_lines_tax: string };
  subtotal: string;
  total: string;
  commission_rate: string;
  commission_amount?: string;
}

export interface CarrierQuote {
  id: string;
  submission_id: string;
  carrier_id: string;
  status: QuoteStatus;
  is_selected: boolean;
  requested_at: string;
  responded_at: string | null;
  expires_at: string | null;
  decline_reason: string | null;
  premium_breakdown: PremiumBreakdown | Record<string, never>;
  coverage_terms: Record<string, unknown>;
  underwriter_name: string | null;
}

export interface SubmissionDetail extends Submission {
  quotes: CarrierQuote[];
}

export interface RejectedCarrier {
  carrier_id: string;
  reasons: string[];
}

export interface SubmitToMarketResult {
  submission: Submission;
  quotes_created: CarrierQuote[];
  rejected_carriers: RejectedCarrier[];
}

export interface Carrier {
  id: string;
  name: string;
  market_type: 'admitted' | 'e&s';
  naic_code: string | null;
  appetite: {
    venue_types?: string[];
    max_capacity?: number;
    coverage_lines?: string[];
  };
  am_best_rating: string | null;
  contact_email: string | null;
}

// ─── Status label + color maps ───────────────────────────────────────────

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  open: 'Open',
  in_market: 'In market',
  quoting: 'Quoting',
  bound: 'Bound',
  lost: 'Lost',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
};

export const SUBMISSION_STATUS_COLOR: Record<SubmissionStatus, string> = {
  open: Colors.textSecondary,
  in_market: Colors.info,
  quoting: Colors.info,
  bound: Colors.success,
  lost: Colors.error,
  declined: Colors.warning,
  withdrawn: Colors.textMuted,
};

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  requested: 'Requested',
  pending: 'Pending',
  quoted: 'Quoted',
  declined: 'Declined',
  expired: 'Expired',
  bound: 'Bound',
  withdrawn: 'Withdrawn',
};

export const QUOTE_STATUS_COLOR: Record<QuoteStatus, string> = {
  requested: Colors.textSecondary,
  pending: Colors.textSecondary,
  quoted: Colors.accentInk,
  declined: Colors.error,
  expired: Colors.textMuted,
  bound: Colors.success,
  withdrawn: Colors.textMuted,
};

// ─── Endpoints ────────────────────────────────────────────────────────────

export const submissionsApi = {
  list: (params: { status?: string; venue_id?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return api.request<Submission[]>(`/api/submissions${qs ? `?${qs}` : ''}`);
  },

  get: (sid: string) => api.request<SubmissionDetail>(`/api/submissions/${sid}`),

  submitToMarket: (
    sid: string,
    body: { target_carriers: string[]; allow_out_of_appetite?: boolean },
  ) =>
    api.request<SubmitToMarketResult>(`/api/submissions/${sid}/submit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  withdraw: (sid: string, reason: string) =>
    api.request<Submission>(`/api/submissions/${sid}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** Indicative premium from the broker pricing engine (does not persist). */
  buildIndicative: (qid: string) =>
    api.request<PremiumBreakdown>(`/api/quotes/${qid}/build-indicative`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  recordResponse: (
    qid: string,
    body: {
      status: 'quoted' | 'declined' | 'expired' | 'withdrawn';
      premium_breakdown?: PremiumBreakdown;
      coverage_terms?: Record<string, unknown>;
      decline_reason?: string;
      expires_at?: string;
      underwriter_name?: string;
    },
  ) =>
    api.request<CarrierQuote>(`/api/quotes/${qid}/record-response`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  selectQuote: (qid: string) =>
    api.request<CarrierQuote>(`/api/quotes/${qid}/select`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  listCarriers: () => api.request<Carrier[]>('/api/carriers'),
};

/** Render a rate string like "0.15" as "15.0%". */
export function formatRatePct(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
