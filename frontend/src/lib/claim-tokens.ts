/**
 * Phase 3 carrier-claim shared tokens — status tone/label/icon maps, payment-
 * type maps, lifecycle order, and money formatters.
 *
 * MIRROR OF mobile/src/api/claim-tokens.ts — keep in sync. The mobile copy
 * substitutes `@expo/vector-icons` Lucide pack for the web's `lucide-react`
 * imports and uses React Native's `Intl.NumberFormat` polyfill on Android,
 * but the data tables (TONE, LABEL, LIFECYCLE_ORDER, ACTION_PRIORITY) are
 * byte-identical.
 *
 * The page, status pill, action toolbar, and money formatters all read
 * from this file. No string literals for status labels anywhere else.
 */
import {
  Mail,
  CheckCircle2,
  Search,
  Lock,
  Coins,
  BadgeCheck,
  XCircle,
  MinusCircle,
  RotateCcw,
  type LucideIcon,
} from "lucide-react";

import type { StatusTone } from "@/components/ui/StatusPill";

// ─── Claim lifecycle states ──────────────────────────────────────────────

export type ClaimStatus =
  | "notified"
  | "acknowledged"
  | "under_investigation"
  | "reserved"
  | "settling"
  | "closed_paid"
  | "closed_denied"
  | "closed_dropped"
  | "reopened";

/** Display label used in pills, action verbs, and lifecycle stripes. */
export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  notified: "Notified",
  acknowledged: "Acknowledged",
  under_investigation: "Investigating",
  reserved: "Reserved",
  settling: "Settling",
  closed_paid: "Closed — paid",
  closed_denied: "Closed — denied",
  closed_dropped: "Closed — dropped",
  reopened: "Reopened",
};

/** StatusPill tone per claim status. Color is never the only signal — pair
 *  with the icon and label. */
export const CLAIM_STATUS_TONE: Record<ClaimStatus, StatusTone> = {
  notified: "info",
  acknowledged: "info",
  under_investigation: "warning",
  reserved: "warning",
  settling: "warning",
  closed_paid: "success",
  closed_denied: "neutral",
  closed_dropped: "neutral",
  reopened: "warning",
};

/** Lucide icon per claim status. Pairs with the pill for color-not-only. */
export const CLAIM_STATUS_ICON: Record<ClaimStatus, LucideIcon> = {
  notified: Mail,
  acknowledged: CheckCircle2,
  under_investigation: Search,
  reserved: Lock,
  settling: Coins,
  closed_paid: BadgeCheck,
  closed_denied: XCircle,
  closed_dropped: MinusCircle,
  reopened: RotateCcw,
};

/** The five lifecycle anchors shown in the LifecycleStrip component.
 *  `reopened` and the three closed variants collapse onto the final node —
 *  see lifecyclePosition() below. */
export const LIFECYCLE_ORDER: ClaimStatus[] = [
  "notified",
  "acknowledged",
  "reserved",
  "settling",
  "closed_paid",
];

/** Short labels for the lifecycle-strip nodes. Only the 5 nodes that
 *  appear on the strip have entries; statuses that collapse onto another
 *  node (under_investigation, closed_denied, closed_dropped, reopened)
 *  read their label off the node they share via lifecyclePosition(). */
export const LIFECYCLE_LABEL_SHORT: Record<string, string> = {
  notified: "Notified",
  acknowledged: "Ack",
  reserved: "Reserved",
  settling: "Settling",
  closed_paid: "Closed",
};

/**
 * Maps any claim status to its position on the 5-node lifecycle strip.
 * `under_investigation` shares a node with `acknowledged`; the three closed
 * variants share with `closed_paid`; `reopened` lights `reserved` (because
 * a reopen always goes back through reserved/settling on its way to a new
 * close).
 */
export function lifecyclePosition(status: ClaimStatus): number {
  switch (status) {
    case "notified":
      return 0;
    case "acknowledged":
    case "under_investigation":
      return 1;
    case "reserved":
    case "reopened":
      return 2;
    case "settling":
      return 3;
    case "closed_paid":
    case "closed_denied":
    case "closed_dropped":
      return 4;
  }
}

// ─── Action priority per state ───────────────────────────────────────────

export type ActionId =
  | "record_reserve"
  | "record_payment"
  | "close_claim"
  | "reopen_claim"
  | "attach_defense_package";

export type ActionEmphasis = "primary" | "secondary" | "tertiary" | "hidden";

/**
 * One primary action per state (Apple HIG / Material). Plan §D table —
 * encoded as data so the toolbar component doesn't open-code visibility.
 *
 * Rules: closed states get reopen as primary + defense-package attachment
 * only. Anything money-mutating is hidden until reopened. Reserved is the
 * action-rich middle state with money + close all reachable.
 */
