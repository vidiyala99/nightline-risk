"use client";

import { useMemo } from "react";

import type { ReserveChange } from "@/lib/claims";
import { formatLedgerMoney } from "@/lib/claim-tokens";

interface ReserveSparklineProps {
  changes: ReserveChange[];
  /** Current reserve (the latest value, what the page summary shows).
   *  Anchors the right edge of the line even when the latest change row
   *  hasn't been recorded yet in client state. */
  currentReserve: string;
  width?: number;
  height?: number;
}

/**
 * Inline reserve-trajectory sparkline. Draws the to_amount values of
 * each ReserveChange row plus the current reserve as the right anchor.
 *
 * Visual: a single polyline in lime over the dim surface, with a final
 * dot at the current value. No axes (too noisy at this scale); a title
 * attribute on the <svg> reads "Reserve: $X → $Y over N changes" for
 * tooltip + screen reader.
 *
 * If there are fewer than 2 data points (no reserve changes, or one
 * change which equals the current reserve), we render a flat hairline
 * instead of a polyline — a single dot looks broken.
 */
export function ReserveSparkline({
  changes,
  currentReserve,
  width = 96,
  height = 32,
}: ReserveSparklineProps) {
  const points = useMemo(() => {
    const reserveValues = changes
      .slice()
      .sort((a, b) => new Date(a.received_at).getTime() - new Date(b.received_at).getTime())
      .map((c) => parseFloat(c.to_amount) || 0);
    const current = parseFloat(currentReserve) || 0;
    // Prepend the initial from_amount so the line shows the very first jump.
    const first = changes.length > 0 ? parseFloat(changes[0].from_amount) || 0 : current;
    const series = [first, ...reserveValues];
    if (series[series.length - 1] !== current) series.push(current);
    return series;
  }, [changes, currentReserve]);

  const summary = useMemo(() => {
    const first = points[0] ?? 0;
    const last = points[points.length - 1] ?? 0;
    return `Reserve: ${formatLedgerMoney(first)} → ${formatLedgerMoney(last)} over ${changes.length} ${
      changes.length === 1 ? "change" : "changes"
    }`;
  }, [points, changes.length]);

  // Geometry. Pad 4px inside so the dot doesn't clip.
  const pad = 4;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;

  const flat = points.length < 2 || max === min;

  const coords = points.map((v, i) => {
    const x = pad + (innerW * i) / Math.max(points.length - 1, 1);
    const y = pad + innerH - ((v - min) / range) * innerH;
    return [x, y] as const;
  });

  const path = flat
    ? `M ${pad} ${pad + innerH / 2} L ${pad + innerW} ${pad + innerH / 2}`
    : `M ${coords.map((c) => c.join(" ")).join(" L ")}`;

  const last = coords[coords.length - 1] ?? [pad, pad + innerH / 2];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="claim-sparkline"
      role="img"
      aria-label={summary}
    >
      <title>{summary}</title>
      <path
        d={path}
        fill="none"
        stroke="var(--accent-ink)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={flat ? 0.4 : 1}
      />
      {!flat && (
        <circle
          cx={last[0]}
          cy={last[1]}
          r={2.5}
          fill="var(--accent-ink)"
        />
      )}
    </svg>
  );
}
