/**
 * MIRROR OF frontend/src/lib/claim-tokens.ts — keep in sync.
 *
 * Phase 3 carrier-claim shared tokens for the mobile app. Status/payment
 * tone & label tables are byte-identical to the web copy; icons are
 * substituted with a small inline glyph map (mobile uses Text-rendered
 * glyphs rather than Lucide React components — same visual language as
 * the existing TabNavigator + StatusBadge files).
 */

// ─── Claim lifecycle states ──────────────────────────────────────────────

export type ClaimStatus =
  | 'notified'
  | 'acknowledged'
  | 'under_investigation'
  | 'reserved'
  | 'settling'
  | 'closed_paid'
  | 'closed_denied'
  | 'closed_dropped'
  | 'reopened';

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  notified: 'Notified',
  acknowledged: 'Acknowledged',
  under_investigation: 'Investigating',
  reserved: 'Reserved',
  settling: 'Settling',
  closed_paid: 'Closed — paid',
  closed_denied: 'Closed — denied',
  closed_dropped: 'Closed — dropped',
  reopened: 'Reopened',
};

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export const CLAIM_STATUS_TONE: Record<ClaimStatus, StatusTone> = {
  notified: 'info',
  acknowledged: 'info',
  under_investigation: 'warning',
  reserved: 'warning',
  settling: 'warning',
  closed_paid: 'success',
  closed_denied: 'neutral',
  closed_dropped: 'neutral',
  reopened: 'warning',
};

/**
 * Single-glyph icons rendered as Text on mobile. Mirrors the semantic
 * intent of the web's Lucide icons (Mail, CheckCircle2, Search, Lock,
 * Coins, BadgeCheck, XCircle, MinusCircle, RotateCcw) using characters
 * that render reliably in the project's default fonts.
 */
export const CLAIM_STATUS_GLYPH: Record<ClaimStatus, string> = {
  notified: '✉',
  acknowledged: '✓',
  under_investigation: '⌕',
  reserved: '◉',
  settling: '⊙',
  closed_paid: '✔',
  closed_denied: '✕',
  closed_dropped: '−',
  reopened: '↻',
};

export const LIFECYCLE_ORDER: ClaimStatus[] = [
  'notified',
  'acknowledged',
  'reserved',
  'settling',
  'closed_paid',
];

export const LIFECYCLE_LABEL_SHORT: Record<string, string> = {
  notified: 'Notified',
  acknowledged: 'Ack',
  reserved: 'Reserved',
  settling: 'Settling',
  closed_paid: 'Closed',
};

export function lifecyclePosition(status: ClaimStatus): number {
  switch (status) {
    case 'notified':
      return 0;
    case 'acknowledged':
    case 'under_investigation':
      return 1;
    case 'reserved':
    case 'reopened':
      return 2;
    case 'settling':
      return 3;
    case 'closed_paid':
    case 'closed_denied':
    case 'closed_dropped':
      return 4;
  }
}

export function isClosedStatus(s: ClaimStatus): boolean {
  return s === 'closed_paid' || s === 'closed_denied' || s === 'closed_dropped';
}

// ─── Action priority per state ───────────────────────────────────────────

export type ActionId =
  | 'record_reserve'
  | 'record_payment'
  | 'close_claim'
  | 'reopen_claim'
  | 'attach_defense_package';

export type ActionEmphasis = 'primary' | 'secondary' | 'tertiary' | 'hidden';

