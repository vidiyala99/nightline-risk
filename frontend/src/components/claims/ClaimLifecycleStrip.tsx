"use client";

import {
  LIFECYCLE_LABEL_SHORT,
  LIFECYCLE_ORDER,
  isClosedStatus,
  lifecyclePosition,
  type ClaimStatus,
} from "@/lib/claim-tokens";

interface ClaimLifecycleStripProps {
  status: ClaimStatus;
  reopenCount?: number;
}

/**
 * Editorial five-node lifecycle indicator. Lit segments use lime accent;
 * dim segments use the subtle border token. Layout: nodes evenly spaced
 * with hairline rules between, label below each node, current state's
 * label rendered in editorial italic.
 *
 * Reopen treatment: when reopen_count > 0 we keep the strip lit through
 * the current state but render a small "↺ {n}" badge above the strip so
 * the broker sees the claim has cycled. We do NOT light the closed node
 * for a reopened claim — that would mis-state the lifecycle.
 *
 * Motion: a CSS @keyframes pulse on the active node, suppressed by
 * prefers-reduced-motion. Spring physics for state transitions would be
 * elegant but adds a dependency; the 200ms pulse is enough signal.
 */
export function ClaimLifecycleStrip({ status, reopenCount = 0 }: ClaimLifecycleStripProps) {
  const pos = lifecyclePosition(status);
  // For closed_denied / closed_dropped, the strip *should* visually
  // distinguish them from closed_paid. We don't extend the strip; instead
  // the final node is rendered in the neutral tone (vs lime for closed_paid).
  const finalTone =
    status === "closed_paid"
      ? "lit"
      : status === "closed_denied" || status === "closed_dropped"
        ? "neutral-lit"
        : "dim";

  return (
    <div
      className="claim-lifecycle"
      role="group"
      aria-label="Claim lifecycle progress"
    >
      {reopenCount > 0 && (
        <span
          className="claim-lifecycle__reopen-badge"
          aria-label={`Reopened ${reopenCount} ${reopenCount === 1 ? "time" : "times"}`}
        >
          ↺ {reopenCount}
        </span>
      )}
      <ol className="claim-lifecycle__nodes">
        {LIFECYCLE_ORDER.map((node, i) => {
          const isFinal = i === LIFECYCLE_ORDER.length - 1;
          const lit = i < pos;
          const active = i === pos && !isClosedStatus(status);
          const finalActive = isFinal && isClosedStatus(status);
          const cls = active
            ? "claim-lifecycle__node claim-lifecycle__node--active"
            : finalActive && finalTone === "lit"
              ? "claim-lifecycle__node claim-lifecycle__node--lit"
              : finalActive && finalTone === "neutral-lit"
                ? "claim-lifecycle__node claim-lifecycle__node--neutral-lit"
                : lit
                  ? "claim-lifecycle__node claim-lifecycle__node--lit"
                  : "claim-lifecycle__node";
          return (
            <li key={node} className={cls}>
              <span className="claim-lifecycle__dot" aria-hidden />
              <span className="claim-lifecycle__label">
                {LIFECYCLE_LABEL_SHORT[node]}
              </span>
              {!isFinal && <span className="claim-lifecycle__rule" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
