"use client";

import { ArrowDown, ArrowUp, Minus } from "lucide-react";

import { formatReserveDelta } from "@/lib/claim-tokens";

interface ReserveDeltaBadgeProps {
  currentReserve: string;
  totalIncurred: string | number;
}

/**
 * Inline indicator showing whether the carrier's reserve covers total
 * incurred (positive headroom) or there's a gap (under-reserved).
 *
 * Tone:
 *   over-reserved (delta > 0)  → success (lime hint)
 *   under-reserved (delta < 0) → danger (rose)
 *   exact match                → neutral
 *
 * Plan §A: distinctive detail option (d). Pairs with the Total incurred
 * headline number as visual context — broker reads "$11,000 incurred,
 * $14,000 reserved (+$3,000 headroom)" in one glance.
 */
export function ReserveDeltaBadge({ currentReserve, totalIncurred }: ReserveDeltaBadgeProps) {
  const { label, tone } = formatReserveDelta(currentReserve, totalIncurred);
  if (label === "—") return null;
  const Icon = tone === "success" ? ArrowUp : tone === "danger" ? ArrowDown : Minus;
  const color =
    tone === "success"
      ? "var(--brand-primary)"
      : tone === "danger"
        ? "var(--brand-tertiary)"
        : "var(--text-tertiary)";
  return (
    <span
      className="claim-reserve-delta"
      style={{ color, display: "inline-flex", alignItems: "center", gap: 4 }}
      aria-label={`Reserve vs incurred: ${label}`}
    >
      <Icon size={11} aria-hidden />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>{label}</span>
    </span>
  );
}
