"use client";

import { ReactNode } from "react";
import Link from "next/link";
import { clsx } from "clsx";

export type TierLevel = "a" | "b" | "c" | "d" | "neutral";

interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: { text: string; direction: "up" | "down" | "flat" };
  tier?: TierLevel;
  className?: string;
  /** When set, the tile becomes a navigable doorway to its list surface. */
  href?: string;
}

const TIER_COLOR: Record<TierLevel, string> = {
  a: "var(--tier-a)",
  b: "var(--tier-b)",
  c: "var(--tier-c)",
  d: "var(--tier-d)",
  neutral: "var(--border-strong)",
};

const DELTA_COLOR: Record<"up" | "down" | "flat", string> = {
  up: "var(--tier-a)",
  down: "var(--tier-c)",
  flat: "var(--text-tertiary)",
};

export function StatTile({ label, value, unit, delta, tier = "neutral", className, href }: StatTileProps) {
  const style = { "--tile-accent": TIER_COLOR[tier] } as React.CSSProperties;
  const inner = (
    <>
      <div className="stat-tile__label">{label}</div>
      <div className="stat-tile__value">
        {value}
        {unit ? <span className="stat-tile__unit">{unit}</span> : null}
      </div>
      {delta ? (
        <div className="stat-tile__delta" style={{ color: DELTA_COLOR[delta.direction] }}>
          {delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→"} {delta.text}
        </div>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={clsx("stat-tile", "stat-tile--link", className)} style={style}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={clsx("stat-tile", className)} style={style}>
      {inner}
    </div>
  );
}