export const ACTION_PRIORITY: Record<ClaimStatus, Record<ActionId, ActionEmphasis>> = {
  notified: {
    record_reserve: "primary",
    attach_defense_package: "secondary",
    record_payment: "hidden",
    close_claim: "hidden",
    reopen_claim: "hidden",
  },
  acknowledged: {
    record_reserve: "primary",
    attach_defense_package: "secondary",
    record_payment: "hidden",
    close_claim: "hidden",
    reopen_claim: "hidden",
  },
  under_investigation: {
    record_reserve: "primary",
    record_payment: "secondary",
    close_claim: "secondary",
    attach_defense_package: "tertiary",
    reopen_claim: "hidden",
  },
  reserved: {
    record_payment: "primary",
    record_reserve: "secondary",
    close_claim: "tertiary",
    attach_defense_package: "tertiary",
    reopen_claim: "hidden",
  },
  settling: {
    record_payment: "primary",
    close_claim: "secondary",
    record_reserve: "tertiary",
    attach_defense_package: "tertiary",
    reopen_claim: "hidden",
  },
  closed_paid: {
    reopen_claim: "primary",
    attach_defense_package: "secondary",
    record_reserve: "hidden",
    record_payment: "hidden",
    close_claim: "hidden",
  },
  closed_denied: {
    reopen_claim: "primary",
    attach_defense_package: "secondary",
    record_reserve: "hidden",
    record_payment: "hidden",
    close_claim: "hidden",
  },
  closed_dropped: {
    reopen_claim: "primary",
    attach_defense_package: "secondary",
    record_reserve: "hidden",
    record_payment: "hidden",
    close_claim: "hidden",
  },
  reopened: {
    record_payment: "primary",
    record_reserve: "secondary",
    close_claim: "secondary",
    attach_defense_package: "tertiary",
    reopen_claim: "hidden",
  },
};

export function isClosedStatus(s: ClaimStatus): boolean {
  return s === "closed_paid" || s === "closed_denied" || s === "closed_dropped";
}

// ─── Payment type maps ───────────────────────────────────────────────────

export type PaymentType = "indemnity" | "expense" | "recovery";

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  indemnity: "Indemnity",
  expense: "Expense",
  recovery: "Recovery",
};

/** Distinct from claim-status tones. Plan §A reserves indigo for
 *  payment-flow accent. Recoveries are net-positive (reduce total) so
 *  they get success tone. */
export const PAYMENT_TYPE_TONE: Record<PaymentType, StatusTone> = {
  indemnity: "info",
  expense: "warning",
  recovery: "success",
};

// ─── Money formatters ────────────────────────────────────────────────────

/**
 * Ledger money: monospace, tabular, accountant convention (parens for
 * negative). Use in table cells and supporting tiles.
 *
 * Always shows cents — never strips `.00`. en-US locale fixed for v1.
 */
export function formatLedgerMoney(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `($${abs})` : `$${abs}`;
}

/**
 * Headline money: rendered in editorial serif at display size. Same digits
 * as ledger but no leading `$` because the surrounding HTML wraps it in a
 * unit prefix; the caller controls the unit affordance.
 */
export function formatClaimMoney(
  value: string | number | null | undefined,
): { sign: "neg" | "pos" | "zero"; digits: string } {
  if (value === null || value === undefined || value === "") {
    return { sign: "zero", digits: "0.00" };
  }
  const n = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(n)) return { sign: "zero", digits: "0.00" };
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return {
    sign: n < 0 ? "neg" : n > 0 ? "pos" : "zero",
    digits: abs,
  };
}

/**
 * Over/under-reserve delta: positive (over-reserved, room to settle) is
 * rendered in the success tone; negative (under-reserved, gap) in the rose
 * accent. Returns the formatted string + a percentage of the reserve.
 *
 * delta = currentReserve - totalIncurred
 *   delta > 0 : over-reserved → "+$1,200.00 (12.0% headroom)"
 *   delta < 0 : under-reserved → "($340.00) (3.4% gap)"
 *   delta = 0 : "Exact"
 */
export function formatReserveDelta(
  currentReserve: string | number,
  totalIncurred: string | number,
): { label: string; tone: "success" | "danger" | "neutral" } {
  const r = typeof currentReserve === "number" ? currentReserve : parseFloat(currentReserve);
  const i = typeof totalIncurred === "number" ? totalIncurred : parseFloat(totalIncurred);
  if (Number.isNaN(r) || Number.isNaN(i)) return { label: "—", tone: "neutral" };
  const delta = r - i;
  if (Math.abs(delta) < 0.005) return { label: "Exact match", tone: "neutral" };
  const pct = r > 0 ? Math.abs(delta) / r : 0;
  const pctLabel = `${(pct * 100).toFixed(1)}%`;
  const money = formatLedgerMoney(delta);
  if (delta > 0) {
    return { label: `${money} (${pctLabel} headroom)`, tone: "success" };
  }
  return { label: `${money} (${pctLabel} gap)`, tone: "danger" };
}
