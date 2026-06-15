import * as React from "react";

import { cn } from "@/lib/utils";

type Tier = "A" | "B" | "C" | "D" | string;

/** Risk-tier badge using the single heat ramp (A best → D worst).
 *  Never the brand blue — tiers are their own semantic scale. */
const TIER_CLASS: Record<string, string> = {
  A: "bg-tier-a/15 text-tier-a border-tier-a/30",
  B: "bg-tier-b/20 text-tier-b border-tier-b/30",
  C: "bg-tier-c/20 text-tier-c border-tier-c/30",
  D: "bg-tier-d/15 text-tier-d border-tier-d/30",
};

export function TierBadge({
  tier,
  className,
  ...props
}: React.ComponentProps<"span"> & { tier: Tier }) {
  const key = String(tier).toUpperCase().charAt(0);
  return (
    <span
      data-slot="tier-badge"
      className={cn(
        "inline-flex size-6 items-center justify-center rounded-md border text-xs font-bold tabular-nums",
        TIER_CLASS[key] ?? "bg-muted text-muted-foreground border-border",
        className
      )}
      {...props}
    >
      {key}
    </span>
  );
}