export const ACTION_PRIORITY: Record<ClaimStatus, Record<ActionId, ActionEmphasis>> = {
  notified: {
    record_reserve: 'primary',
    attach_defense_package: 'secondary',
    record_payment: 'hidden',
    close_claim: 'hidden',
    reopen_claim: 'hidden',
  },
  acknowledged: {
    record_reserve: 'primary',
    attach_defense_package: 'secondary',
    record_payment: 'hidden',
    close_claim: 'hidden',
    reopen_claim: 'hidden',
  },
  under_investigation: {
    record_reserve: 'primary',
    record_payment: 'secondary',
    close_claim: 'secondary',
    attach_defense_package: 'tertiary',
    reopen_claim: 'hidden',
  },
  reserved: {
    record_payment: 'primary',
    record_reserve: 'secondary',
    close_claim: 'tertiary',
    attach_defense_package: 'tertiary',
    reopen_claim: 'hidden',
  },
  settling: {
    record_payment: 'primary',
    close_claim: 'secondary',
    record_reserve: 'tertiary',
    attach_defense_package: 'tertiary',
    reopen_claim: 'hidden',
  },
  closed_paid: {
    reopen_claim: 'primary',
    attach_defense_package: 'secondary',
    record_reserve: 'hidden',
    record_payment: 'hidden',
    close_claim: 'hidden',
  },
  closed_denied: {
    reopen_claim: 'primary',
    attach_defense_package: 'secondary',
    record_reserve: 'hidden',
    record_payment: 'hidden',
    close_claim: 'hidden',
  },
  closed_dropped: {
    reopen_claim: 'primary',
    attach_defense_package: 'secondary',
    record_reserve: 'hidden',
    record_payment: 'hidden',
    close_claim: 'hidden',
  },
  reopened: {
    record_payment: 'primary',
    record_reserve: 'secondary',
    close_claim: 'secondary',
    attach_defense_package: 'tertiary',
    reopen_claim: 'hidden',
  },
};

// ─── Payment type maps ───────────────────────────────────────────────────

export type PaymentType = 'indemnity' | 'expense' | 'recovery';

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  indemnity: 'Indemnity',
  expense: 'Expense',
  recovery: 'Recovery',
};

export const PAYMENT_TYPE_TONE: Record<PaymentType, StatusTone> = {
  indemnity: 'info',
  expense: 'warning',
  recovery: 'success',
};

// ─── Money formatters ────────────────────────────────────────────────────

/**
 * Ledger money — monospaced columns. Always shows cents; accountant-
 * convention parens for negative. en-US locale fixed for v1.
 *
 * RN's `Intl.NumberFormat` is polyfilled on Android via `hermes` with
 * `@formatjs/intl-numberformat`. The web mirror uses the same call.
 */
export function formatLedgerMoney(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `($${abs})` : `$${abs}`;
}

/**
 * Headline money — Cormorant editorial figure on the claim detail.
 * Returns the components separately so the caller can style the unit
 * prefix and the digits with different font sizes.
 */
export function formatClaimMoney(
  value: string | number | null | undefined,
): { sign: 'neg' | 'pos' | 'zero'; digits: string } {
  if (value === null || value === undefined || value === '') {
    return { sign: 'zero', digits: '0.00' };
  }
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(n)) return { sign: 'zero', digits: '0.00' };
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return {
    sign: n < 0 ? 'neg' : n > 0 ? 'pos' : 'zero',
    digits: abs,
  };
}

export function formatReserveDelta(
  currentReserve: string | number,
  totalIncurred: string | number,
): { label: string; tone: 'success' | 'danger' | 'neutral' } {
  const r = typeof currentReserve === 'number' ? currentReserve : parseFloat(currentReserve);
  const i = typeof totalIncurred === 'number' ? totalIncurred : parseFloat(totalIncurred);
  if (Number.isNaN(r) || Number.isNaN(i)) return { label: '—', tone: 'neutral' };
  const delta = r - i;
  if (Math.abs(delta) < 0.005) return { label: 'Exact match', tone: 'neutral' };
  const pct = r > 0 ? Math.abs(delta) / r : 0;
  const pctLabel = `${(pct * 100).toFixed(1)}%`;
  const money = formatLedgerMoney(delta);
  if (delta > 0) {
    return { label: `${money} (${pctLabel} headroom)`, tone: 'success' };
  }
  return { label: `${money} (${pctLabel} gap)`, tone: 'danger' };
}
