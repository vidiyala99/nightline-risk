"use client";

import { StatusPill } from "@/components/ui/StatusPill";
import {
  CLAIM_STATUS_ICON,
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_TONE,
  type ClaimStatus,
} from "@/lib/claim-tokens";

interface ClaimStatusPillProps {
  status: ClaimStatus;
  /** When true, renders an aria-live="polite" wrapper so screen readers
   *  announce status changes after mutations. Set on the detail-page pill;
   *  leave false for table cells where dozens of pills would otherwise
   *  shout in chorus. */
  announce?: boolean;
  /** When > 0, shows a small "↺ {n}" badge next to the pill so the
   *  broker sees the claim has cycled. Plan §C. */
  reopenCount?: number;
  className?: string;
}

/**
 * Status communication for carrier claims: icon + label + tone. Never tone
 * alone (WCAG color-not-only). The icon set lives in claim-tokens.ts so
 * mobile mirrors render the same affordances.
 *
 * Layout-shift guard: outer span has a fixed min-width so the page doesn't
 * jitter when status text length changes ("Notified" vs "Closed — denied").
 */
export function ClaimStatusPill({
  status,
  announce,
  reopenCount,
  className,
}: ClaimStatusPillProps) {
  const Icon = CLAIM_STATUS_ICON[status];
  return (
    <span
      className={className}
      aria-live={announce ? "polite" : undefined}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 152, justifyContent: "flex-start" }}
    >
      <StatusPill tone={CLAIM_STATUS_TONE[status]}>
        <Icon size={12} aria-hidden style={{ marginRight: 6, verticalAlign: "-1px" }} />
        {CLAIM_STATUS_LABEL[status]}
      </StatusPill>
      {reopenCount !== undefined && reopenCount > 0 && (
        <span
          className="claim-status-pill__reopen"
          aria-label={`Reopened ${reopenCount} ${reopenCount === 1 ? "time" : "times"}`}
        >
          ↺ {reopenCount}
        </span>
      )}
    </span>
  );
}
