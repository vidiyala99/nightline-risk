import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface Citation {
  source_id: string;
  source_type: string;
  excerpt: string;
  doc_id?: string | null;
  node_id?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  path?: string | null;
  clause_id?: string | null;
}

export interface Finding {
  id: string;
  persona: string;
  kind: string;
  subject: { entity_type: string; entity_id: string; label: string; href: string };
  severity: "critical" | "high" | "medium" | "low";
  severity_rank: number;
  why: Citation[];
  recommended_action: { label: string; href: string };
  prediction: { claim: string; falsifiable_by: string; horizon: string };
  venue_id: string | null;
}

export interface ExposureResponse {
  persona: string;
  findings: Finding[];
}

export class IntelligenceApiError extends Error {}

export async function fetchExposure(): Promise<ExposureResponse> {
  const res = await fetch(`${API_URL}/api/intelligence/exposure`, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    throw new IntelligenceApiError(`exposure fetch failed: ${res.status}`);
  }
  return (await res.json()) as ExposureResponse;
}

// ─── Coverage advice (E&O documentation trail) ───────────────────────────

export interface CoverageAdvice {
  id: string;
  venue_id: string;
  policy_id: string;
  kind: string;
  loss_category: string | null;
  cited_node_ids: string[];
  summary: string;
  status: string;
  actor_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordAdvicePayload {
  venue_id: string;
  policy_id: string;
  kind: string;
  summary: string;
  cited_node_ids: string[];
  loss_category?: string | null;
}

// Which coverage findings can be acknowledged, and the advice `kind` each maps to.
const FINDING_KIND_TO_ADVICE_KIND: Record<string, string> = {
  coverage_exclusion_review: "exclusion_review",
  coverage_gap_eo: "gap",
};

/** Derive the advice payload a finding would record, or null if the finding
 *  isn't an acknowledgeable coverage finding (wrong kind / not policy-subject). */
export function findingToAdvicePayload(f: Finding): RecordAdvicePayload | null {
  const kind = FINDING_KIND_TO_ADVICE_KIND[f.kind];
  if (!kind) return null;
  if (f.subject.entity_type !== "policy" || !f.venue_id) return null;
  return {
    venue_id: f.venue_id,
    policy_id: f.subject.entity_id,
    kind,
    summary: f.prediction?.claim || f.why[0]?.excerpt || f.recommended_action.label,
    cited_node_ids: f.why.map((c) => c.node_id).filter((n): n is string => !!n),
  };
}

export async function recordCoverageAdvice(payload: RecordAdvicePayload): Promise<CoverageAdvice> {
  const res = await fetch(`${API_URL}/api/coverage-advice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new IntelligenceApiError(`coverage-advice failed: ${res.status}`);
  }
  return (await res.json()) as CoverageAdvice;
}
