"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { clsx } from "clsx";
import { TierBadge, Tier } from "./TierBadge";

interface TriageRowProps {
  href: string;
  name: string;
  context?: string;
  score: number;
  tier: Tier;
  premium?: string;
  renewal?: string;
  flag?: { tone: "warning" | "danger"; label: string };
  className?: string;
}

export function TriageRow({ href, name, context, score, tier, premium, renewal, flag, className }: TriageRowProps) {
  return (
    <Link
      href={href}
      className={clsx("triage-row", flag && `triage-row--${flag.tone}`, className)}
    >
      <div className="triage-row__name">
        <div className="triage-row__name-line">
          <span>{name}</span>
          {flag ? <span className={`triage-row__flag triage-row__flag--${flag.tone}`}>▲ {flag.label}</span> : null}
        </div>
        {context ? <div className="triage-row__context">{context}</div> : null}
      </div>
      <div className="triage-row__cell triage-row__score">{score}</div>
      <div className="triage-row__cell triage-row__tier"><TierBadge tier={tier} /></div>
      <div className="triage-row__cell triage-row__premium">{premium ?? "—"}</div>
      <div className="triage-row__cell triage-row__renewal">{renewal ?? "—"}</div>
      <div className="triage-row__arrow"><ArrowUpRight size={14} /></div>
    </Link>
  );
}

export function TriageRowHeader() {
  return (
    <div className="triage-row triage-row--head">
      <div>Venue</div>
      <div className="triage-row__cell">Score</div>
      <div className="triage-row__cell">Tier</div>
      <div className="triage-row__cell">Premium</div>
      <div className="triage-row__cell">Renewal</div>
      <div></div>
    </div>
  );
}
