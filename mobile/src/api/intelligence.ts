// Risk Intelligence — deterministic "what needs your attention" exposure feed.
// Mirrors the web frontend/src/lib/intelligence.ts contract over the RN api client.
import { api } from './client';

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
  severity: 'critical' | 'high' | 'medium' | 'low';
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

export async function fetchExposure(): Promise<ExposureResponse> {
  return api.request<ExposureResponse>('/api/intelligence/exposure');
}
