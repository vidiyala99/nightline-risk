import { api } from "./client";

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

/** Mirrors the web lib + backend compute_onboarding_complete: shoppable once the
 * operator answered the insurance question and picked >=1 coverage line. */
export function isProfileComplete(v: ProfileShape): boolean {
  return Boolean(v.current_carrier) && (v.coverage_interest?.length ?? 0) >= 1;
}

export async function fetchCoverageLines(): Promise<CoverageLine[]> {
  try {
    return await api.request<CoverageLine[]>("/api/coverage-lines");
  } catch {
    return [];
  }
}

export async function fetchVenueProfile(venueId: string): Promise<Record<string, unknown>> {
  return api.request<Record<string, unknown>>(`/api/venues/${venueId}`);
}

export async function saveCoverageProfile(
  venueId: string,
  body: { current_carrier: string; renewal_date?: string | null; coverage_interest: string[] },
): Promise<void> {
  await api.request(`/api/venues/${venueId}`, { method: "PATCH", body: JSON.stringify(body) });
}
