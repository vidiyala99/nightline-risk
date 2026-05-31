/**
 * Shared risk-factor display helpers for glance surfaces (dashboard, terminal).
 *
 * The full factor breakdown — per-factor meters, scores, and plain-language
 * advice — lives ONLY on the Risk Profile page (`/risk-profile/[venueId]`).
 * Summary surfaces show a single "what needs attention" line instead of
 * reproducing every meter, so the four numbers aren't shown without the
 * context that disambiguates them. Mirrors mobile `src/lib/format.ts`.
 */

export type FactorTier = "good" | "moderate" | "poor";

/** Bucket a 0-100 factor score into a tier (higher score = lower risk).
 * Bands: good ≥80 · moderate ≥55 · poor <55 — only genuinely low scores
 * read as red, while a mid-range score stays honestly "moderate" (not green). */
export function getFactorTier(score: number): FactorTier {
  if (score >= 80) return "good";
  if (score >= 55) return "moderate";
  return "poor";
}

/** CSS-var color per tier — the heat ramp, never the lime brand accent. */
export const FACTOR_TIER_COLOR: Record<FactorTier, string> = {
  good: "var(--tier-a)",
  moderate: "var(--state-warning)",
  poor: "var(--state-error)",
};

/** Glyph per tier so the signal isn't color-only (a11y). */
export const FACTOR_GLYPH: Record<FactorTier, string> = {
  good: "✓",
  moderate: "–",
  poor: "⚠",
};

const FACTOR_LABEL: Record<string, string> = {
  incident_history: "Safety record",
  compliance: "Compliance",
  operational: "Operational health",
  business_profile: "Business profile",
};

/** Title-cased label for a factor key ("operational" → "Operational health"). */
export function factorLabel(key: string): string {
  return FACTOR_LABEL[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Estimate the annual-premium saving from raising one factor to 100, given the
 * current composite score, the projected composite score if that factor were
 * fixed, and the current annual premium. Premium scales inversely with score,
 * so the saving is the premium share the score lift represents. Clamped >= 0 (a
 * fix never costs more) and rounded. Returns 0 when the premium or current score
 * is unknown — callers should treat 0 as "no estimate" and hide the line.
 */
export function estimatePremiumDeltaForFix(
  currentScore: number,
  projectedScore: number,
  annualPremium: number,
): number {
  if (!annualPremium || currentScore <= 0) return 0;
  const delta = (annualPremium * (projectedScore - currentScore)) / currentScore;
  return Math.max(0, Math.round(delta));
}

type FactorValue = number | { score: number };

function toScore(v: FactorValue): number {
  return typeof v === "object" && v !== null ? Number(v.score) : Number(v);
}

/**
 * One-line "what's dragging the score" summary. Names the single lowest-scoring
 * factor and how many others share its (worst) tier. Accepts both the numeric
 * and `{ score, weight }` factor shapes the API returns.
 */
export function riskAttentionLine(
  factors: Record<string, FactorValue>,
): { text: string; tier: FactorTier } {
  const scored = Object.entries(factors).map(([k, v]) => [k, toScore(v)] as const);
  if (scored.length === 0) return { text: "No risk factors yet", tier: "good" };

  const inTier = (t: FactorTier) =>
    scored.filter(([, s]) => getFactorTier(s) === t).sort((a, b) => a[1] - b[1]);

  const poor = inTier("poor");
  if (poor.length > 0) {
    const more = poor.length - 1;
    return { text: `${factorLabel(poor[0][0])} needs attention${more > 0 ? ` · +${more} more` : ""}`, tier: "poor" };
  }
  const moderate = inTier("moderate");
  if (moderate.length > 0) {
    const more = moderate.length - 1;
    return { text: `${factorLabel(moderate[0][0])} could be stronger${more > 0 ? ` · +${more} more` : ""}`, tier: "moderate" };
  }
  return { text: "All factors healthy", tier: "good" };
}
