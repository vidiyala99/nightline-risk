"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { fetchExposure, type Finding } from "@/lib/intelligence";
import { SEVERITY_COLOR } from "@/lib/risk";

/**
 * Proactive "Attention / Exposure" panel — the deterministic surface of the
 * Risk Intelligence Layer. Requires no question from the user: it tells them
 * what matters now, why (with click-through citations), and what to do next.
 */
export function ExposurePanel() {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    fetchExposure()
      .then((r) => active && setFindings(r.findings))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  if (error) return null; // degrade silently — never block the dashboard
  if (findings === null) return null; // loading: no skeleton needed for v1
  if (findings.length === 0) {
    return (
      <section aria-label="What needs attention" style={{ margin: "1rem 0" }}>
        <p style={{ color: "var(--text-tertiary)" }}>✓ Nothing needs your attention right now.</p>
      </section>
    );
  }

  return (
    <section aria-label="What needs attention" style={{ margin: "1rem 0" }}>
      <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "1rem" }}>
        <AlertTriangle size={18} aria-hidden /> What needs your attention
      </h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
        {findings.map((f) => (
          <li
            key={f.id}
            style={{
              borderLeft: `3px solid ${SEVERITY_COLOR[f.severity] ?? "var(--text-tertiary)"}`,
              padding: "0.5rem 0.75rem",
              background: "var(--surface-2, transparent)",
            }}
          >
            <Link href={f.subject.href} style={{ fontWeight: 600 }}>
              {f.subject.label || f.subject.entity_id}
            </Link>
            <p style={{ margin: "0.25rem 0", color: "var(--text-secondary)" }}>
              {f.why[0]?.excerpt}
            </p>
            <Link href={f.recommended_action.href} style={{ color: "var(--accent-ink)" }}>
              {f.recommended_action.label} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
