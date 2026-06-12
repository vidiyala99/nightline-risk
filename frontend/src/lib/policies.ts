/**
 * Typed API client for Phase 2 policy lifecycle endpoints.
 *
 * Sibling to lib/placement.ts. Money values come back as STRINGS — same
 * JSON contract as the placement endpoints; parse only at render-time.
 *
 * Error shapes mirror placement: 4xx returns { detail } where detail is
 * either a string (PoliciesError) or a structured object
 * { error, message } for the typed cases (quote_not_bindable,
 * invalid_transition).
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

// ─── Types ────────────────────────────────────────────────────────────────

export type PolicyStatus =
  | "bound_pending_number"
  | "active"
  | "cancelled"
  | "non_renewed"
  | "lapsed"
  | "expired";

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
  cancellation_method: string | null;
  refund_amount: string | null;
  bound_at: string;
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
  status: "active" | "superseded" | "cancelled";
  issued_at: string;
  expires_on: string;
  pdf_path: string | null;
  issued_by: string;
}

export interface PolicyDetail extends Policy {
  endorsements: Endorsement[];
  certificates: CertificateOfInsurance[];
}

// ─── Coverage-gap remediation (backs /policies/[pid]/gaps) ───────────────

export interface CoverageGapLine {
  id: string;
  name: string;
  limit: string | null;
}

export interface CoverageGap {
  id: string;
  name: string;
  severity: string;
  reason: string;
  recommended_limit: string | null;
  endorse_href: string;
}

export interface CoverageGapReport {
  policy_id: string;
  venue_id: string;
  status: string;
  covered: CoverageGapLine[];
  gaps: CoverageGap[];
  summary: { gap_count: number; highest_severity: string | null };
}

// ─── Fetch wrapper (mirrors placement.ts) ────────────────────────────────

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

// ─── Endpoints ───────────────────────────────────────────────────────────

export const policiesApi = {
  bindQuote: (qid: string, body: {
    policy_number?: string;
    effective_date?: string;
    term_length_days?: number;
  } = {}) => call<Policy>(`/api/quotes/${qid}/bind`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listPolicies: (params: {
    status?: string;
    venue_id?: string;
    carrier_id?: string;
  } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) q.set(k, String(v));
    }
    const qs = q.toString();
    return call<Policy[]>(`/api/policies${qs ? `?${qs}` : ""}`);
  },

  getPolicy: (pid: string) => call<PolicyDetail>(`/api/policies/${pid}`),

  getCoverageGaps: (pid: string) =>
    call<CoverageGapReport>(`/api/policies/${pid}/coverage-gaps`),

  assignPolicyNumber: (pid: string, policy_number: string) =>
    call<Policy>(`/api/policies/${pid}/policy-number`, {
      method: "PATCH",
      body: JSON.stringify({ policy_number }),
    }),

  cancelPolicy: (pid: string, body: {
    reason: string;
    method: "pro_rata" | "short_rate";
    cancellation_date: string;
  }) => call<Policy>(`/api/policies/${pid}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  // End-of-life transitions. expire/reinstate take no reason; non-renew and
  // lapse record one for the audit trail. Each maps to its own backend route.
  expirePolicy: (pid: string, reason = "") =>
    call<Policy>(`/api/policies/${pid}/expire`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  nonRenewPolicy: (pid: string, reason: string) =>
    call<Policy>(`/api/policies/${pid}/non-renew`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  lapsePolicy: (pid: string, reason: string) =>
    call<Policy>(`/api/policies/${pid}/lapse`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  reinstatePolicy: (pid: string, reason = "") =>
    call<Policy>(`/api/policies/${pid}/reinstate`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  issueEndorsement: (pid: string, body: {
    endorsement_type: string;
    effective_date: string;
    terms_diff: Record<string, unknown>;
    premium_change?: string;
    tax_change?: string;
    description?: string;
  }) => call<Endorsement>(`/api/policies/${pid}/endorsements`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listEndorsements: (pid: string) =>
    call<Endorsement[]>(`/api/policies/${pid}/endorsements`),

  issueCertificate: (pid: string, body: {
    certificate_holder: string;
    certificate_holder_address: string;
    description_of_operations: string;
    expires_on: string;
    additional_insured?: boolean;
    additional_insured_scope?: string | null;
  }) => call<CertificateOfInsurance>(`/api/policies/${pid}/certificates`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  listCertificates: (pid: string, include: "active" | "superseded" | "all" = "active") => {
    const q = include === "active" ? "" : `?include=${include}`;
    return call<CertificateOfInsurance[]>(`/api/policies/${pid}/certificates${q}`);
  },
};

// ─── Display helpers ─────────────────────────────────────────────────────

export const POLICY_STATUS_LABEL: Record<PolicyStatus, string> = {
  bound_pending_number: "Bound · Awaiting #",
  active: "Active",
  cancelled: "Cancelled",
  non_renewed: "Non-Renewed",
  lapsed: "Lapsed",
  expired: "Expired",
};

export const POLICY_STATUS_TONE: Record<
  PolicyStatus,
  "neutral" | "info" | "success" | "warning" | "danger"
> = {
  bound_pending_number: "info",
  active: "success",
  cancelled: "danger",
  non_renewed: "warning",
  lapsed: "warning",
  expired: "neutral",
};

export const ENDORSEMENT_TYPE_LABEL: Record<string, string> = {
  change_limit: "Change Limit",
  add_insured: "Add Insured",
  add_coverage: "Add Coverage",
  remove_coverage: "Remove Coverage",
  add_location: "Add Location",
  change_class: "Change Class",
  cancellation: "Cancellation",
  correction: "Correction",
};

/** Download a certificate of insurance as a PDF. The endpoint is broker-gated,
 *  so (like the defense-package download) we fetch the blob with authHeaders()
 *  rather than a plain <a href>, then trigger a client-side download. */
export async function downloadCoiPdf(coiId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/certificates/${coiId}/pdf`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new PlacementApiError(res.status, "Failed to download certificate PDF");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `coi-${coiId}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
