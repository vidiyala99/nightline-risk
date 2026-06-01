/**
 * Mobile typed client for carrier detail (GET /api/carriers/{cid}).
 *
 * MIRROR OF frontend/src/lib/carriers.ts — same wire shapes: identity,
 * appetite, the book placed with the carrier, and in-force policies. Money
 * values are STRINGS; loss_ratio is a 4-dp string ("0.4200") or null. Routed
 * through api.request (client.ts) for shared auth.
 */
import { api } from './client';

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

export const carriersApi = {
  detail: (cid: string) => api.request<CarrierDetail>(`/api/carriers/${cid}`),
};
