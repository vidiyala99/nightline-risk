import { Colors } from './colors';

// Single source for severity / corroboration ink colors. These values are used
// as TEXT colors (chips, badges, % numerals) as well as fills, so lime is
// banned here — low-severity ink is accentInk per the lime-is-fill-only rule.
// Screens must import these instead of declaring local copies: three local
// copies drifted to lime-as-text before this module existed (fixed 2026-06-05),
// and design-lint now errors on lime assigned to these semantic keys.

export const SEVERITY_COLOR: Record<string, string> = {
  critical: Colors.error,
  high: Colors.error,
  medium: Colors.warning,
  low: Colors.accentInk,
  unknown: Colors.textMuted,
};

export const CORROBORATION_COLOR: Record<string, string> = {
  CONSISTENT: Colors.accentInk,
  PARTIAL: Colors.warning,
  CONTRADICTED: Colors.error,
  INCONCLUSIVE: Colors.textMuted,
};
