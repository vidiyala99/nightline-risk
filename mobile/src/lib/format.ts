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

/** Bucket a 0-100 factor/risk score into a tier.
 * Bands mirror web (src/lib/risk.ts): good ≥80 · moderate ≥55 · poor <55. */
export function getFactorTier(score: number): FactorTier {
  if (score >= 80) return 'good';
  if (score >= 55) return 'moderate';
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

/** Title-cased label for a factor key ("operational" → "Operational health"). */
const FACTOR_LABEL: Record<string, string> = {
  incident_history: 'Safety record',
  compliance: 'Compliance',
  operational: 'Operational health',
  business_profile: 'Business profile',
};
export function factorLabel(key: string): string {
  return FACTOR_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * One-line "what's dragging the score" summary for a factors map. Glance
 * surfaces (dashboard / venue cards) show this instead of the full meter
 * breakdown, which lives only on the Risk Profile page. Names the single
 * lowest-scoring factor and how many others share its (worst) tier, so the
 * line answers "what should I look at?" without reproducing every number.
 */
export function riskAttentionLine(
  factors: Record<string, number>,
): { text: string; tier: FactorTier } {
  const scored = Object.entries(factors).map(([k, v]) => [k, Number(v)] as const);
  if (scored.length === 0) return { text: 'No risk factors yet', tier: 'good' };

  const inTier = (t: FactorTier) =>
    scored.filter(([, s]) => getFactorTier(s) === t).sort((a, b) => a[1] - b[1]);

  const poor = inTier('poor');
  if (poor.length > 0) {
    const more = poor.length - 1;
    return { text: `${factorLabel(poor[0][0])} needs attention${more > 0 ? ` · +${more} more` : ''}`, tier: 'poor' };
  }
  const moderate = inTier('moderate');
  if (moderate.length > 0) {
    const more = moderate.length - 1;
    return { text: `${factorLabel(moderate[0][0])} could be stronger${more > 0 ? ` · +${more} more` : ''}`, tier: 'moderate' };
  }
  return { text: 'All factors healthy', tier: 'good' };
}
