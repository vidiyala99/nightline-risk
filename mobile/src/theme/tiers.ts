import { Colors } from './colors';

/**
 * Risk-tier heat ramp — single source of truth, mirrors the web `--tier-a..d`
 * tokens (A best → D worst). Use this everywhere a tier maps to a color; do
 * NOT reach for Colors.accent (lime), which is reserved for brand accents.
 */
const TIER_COLOR: Record<string, string> = {
  A: Colors.tierA,
  B: Colors.tierB,
  C: Colors.tierC,
  D: Colors.tierD,
};

export function tierColor(tier?: string | null): string {
  return TIER_COLOR[(tier ?? '').toUpperCase()] ?? Colors.textMuted;
}
