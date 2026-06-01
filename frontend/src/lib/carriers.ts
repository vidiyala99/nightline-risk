/**
 * Typed client for carrier detail (GET /api/carriers/{cid}) — identity,
 * appetite, and the book placed with the carrier. Money values are STRINGS.
 */
import { authHeaders } from "@/lib/authFetch";
import { PlacementApiError } from "@/lib/placement";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface CarrierBook {
  policy_count: number;
  written_premium: string;
  earned_premium: string;
  commission: string;
  incurred_losses: string;
  loss_ratio: string | null;
}

export interface CarrierPolicyRow {
  policy_id: string;
  policy_number: string | null;
  venue_id: string;
  status: string;
  annual_premium: string;
  effective_date: string;
  expiration_date: string;
}

export interface CarrierAppetite {
  venue_types?: string[];
  max_capacity?: number | null;
  coverage_lines?: string[];
}

export interface CarrierDetail {
  id: string;
  name: string;
  market_type: string;
  naic_code: string | null;
  am_best_rating: string | null;
  contact_email: string | null;
  appetite: CarrierAppetite | null;
  book: CarrierBook;
  policies: CarrierPolicyRow[];
}

export async function fetchCarrierDetail(cid: string): Promise<CarrierDetail> {
  const res = await fetch(`${API_URL}/api/carriers/${cid}`, { headers: authHeaders() });
  if (!res.ok) {
    throw new PlacementApiError(res.status, "Couldn't load carrier.");
  }
  return res.json();
}
