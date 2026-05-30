import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface CoverageLine {
  id: string;
  name: string;
  description: string;
  is_required_by_default: boolean;
}

export interface ProfileShape {
  current_carrier: string | null;
  coverage_interest: string[] | null;
}

/** A venue is shoppable once the operator has answered the insurance question
 * (a real carrier name OR the "uninsured"/"unsure" sentinels) and picked at
 * least one coverage line. Mirrors the backend's compute_onboarding_complete. */
export function isProfileComplete(v: ProfileShape): boolean {
  return Boolean(v.current_carrier) && (v.coverage_interest?.length ?? 0) >= 1;
}

export async function fetchCoverageLines(): Promise<CoverageLine[]> {
  const r = await fetch(`${API_URL}/api/coverage-lines`);
  return r.ok ? r.json() : [];
}

export async function saveCoverageProfile(
  venueId: string,
  body: { current_carrier: string; renewal_date?: string | null; coverage_interest: string[] },
): Promise<Response> {
  return fetch(`${API_URL}/api/venues/${venueId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}
