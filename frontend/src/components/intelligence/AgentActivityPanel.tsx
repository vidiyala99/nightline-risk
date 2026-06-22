"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { fetchAgentRuns, type AgentRun } from "@/lib/agents";

const POLL_MS = 30_000;

/**
 * Agent-oversight panel — reverse-chron feed of recent AgentRuns with the
 * fallback chip as the headline signal. Scope is enforced by the API, so this
 * component carries no persona logic. Self-hides on empty/error (mirrors
 * ExposurePanel) so it never blocks the dashboard.
 */
export function AgentActivityPanel() {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetchAgentRuns()
        .then((r) => active && setRuns(r.runs))
        .catch(() => active && setError(true));
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  if (error || runs === null || runs.length === 0) return null;

  return (
    <section aria-label="Agent activity" className="lc-exposure">
      <div className="lc-exposure__head">
        <h2 className="lc-exposure__title">
          <Bot size={18} aria-hidden /> Agent activity
        </h2>
        <span className="lc-exposure__kpi">
          <b data-testid="agent-runs-count">{runs.length}</b> recent runs
        </span>
      </div>
      <ul className="lc-exposure__list">
        {runs.map((r) => (
          <li key={r.id} className="lc-exposure__row">
            <div className="lc-exposure__row-main">
              <span className="lc-exposure__sev" style={{ color: "var(--text-secondary)" }}>
                {r.agent_name}
              </span>
              <p className="lc-exposure__why" style={{ color: "var(--text-tertiary)" }}>
                {r.entity_type ?? "—"}{r.entity_id ? ` · ${r.entity_id}` : ""} · {r.latency_ms}ms · ${r.cost_usd}
              </p>
            </div>
            <div className="lc-exposure__row-aside" style={{ display: "flex", gap: 6, alignItems: "center" }}>
              {r.outcome === "fallback" ? (
                <span
                  title={r.fallback_reason ?? "fallback"}
                  style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.7rem", padding: "2px 8px",
                    borderRadius: "var(--radius-sm)", color: "var(--state-warning)",
                    border: "1px solid var(--state-warning)",
                  }}
                >
                  fallback
                </span>
              ) : (
                <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--state-success)" }}>
                  {r.outcome ?? r.status}
                </span>
              )}
              <span
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-tertiary)" }}
              >
                {r.auto_completed ? "auto" : "escalated"}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
