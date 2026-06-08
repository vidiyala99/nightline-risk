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
