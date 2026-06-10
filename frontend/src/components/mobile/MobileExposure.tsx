"use client";

/**
 * MobileExposure — native-styled "What needs your attention" feed for the phone
 * dashboard. Same data + behaviour as the desktop ExposurePanel
 * (components/intelligence/ExposurePanel.tsx): self-fetches the deterministic
 * exposure findings, sorts critical→low, severity filter chips, self-hides on
 * empty/error. Styled with the `m-` mobile-native layer so it matches the RN
 * card/list aesthetic instead of the desktop `.lc-exposure` look.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchExposure, type Finding } from "@/lib/intelligence";
import { SEVERITY_COLOR } from "@/lib/risk";

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];
type SeverityFilter = "all" | Severity;

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};
const SEVERITY_WEIGHT: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const MAX_ROWS = 8;

export function MobileExposure() {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<SeverityFilter>("all");

  useEffect(() => {
    let active = true;
    fetchExposure()
      .then((r) => active && setFindings(r.findings))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  const sorted = useMemo(
    () =>
      findings
        ? [...findings].sort((a, b) => (SEVERITY_WEIGHT[a.severity] ?? 9) - (SEVERITY_WEIGHT[b.severity] ?? 9))
        : [],
    [findings],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: sorted.length, critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of sorted) c[f.severity] = (c[f.severity] ?? 0) + 1;
    return c;
  }, [sorted]);

  const visible = useMemo(
    () => (filter === "all" ? sorted : sorted.filter((f) => f.severity === filter)),
    [sorted, filter],
  );

  if (error || findings === null || sorted.length === 0) return null; // degrade silently

  const urgent = counts.critical + counts.high;
  const rows = visible.slice(0, MAX_ROWS);

  return (
    <section className="m-card m-expo" aria-label="What needs your attention">
      <div className="m-expo__head">
        <span className="m-eyebrow" style={{ marginBottom: 0 }}>
          What needs your attention
        </span>
        <span className="m-expo__kpi">
          <b>{counts.all}</b> open{urgent > 0 && <> · <span className="hi">{urgent} need eyes</span></>}
        </span>
      </div>

      <div className="m-chips" role="group" aria-label="Filter by severity">
        <button type="button" className="m-chip" data-active={filter === "all"} onClick={() => setFilter("all")}>
          All · {counts.all}
        </button>
        {SEVERITY_ORDER.filter((s) => counts[s] > 0).map((s) => (
          <button key={s} type="button" className="m-chip" data-active={filter === s} onClick={() => setFilter(s)}>
            {SEVERITY_LABEL[s]} · {counts[s]}
          </button>
        ))}
      </div>

      <div className="m-expo__list">
        {rows.map((f) => (
          <Link
            key={f.id}
            href={f.recommended_action.href}
            className="m-expo-row"
            style={{ ["--sev" as string]: SEVERITY_COLOR[f.severity] ?? "var(--text-tertiary)" }}
          >
            <span className="m-expo-row__sev">{SEVERITY_LABEL[f.severity as Severity] ?? f.severity}</span>
            <span className="m-expo-row__subject">{f.subject.label || f.subject.entity_id}</span>
            {f.why[0]?.excerpt && <span className="m-expo-row__why">{f.why[0].excerpt}</span>}
            <span className="m-expo-row__action">{f.recommended_action.label} →</span>
          </Link>
        ))}
      </div>
      {visible.length > MAX_ROWS && (
        <span className="m-expo__more">+{visible.length - MAX_ROWS} more</span>
      )}
    </section>
  );
}
