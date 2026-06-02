/**
 * Carrier underwriting desk — mobile API + helpers (Phase 1 carrier persona).
 * Mirrors the web `src/lib/underwriting.ts` and the backend endpoints:
 *   GET  /api/underwriting/queue
 *   POST /api/quotes/{qid}/underwrite
 * Money arrives as STRINGS (broker-platform JSON convention).
 */
import { API_URL, api, getToken } from './client';

export type Tier = 'A' | 'B' | 'C' | 'D';

export interface SuggestedLine {
  base: string;
  premium: string;
  per_occurrence_limit?: string;
  aggregate_limit?: string | null;
  deductible?: string;
}

export interface SuggestedBreakdown {
  carrier_id: string;
  venue_id: string;
  tier: string;
  market_type: string;
  lines: Record<string, SuggestedLine>;
  fees: { policy_fee: string; surplus_lines_tax: string };
  subtotal: string;
  total: string;
  commission_rate: string;
  commission_amount: string;
}

export interface QueueRow {
  quote_id: string;
  submission_id: string;
  carrier_id: string;
  venue_id: string | null;
  venue_name: string;
  risk: { tier: Tier; total_score: number };
  coverage_lines: string[];
  requested_limits: Record<string, Record<string, string>>;
  effective_date: string | null;
  status: string;
  suggested_premium_breakdown: SuggestedBreakdown | null;
}

export interface UnderwriteResult {
  quote_id: string;
  status: string;
  premium_breakdown: SuggestedBreakdown | null;
  decline_reason: string | null;
}

export async function fetchUnderwritingQueue(): Promise<QueueRow[]> {
  return api.request<QueueRow[]>('/api/underwriting/queue');
}

/** Render the carrier's decision; throws with the server's message on failure. */
export async function underwriteQuote(
  qid: string,
  payload:
    | { decision: 'quote'; premium_breakdown: SuggestedBreakdown }
    | { decision: 'decline'; decline_reason: string },
): Promise<UnderwriteResult> {
  const token = await getToken();
  const res = await fetch(`${API_URL}/api/quotes/${qid}/underwrite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      const detail = body?.detail;
      message = typeof detail === 'string' ? detail : detail?.message ?? message;
    } catch {
      // non-JSON error body — keep the status message
    }
    throw new Error(message);
  }
  return res.json();
}

const LINE_LABELS: Record<string, string> = {
  gl: 'General Liability',
  liquor: 'Liquor Liability',
  assault_battery: 'Assault & Battery',
  epli: 'EPLI',
  property: 'Property',
  umbrella: 'Umbrella',
  cyber: 'Cyber',
};

export function lineLabel(id: string): string {
  return LINE_LABELS[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function fmtMoney(value: string | number | null | undefined, cents = false): string {
  if (value == null || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

const toCents = (s: string | number | null | undefined): number => Math.round(Number(s ?? 0) * 100);
const fromCents = (c: number): string => (c / 100).toFixed(2);

/** Rescale so total === targetTotal, keeping fees fixed and distributing the
 *  change proportionally across line premiums (integer-cents, residual on the
 *  last line). Guarantees the backend sum-check passes. Null if target ≤ fees. */
export function rescaleBreakdownToTotal(
  breakdown: SuggestedBreakdown,
  targetTotal: number,
): SuggestedBreakdown | null {
  const feeCents = toCents(breakdown.fees?.policy_fee) + toCents(breakdown.fees?.surplus_lines_tax);
  const targetLinesCents = Math.round(targetTotal * 100) - feeCents;
  if (targetLinesCents <= 0) return null;

  const entries = Object.entries(breakdown.lines);
  const oldLineCents = entries.map(([, l]) => toCents(l.premium));
  const oldLinesSum = oldLineCents.reduce((a, b) => a + b, 0);
  if (oldLinesSum <= 0) return null;

  let allocated = 0;
  const newLines: Record<string, SuggestedLine> = {};
  entries.forEach(([id, line], i) => {
    const cents =
      i === entries.length - 1
        ? targetLinesCents - allocated
        : Math.round((oldLineCents[i] * targetLinesCents) / oldLinesSum);
    if (i !== entries.length - 1) allocated += cents;
    newLines[id] = { ...line, premium: fromCents(cents) };
  });

  const policyFeeCents = toCents(breakdown.fees?.policy_fee);
  const commissionRate = Number(breakdown.commission_rate ?? 0);
  const commissionCents = Math.round((targetLinesCents + policyFeeCents) * commissionRate);

  return {
    ...breakdown,
    lines: newLines,
    subtotal: fromCents(targetLinesCents),
    total: fromCents(targetLinesCents + feeCents),
    commission_amount: fromCents(commissionCents),
  };
}
