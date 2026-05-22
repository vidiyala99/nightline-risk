/**
 * Typed API client for Phase 3 carrier-side claim endpoints.
 *
 * Sibling to lib/placement.ts and lib/policies.ts. Money values come back
 * as STRINGS — same JSON contract as the placement/policies endpoints;
 * parse only at render-time (formatLedgerMoney / formatClaimMoney from
 * claim-tokens.ts).
 *
 * Error shapes mirror policies: 4xx returns { detail } where detail is
 * either a string (ClaimsError) or a structured object { error, message }
 * for the typed cases (invalid_transition).
 *
 * The status/tone/icon/label maps live in claim-tokens.ts so the mobile
 * app can mirror them without duplicating the wire types.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

import type { ClaimStatus, PaymentType } from "@/lib/claim-tokens";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// ─── Wire types (match backend/app/api/v1/claims.py _to_dict shapes) ────

export interface Claim {
  id: string;
  policy_id: string;
  incident_id: string | null;
  proposal_id: string | null;
  carrier_claim_number: string | null;
  coverage_line: string;
  status: ClaimStatus;
  date_of_loss: string;                  // ISO date
  fnol_submitted_at: string;             // ISO datetime
  current_reserve: string;
  indemnity_paid_to_date: string;
  expense_paid_to_date: string;
  recoveries_to_date: string;
  final_indemnity: string | null;
  total_incurred: string | null;
  closed_at: string | null;
  reopened_at: string | null;
  reopen_count: number;
  adjuster_name: string | null;
  adjuster_email: string | null;
  defense_package_id: string | null;
  snapshot_hash: string;
}

export interface ClaimPayment {
  id: string;
  claim_id: string;
  payment_type: PaymentType;
  amount: string;
  paid_on: string;
  description: string;
  recorded_by: string;
  recorded_at: string;
}

export interface ReserveChange {
  id: string;
  claim_id: string;
  from_amount: string;
  to_amount: string;
  change_reason: string;
  received_from: string;
  received_at: string;
  recorded_by: string;
  recorded_at: string;
}

export interface ClaimDetail extends Claim {
  payments: ClaimPayment[];
  reserve_changes: ReserveChange[];
}

// ─── Request bodies ─────────────────────────────────────────────────────

export interface FileFnolBody {
  coverage_line: string;
  date_of_loss: string;                  // ISO date
  incident_id?: string | null;
  proposal_id?: string | null;
  defense_package_id?: string | null;
  carrier_claim_number?: string | null;
  adjuster_name?: string | null;
  adjuster_email?: string | null;
}

export interface RecordReserveBody {
  new_reserve: string;
  change_reason: string;
  received_from: string;
  received_at: string;                   // ISO datetime
}

export interface RecordPaymentBody {
  amount: string;
  payment_type: PaymentType;
  paid_on: string;
  description?: string;
}

export interface CloseClaimBody {
  disposition: "paid" | "denied" | "dropped";
  final_indemnity?: string | null;
}

export interface ReopenClaimBody {
  reason: string;
}

export interface AttachDefensePackageBody {
  defense_package_id: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────

/**
 * The plan keeps a typed error shim parallel to PlacementApiError so call
 * sites can branch on either name. Implementation reuses PlacementApiError
 * because both backends use the same {detail|error,message} envelope —
 * keeping a separate class would force every error sink to learn two
 * `instanceof` checks for zero gain.
 */
export type ClaimsApiError = PlacementApiError;
export const ClaimsApiError = PlacementApiError;

// ─── Fetch wrapper ──────────────────────────────────────────────────────

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

export const claimsApi = {
  fileFnol: (pid: string, body: FileFnolBody) =>
    call<Claim>(`/api/policies/${pid}/claims`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listClaims: (params: {
    status?: string;
    venue_id?: string;
    carrier_id?: string;
    open_only?: boolean;
  } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== false) q.set(k, String(v));
    }
    const qs = q.toString();
    return call<Claim[]>(`/api/claims${qs ? `?${qs}` : ""}`);
  },

  claimsForPolicy: (pid: string, params: { status?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return call<Claim[]>(
      `/api/policies/${pid}/claims${qs ? `?${qs}` : ""}`,
    );
  },

  claimDetail: (cid: string) => call<ClaimDetail>(`/api/claims/${cid}`),

  recordCarrierReserve: (cid: string, body: RecordReserveBody) =>
    call<Claim>(`/api/claims/${cid}/carrier-reserve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  reserveHistory: (cid: string) =>
    call<ReserveChange[]>(`/api/claims/${cid}/reserve-history`),

  recordPayment: (cid: string, body: RecordPaymentBody) =>
    call<ClaimPayment>(`/api/claims/${cid}/payments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  paymentsForClaim: (cid: string) =>
    call<ClaimPayment[]>(`/api/claims/${cid}/payments`),

  closeClaim: (cid: string, body: CloseClaimBody) =>
    call<Claim>(`/api/claims/${cid}/close`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  reopenClaim: (cid: string, body: ReopenClaimBody) =>
    call<Claim>(`/api/claims/${cid}/reopen`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  attachDefensePackage: (cid: string, body: AttachDefensePackageBody) =>
    call<Claim>(`/api/claims/${cid}/defense-package`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

// ─── Derived helpers ────────────────────────────────────────────────────

/** Sum of paid totals minus recoveries — matches backend close_claim. */
export function totalIncurredFromClaim(c: Claim): number {
  const ind = parseFloat(c.indemnity_paid_to_date) || 0;
  const exp = parseFloat(c.expense_paid_to_date) || 0;
  const rec = parseFloat(c.recoveries_to_date) || 0;
  return ind + exp - rec;
}

/** Sum of indemnity + expense — used in the policy detail's claims table. */
export function totalPaidFromClaim(c: Claim): number {
  const ind = parseFloat(c.indemnity_paid_to_date) || 0;
  const exp = parseFloat(c.expense_paid_to_date) || 0;
  return ind + exp;
}
