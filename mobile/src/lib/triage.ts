/**
 * Broker "Book" triage classification — mirrors the web logic in
 * frontend/src/app/dashboard/page.tsx (classifyVenue / daysUntil) so a venue
 * lands in the same bucket on both platforms.
 */

export type Bucket = 'tonight' | 'watchlist' | 'standing';

export interface TriageVenue {
  tier: string;
  total_score: number;
  open_incidents: number;
  compliance_actions: number;
  has_degraded_infra: boolean;
  capacity: number;
  current_capacity: number | null;
  renewal_date?: string;
}

export const BUCKET_ORDER: Bucket[] = ['tonight', 'watchlist', 'standing'];

export const BUCKET_LABEL: Record<Bucket, string> = {
  tonight: 'Tonight',
  watchlist: 'Watchlist',
  standing: 'Standing',
};

export function classifyVenue(v: TriageVenue): Bucket {
  const capPct = v.current_capacity != null && v.capacity > 0 ? v.current_capacity / v.capacity : 0;
  const acute =
    v.open_incidents > 0 ||
    v.has_degraded_infra ||
    capPct >= 0.9 ||
    v.compliance_actions > 0;
  if (acute) return 'tonight';
  if (v.tier === 'C' || v.tier === 'D') return 'watchlist';
  return 'standing';
}

export function daysUntil(dateStr?: string): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}
