/**
 * Typed API client for operator→broker PolicyRequest endpoints (Tier 1 #1).
 *
 * Sibling to lib/renewals.ts — same call<T> wrapper, authHeaders, and
 * PlacementApiError. Money values inside `payload` (if any) follow the JSON
 * contract: strings on the wire, parsed only at render time.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// ─── Wire types ───────────────────────────────────────────────────────────

export type PolicyRequestType =
  | "renewal"
  | "cancellation"
  | "coi"
  | "coverage_change";

export type PolicyRequestStatus = "pending" | "approved" | "declined" | "cancelled";

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
  result_entity_type?: "submission" | "certificate" | "policy" | null;
  result_entity_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Subset of the policy shape the coverage view needs (GET /venues/{id}/policies). */
export interface CoveragePolicy {
  id: string;
  policy_number: string | null;
  venue_id: string;
  carrier_id: string;
  status: string;
  effective_date: string;
  expiration_date: string;
  annual_premium: string;     // Decimal as string
  coverage_lines: string[];
}

export const REQUEST_TYPE_LABEL: Record<PolicyRequestType, string> = {
  renewal: "Renewal",
  cancellation: "Cancellation",
  coi: "Certificate of insurance",
  coverage_change: "Coverage change",
};

export const REQUEST_STATUS_TONE: Record<
  PolicyRequestStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  pending: "warning",
  approved: "success",
  declined: "danger",
  cancelled: "neutral",
};

export const REQUEST_STATUS_LABEL: Record<PolicyRequestStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Withdrawn",
};

// ─── Fetch wrapper (mirrors renewals.ts call<T>) ──────────────────────────

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
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
  return (await res.json()) as T;
}

// ─── Endpoints ──────────────────────────────────────────────────────────

export interface CreatePolicyRequestBody {
  request_type: PolicyRequestType;
  note?: string;
  payload?: Record<string, unknown>;
}

export const policyRequestsApi = {
  /** Operator's read-only coverage for a venue (tenant-gated). */
  coverageForVenue: (venueId: string): Promise<CoveragePolicy[]> =>
    call<CoveragePolicy[]>(`/api/venues/${venueId}/policies`),

  /** Operator raises a request against a policy. */
  create: (policyId: string, body: CreatePolicyRequestBody): Promise<PolicyRequest> =>
    call<PolicyRequest>(`/api/policies/${policyId}/requests`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Cross-venue list (broker queue). Optional filters scope server-side. */
  list: (params: { venue_id?: string; policy_id?: string; status?: string } = {}): Promise<PolicyRequest[]> => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v) q.set(k, v);
    }
    const qs = q.toString();
    return call<PolicyRequest[]>(`/api/policy-requests${qs ? `?${qs}` : ""}`);
  },

  /** Requests against a single policy (tenant-gated). */
  listForPolicy: (policyId: string): Promise<PolicyRequest[]> =>
    call<PolicyRequest[]>(`/api/policies/${policyId}/requests`),

  /** Broker approves or declines a pending request. */
  decide: (
    requestId: string,
    decision: "approved" | "declined",
    decisionNote?: string,
  ): Promise<PolicyRequest> =>
    call<PolicyRequest>(`/api/policy-requests/${requestId}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision, decision_note: decisionNote ?? null }),
    }),

  /** Operator withdraws their own pending request. */
  cancel: (requestId: string): Promise<PolicyRequest> =>
    call<PolicyRequest>(`/api/policy-requests/${requestId}/cancel`, { method: "POST" }),
};
