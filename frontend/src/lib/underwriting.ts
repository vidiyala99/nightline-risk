// Carrier underwriting desk — client types + API helpers (Phase 1 carrier persona).
//
// Mirrors the backend `app/services/underwriting_desk.py` queue payload and the
// `POST /api/quotes/{qid}/underwrite` decision endpoint. Money arrives as
// STRINGS (broker-platform JSON convention) — format at the display boundary.
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type Tier = "A" | "B" | "C" | "D";

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

export async function fetchUnderwritingQueue(): Promise<QueueRow[]> {
  const res = await fetch(`${API_URL}/api/underwriting/queue`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Queue load failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export interface UnderwriteResult {
  quote_id: string;
  status: string;
  premium_breakdown: SuggestedBreakdown | null;
  decline_reason: string | null;
}

/** Render the carrier's decision. decision='quote' (premium_breakdown) or
 *  'decline' (decline_reason). Throws with the server's message on failure so
 *  the caller can show it below the form. */
export async function underwriteQuote(
  qid: string,
  payload:
    | { decision: "quote"; premium_breakdown: SuggestedBreakdown; coverage_terms?: CoverageTerms }
    | { decision: "decline"; decline_reason: string },
): Promise<UnderwriteResult> {
  const res = await fetch(`${API_URL}/api/quotes/${qid}/underwrite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : detail?.message ?? `Request failed (${res.status})`;
    throw new Error(message);
  }
  return res.json();
}

/** Coverage-line id → human label. Falls back to upper-casing the id. */
const LINE_LABELS: Record<string, string> = {
  gl: "General Liability",
  liquor: "Liquor Liability",
  assault_battery: "Assault & Battery",
  epli: "EPLI",
  property: "Property",
  umbrella: "Umbrella",
  cyber: "Cyber",
};

export function lineLabel(id: string): string {
  return LINE_LABELS[id] ?? id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const toCents = (s: string | number | null | undefined): number =>
  Math.round(Number(s ?? 0) * 100);
const fromCents = (c: number): string => (c / 100).toFixed(2);

/** Rescale a suggested breakdown so its stated total equals `targetTotal`,
 *  keeping fees fixed and distributing the change proportionally across line
 *  premiums. Guarantees the result passes the backend sum-check
 *  (total === Σlines + Σfees), so an underwriter can adjust the price without
 *  re-keying every line. Returns null if the target is below the fixed fees.
 *
 *  All arithmetic is in integer cents to avoid float drift; the rounding
 *  residual is absorbed by the last line so the sum is exact. */
export function rescaleBreakdownToTotal(
  breakdown: SuggestedBreakdown,
  targetTotal: number,
): SuggestedBreakdown | null {
  const feeCents =
    toCents(breakdown.fees?.policy_fee) + toCents(breakdown.fees?.surplus_lines_tax);
  const targetCents = Math.round(targetTotal * 100);
  const targetLinesCents = targetCents - feeCents;
  if (targetLinesCents <= 0) return null; // total can't be at/below fixed fees

  const entries = Object.entries(breakdown.lines);
  const oldLineCents = entries.map(([, l]) => toCents(l.premium));
  const oldLinesSum = oldLineCents.reduce((a, b) => a + b, 0);
  if (oldLinesSum <= 0) return null;

  let allocated = 0;
  const newLines: Record<string, SuggestedLine> = {};
  entries.forEach(([id, line], i) => {
    let cents: number;
    if (i === entries.length - 1) {
      cents = targetLinesCents - allocated; // last line absorbs the residual
    } else {
      cents = Math.round((oldLineCents[i] * targetLinesCents) / oldLinesSum);
      allocated += cents;
    }
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

/** Format a money string ("5894.84") as "$5,895" (whole dollars) or with cents. */
export function fmtMoney(value: string | number | null | undefined, cents = false): string {
  if (value == null || value === "") return "—";
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

// ---------------------------------------------------------------------------
// Dossier + structured coverage terms (carrier desk v2 — Task 7)
// ---------------------------------------------------------------------------

export interface RiskFactor { score: number; weight: number; explanation?: string }

export interface Subjectivity { text: string; status: "open" | "met" | "waived" }
export interface ScheduleMod { category: string; kind: "credit" | "debit"; pct: string }
export interface CoverageTerms {
  lines?: Record<string, { limit?: string; deductible?: string; sublimit?: string | null }>;
  subjectivities?: Subjectivity[];
  exclusions?: string[];
  endorsements?: string[];
  schedule_mods?: ScheduleMod[];
  valid_until?: string;
}

export interface Dossier {
  quote: {
    id: string;
    status: string;
    premium_breakdown: SuggestedBreakdown | null;
    coverage_terms: CoverageTerms;
    decline_reason: string | null;
    underwriter_name: string | null;
    info_request_note: string | null;
    info_response_note: string | null;
  };
  submission: {
    id: string | null;
    venue_id: string | null;
    effective_date: string | null;
    coverage_lines: string[];
    requested_limits: Record<string, Record<string, string>>;
    status: string | null;
  };
  venue: { id: string | null; name: string; venue_type: string };
  risk: { tier: Tier; total_score: number; factors: Record<string, RiskFactor> };
  loss_run: { summary: Record<string, string | number>; by_coverage_line: any[] } | null;
  incidents: { open_count: number; recent: { id: string; summary: string; occurred_at: string }[] };
  compliance: { status: string; open_items: { title: string; severity: string }[] };
  suggested_premium_breakdown: SuggestedBreakdown | null;
  decidable: boolean;
}

export async function fetchDossier(qid: string): Promise<Dossier> {
  const res = await fetch(`${API_URL}/api/underwriting/quotes/${qid}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Dossier load failed (${res.status})`);
  return res.json();
}

export async function requestInfo(qid: string, note: string): Promise<{ status: string }> {
  const res = await fetch(`${API_URL}/api/quotes/${qid}/request-info`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.detail?.message ?? e?.detail ?? `Request failed (${res.status})`);
  }
  return res.json();
}
