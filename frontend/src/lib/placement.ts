/**
 * Typed API client for the Phase 1 placement endpoints.
 *
 * Backend contract (see backend/app/api/v1/placement.py):
 *   - All endpoints under /api except /api/submissions/transitions are
 *     broker/admin gated. Pass authHeaders() on every call.
 *   - Money values inside JSON columns (premium_breakdown, requested_limits)
 *     come back as STRINGS. Treat them as strings on the wire and parse
 *     only at render-time (formatCurrency) so precision doesn't leak.
 *   - Error responses on 4xx have shape { detail: string | object }.
 *     422 (premium math mismatch, out of appetite) returns a structured
 *     object: { error: "<code>", message: "..." }.
 */
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// ─── Types ────────────────────────────────────────────────────────────────

export type SubmissionStatus =
  | "open"
  | "in_market"
  | "quoting"
  | "bound"
  | "lost"
  | "declined"
  | "withdrawn";

export type QuoteStatus =
  | "requested"
  | "pending"
  | "quoted"
  | "declined"
  | "expired"
  | "bound"
  | "withdrawn"
  | "info_requested";

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
  effective_date: string;             // ISO date
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
  info_request_note: string | null;
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
  market_type: "admitted" | "e&s";
  naic_code: string | null;
  appetite: {
    venue_types?: string[];
    max_capacity?: number;
    coverage_lines?: string[];
  };
  am_best_rating: string | null;
  contact_email: string | null;
  rate_overrides?: {
    venue_multipliers: Record<string, string>;
    line_multipliers: Record<string, string>;
    policy_fee: string;
    commission_rate: string;
  };
}

// Transition matrix: { source_status: [allowed_target_status, ...] }
export type TransitionMatrix = Record<SubmissionStatus, SubmissionStatus[]>;

// ─── Error class ──────────────────────────────────────────────────────────

export class PlacementApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail: unknown = null,
  ) {
    super(message);
    this.name = "PlacementApiError";
  }

  /** True when the backend returned a structured 422 with an error code. */
  get structured(): { error: string; message: string } | null {
    if (this.status !== 422) return null;
    if (this.detail && typeof this.detail === "object" && "error" in this.detail) {
      return this.detail as { error: string; message: string };
    }
    return null;
  }
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────

async function call<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail: unknown = null;
    try {
      const body = await res.json();
      detail = body?.detail ?? body;
    } catch {
      detail = await res.text().catch(() => "");
    }
    const msg = typeof detail === "string"
      ? detail
      : (detail as { message?: string })?.message ?? `HTTP ${res.status}`;
    throw new PlacementApiError(res.status, msg, detail);
  }
  // 204 / empty body handling — placement endpoints always return JSON
  // on success today; if that changes, return cast undefined as T.
  return (await res.json()) as T;
}

// ─── Endpoints ───────────────────────────────────────────────────────────

export const placementApi = {
  // Submissions
  createSubmission: (body: {
    venue_id: string;
    effective_date: string;
    coverage_lines: string[];
    requested_limits?: Record<string, RequestedLimitsLine>;
    producer_id?: string | null;
    notes?: string;
  }) => call<Submission>("/api/submissions", {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listSubmissions: (params: {
    status?: string;                // comma-separated for multi
    producer_id?: string;
    venue_id?: string;
    days_in_market_min?: number;
  } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return call<Submission[]>(`/api/submissions${qs ? `?${qs}` : ""}`);
  },

  getSubmission: (sid: string) =>
    call<SubmissionDetail>(`/api/submissions/${sid}`),

  // Per-carrier appetite match for this submission — guides carrier selection.
  carrierAppetite: (sid: string) =>
    call<{ carrier_id: string; in_appetite: boolean; reasons: string[] }[]>(
      `/api/submissions/${sid}/carrier-appetite`,
    ),

  // Edit a draft submission's terms (server allows this only while 'open').
  updateSubmission: (sid: string, body: {
    effective_date?: string;
    coverage_lines?: string[];
    requested_limits?: Record<string, RequestedLimitsLine>;
    producer_id?: string | null;
    notes?: string;
  }) => call<Submission>(`/api/submissions/${sid}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  }),

  getTransitions: () =>
    call<TransitionMatrix>("/api/submissions/transitions"),

  submitToMarket: (sid: string, body: {
    target_carriers: string[];
    allow_out_of_appetite?: boolean;
  }) => call<SubmitToMarketResult>(`/api/submissions/${sid}/submit`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  withdrawSubmission: (sid: string, reason: string) =>
    call<Submission>(`/api/submissions/${sid}/withdraw`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // Terminal outcomes other than a broker withdrawal: the venue bound
  // elsewhere (lost, from 'quoting') or every carrier declined (declined,
  // from 'in_market'). Kept distinct from withdraw for win/loss reporting.
  declineSubmission: (sid: string, reason: string) =>
    call<Submission>(`/api/submissions/${sid}/decline`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  loseSubmission: (sid: string, reason: string) =>
    call<Submission>(`/api/submissions/${sid}/lose`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  // Quotes
  recordQuoteResponse: (qid: string, body: {
    status: "quoted" | "declined" | "expired" | "withdrawn";
    premium_breakdown?: PremiumBreakdown;
    coverage_terms?: Record<string, unknown>;
    decline_reason?: string;
    expires_at?: string;
    underwriter_name?: string;
  }) => call<CarrierQuote>(`/api/quotes/${qid}/record-response`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  selectQuote: (qid: string) =>
    call<CarrierQuote>(`/api/quotes/${qid}/select`, { method: "POST" }),

  buildIndicativeQuote: (qid: string) =>
    call<PremiumBreakdown>(`/api/quotes/${qid}/build-indicative`, {
      method: "POST",
    }),

  // Carriers
  listCarriers: () => call<Carrier[]>("/api/carriers"),
  getCarrier: (cid: string) => call<Carrier>(`/api/carriers/${cid}`),

  // ACORD-style previews
  acord125: (sid: string) =>
    call<Record<string, unknown>>(`/api/submissions/${sid}/acord/125`, {
      method: "POST",
    }),

  acord126: (sid: string) =>
    call<Record<string, unknown>>(`/api/submissions/${sid}/acord/126`, {
      method: "POST",
    }),
};

/**
 * Submissions-kanban terminal outcomes → distinct API method + display verb.
 * Data-driven so the dispatch can't silently swap (a lost marked as declined
 * would mis-report win/loss). Each method shares the `(sid, reason)` shape.
 */
export const SUBMISSION_OUTCOME_CONFIG = {
  lost: { verb: "Mark lost", method: "loseSubmission" },
  declined: { verb: "Mark declined", method: "declineSubmission" },
  withdrawn: { verb: "Withdraw", method: "withdrawSubmission" },
} as const;

// ─── Formatting helpers ──────────────────────────────────────────────────

/** Render a string-money value (from a JSON column) as "$1,234.56" with
 *  the venue's local currency conventions. Returns "—" for empty/invalid. */
export function formatCurrency(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/** Render a percentage rate like "0.15" as "15.0%". */
export function formatPct(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

/** Human-friendly status label for the kanban / detail views. */
export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  open: "Open",
  in_market: "In Market",
  quoting: "Quoting",
  bound: "Bound",
  lost: "Lost",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

/** Tier color mapping per status, consistent with the v3 design system. */
export const STATUS_TONE: Record<SubmissionStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  open: "neutral",
  in_market: "info",
  quoting: "info",
  bound: "success",
  lost: "danger",
  declined: "warning",
  withdrawn: "neutral",
};
