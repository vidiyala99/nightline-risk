/**
 * Pure, RN-free display/formatting helpers shared by screens. Kept dependency-
 * free so they're trivially unit-testable (see format.test.ts).
 */

export type FactorTier = 'good' | 'moderate' | 'poor';

/** Format a money string ("12000.00" | null) as rounded USD, or "—" for null. */
export function money(value: string | null): string {
  if (value == null) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Humanize an internal venue_type ("night_club" → "Night Club"). */
export function venueTypeLabel(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Bucket a 0-100 factor/risk score into a tier. */
export function getFactorTier(score: number): FactorTier {
  if (score >= 85) return 'good';
  if (score >= 65) return 'moderate';
  return 'poor';
}

/**
 * Reduce a risk-score `factors` payload to a flat number map.
 *
 * The backend returns each factor as a `{ score, weight }` object; some legacy
 * payloads send plain numbers. Always run this before tiering — `Number({score})`
 * is NaN, and getFactorTier(NaN) falls through to 'poor'/HIGH RISK, which is how
 * an un-normalized screen renders EVERY factor as high risk.
 */
export function normalizeFactors(
  raw: Record<string, unknown> | null | undefined,
): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = typeof v === 'object' && v !== null ? Number((v as any).score ?? 0) : Number(v);
  }
  return out;
}

/**
 * Glyph mirroring the web FactorTierIcon so the good/moderate/poor signal isn't
 * carried by color alone (a11y: color-not-only).
 */
export function factorGlyph(tier: FactorTier): string {
  if (tier === 'good') return '✓';
  if (tier === 'moderate') return '–';
  return '⚠';
}
