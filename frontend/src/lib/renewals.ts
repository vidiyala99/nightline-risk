/**
 * Typed API client for Phase 4 renewals endpoints.
 *
 * Sibling to lib/claims.ts. Money values (annual_premium,
 * projected_loss_adjustment, prior_annual_premium, loss_adjustment) come back
 * as STRINGS — parse only at render-time.
 *
 * Error shapes mirror claims: 4xx returns { detail } where detail is either a
 * string or a structured object { error, message }.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// ─── Wire types (match backend/app/api/v1/renewals.py response shapes) ───

export interface RenewalDue {
  policy_id: string;
  policy_number: string | null;
  venue_id: string;
  expiration_date: string;              // ISO date
  annual_premium: string;              // Decimal as string
  loss_ratio: string;                  // Decimal as string
  claim_count: number;
  projected_loss_adjustment: string;   // Decimal as string
}

export interface RenewResult {
  submission: {
    id: string;
    venue_id: string;
    status: string;
    prior_policy_id: string;
    coverage_lines: string[];
    requested_limits: Record<string, unknown>;
    effective_date: string;            // ISO date
  };
  yoy_context: {
    prior_policy_id: string;
    prior_annual_premium: string;      // Decimal as string
    prior_coverage_lines: string[];
    loss_ratio: string;                // Decimal as string
    claim_count: number;
    loss_adjustment: string;           // Decimal as string
  };
}

// ─── Fetch wrapper (mirrors claims.ts call<T> exactly) ───────────────────

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

export const renewalsApi = {
  /** List policies expiring within `withinDays` days (default 60). */
  due: (withinDays = 60): Promise<RenewalDue[]> =>
    call<RenewalDue[]>(`/api/renewals/due?within_days=${withinDays}`),

  /** Create a renewal submission for a policy. */
  renew: (policyId: string, effectiveDate: string): Promise<RenewResult> =>
    call<RenewResult>(`/api/policies/${policyId}/renew`, {
      method: "POST",
      body: JSON.stringify({ effective_date: effectiveDate }),
    }),
};
