/**
 * Mobile typed client for the broker Book financials rollup.
 *
 * MIRROR OF frontend/src/lib/book.ts — same wire shapes. Money values are
 * STRINGS; loss_ratio is a 4-dp string ("0.4200") or null when no premium is
 * earned. Routed through api.request (client.ts) for shared auth.
 */
import { api } from './client';

export interface CoverageLineFinancials {
  coverage_line: string;
  written_premium: string;
  earned_premium: string;
  incurred_losses: string;
  loss_ratio: string | null;
}

export interface CarrierFinancials {
  carrier_id: string;
  carrier_name: string;
  policy_count: number;
  written_premium: string;
  commission: string;
  incurred_losses: string;
  loss_ratio: string | null;
}

export interface BookFinancials {
  written_premium: string;
  earned_premium: string;
  commission_revenue: string;
  incurred_losses: string;
  loss_ratio: string | null;
  policy_count: number;
  open_claim_count: number;
  by_coverage_line: CoverageLineFinancials[];
  by_carrier: CarrierFinancials[];
}

export const bookApi = {
  financials: () => api.request<BookFinancials>('/api/book/financials'),
};

// ─── Render helpers ─────────────────────────────────────────────────────────

/** Compact USD from a money string, e.g. "1234567.00" → "$1,234,567". */
export function fmtUsd(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

/** Loss-ratio string ("0.4200") → "42.0%", or "—" when null. */
export function fmtLossRatio(value: string | null | undefined): string {
  if (value == null) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

export type LossBand = 'healthy' | 'watch' | 'high' | 'none';

/** Underwriting-standard loss-ratio bands. Lower is better: <60% healthy,
 * 60–80% watch, >80% high. Null = no earned premium yet. */
export function lossBand(value: string | null | undefined): LossBand {
  if (value == null) return 'none';
  const n = Number(value);
  if (Number.isNaN(n)) return 'none';
  if (n < 0.6) return 'healthy';
  if (n <= 0.8) return 'watch';
  return 'high';
}
