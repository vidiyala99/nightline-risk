/**
 * Typed client for the per-venue loss run (GET /api/venues/{id}/loss-run)
 * and its CSV export. Money values are STRINGS; parse at render-time.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface LossRunClaim {
  claim_id: string;
  carrier_claim_number: string | null;
  policy_id: string;
  policy_number: string | null;
  carrier_id: string;
  carrier_name: string;
  incident_id: string | null;
  coverage_line: string;
  status: string;
  date_of_loss: string | null;
  fnol_submitted_at: string | null;
  closed_at: string | null;
  current_reserve: string;
  indemnity_paid: string;
  expense_paid: string;
  recoveries: string;
  total_incurred: string;
}

export interface CoverageLineLoss {
  coverage_line: string;
  claim_count: number;
  reserve: string;
  paid: string;
  incurred: string;
}

export interface LossRunSummary {
  claim_count: number;
  open_count: number;
  total_reserve: string;
  total_paid: string;
  total_recoveries: string;
  total_incurred: string;
}

export interface LossRun {
  venue_id: string;
  claims: LossRunClaim[];
  by_coverage_line: CoverageLineLoss[];
  summary: LossRunSummary;
}

export async function fetchLossRun(venueId: string): Promise<LossRun> {
  const res = await fetch(`${API_URL}/api/venues/${venueId}/loss-run`, { headers: authHeaders() });
  if (!res.ok) {
    throw new PlacementApiError(res.status, "Couldn't load the loss run.");
  }
  return res.json();
}

/** Fetch the CSV (auth-gated) and trigger a browser download. A plain <a href>
 * can't send the auth header, so fetch the blob and download client-side
 * (same pattern as downloadDefensePackagePdf). */
export async function downloadLossRunCsv(venueId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/venues/${venueId}/loss-run.csv`, { headers: authHeaders() });
  if (!res.ok) {
    throw new PlacementApiError(res.status, "Failed to download the loss run.");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `loss-run-${venueId}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
