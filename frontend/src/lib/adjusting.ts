// Carrier adjuster desk — client types + API helpers (Phase 2 carrier persona).
//
// Mirrors the backend `app/api/v1/adjusting.py` queue payload and the
// claims-adjudication endpoints. Money arrives as STRINGS (broker-platform
// JSON convention) — format at the display boundary.
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type CoverageDecision = "covered" | "denied" | "reservation_of_rights";

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
  chain_ladder_mean?: string;
}

export async function fetchAdjusterQueue(): Promise<AdjusterQueueRow[]> {
  const r = await fetch(`${API_URL}/api/adjusting/queue`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Queue load failed (${r.status})`);
  return r.json();
}

export async function fetchAdjusterClaim(cid: string): Promise<any> {
  const r = await fetch(`${API_URL}/api/adjusting/claims/${cid}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Claim load failed (${r.status})`);
  return r.json();
}

async function post(path: string, body: unknown) {
  const r = await fetch(`${API_URL}/api/adjusting/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e?.detail?.message ?? e?.detail ?? `Request failed (${r.status})`);
  }
  return r.json();
}

export const decideCoverage = (cid: string, decision: CoverageDecision, rationale: string) =>
  post(`claims/${cid}/decide-coverage`, { decision, rationale });

export const adjustReserve = (cid: string, new_reserve: string, change_reason: string) =>
  post(`claims/${cid}/reserve`, { new_reserve, change_reason });

export const approvePayment = (
  cid: string,
  amount: string,
  payment_type: string,
  paid_on: string,
  description: string,
) => post(`claims/${cid}/payment`, { amount, payment_type, paid_on, description });

export const closeClaim = (cid: string, disposition: string, final_indemnity?: string) =>
  post(`claims/${cid}/close`, { disposition, final_indemnity });
