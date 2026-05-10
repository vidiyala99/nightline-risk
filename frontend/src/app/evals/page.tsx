"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

interface ScorerResult {
  name: string;
  passed: boolean;
  score: number;
  detail: string;
}

interface ScenarioSnapshot {
  scenario_id: string;
  description: string;
  exposure_class: string;
  difficulty: string;
  scenario_type: string;
  error: string | null;
  passed: boolean;
  scorers: ScorerResult[];
}

interface Snapshot {
  timestamp: string;
  provider: string;
  aggregate: { total: number; passed: number; pass_rate: number };
  scorer_averages: { name: string; pass_rate: number; avg_score: number; count: number }[];
  scenarios: ScenarioSnapshot[];
}

const EXPOSURE_LABEL: Record<string, string> = {
  assault_battery: "Assault & Battery",
  dram_shop: "Dram Shop / Liquor Liability",
  premises_liability: "Premises Liability",
  medical_emergency: "Medical Emergency",
  property_damage: "Property Damage",
  crowd_management: "Crowd Management",
  negligent_security: "Negligent Security",
};

const DIFFICULTY_COLOR: Record<string, string> = {
  easy: "var(--state-success)",
  medium: "var(--state-warning)",
  hard: "var(--state-error)",
};

const TYPE_COLOR: Record<string, string> = {
  standard: "var(--text-tertiary)",
  mitigating_factor_bait: "var(--brand-secondary)",
  subtle_catastrophic: "var(--brand-tertiary)",
};

function scoreColor(score: number): string {
  if (score >= 1) return "var(--state-success)";
  if (score >= 0.5) return "var(--state-warning)";
  return "var(--state-error)";
}

function formatPercent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export default function EvalsPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/eval-baseline.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  const grouped = useMemo(() => {
    if (!data) return [] as { exposure: string; scenarios: ScenarioSnapshot[] }[];
    const map = new Map<string, ScenarioSnapshot[]>();
    for (const s of data.scenarios) {
      const key = s.exposure_class || "unknown";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries()).map(([exposure, scenarios]) => ({ exposure, scenarios }));
  }, [data]);

  if (error) {
    return (
      <main style={pageStyle}>
        <div style={{ color: "var(--state-error)", padding: "var(--space-xl)" }}>
          Failed to load eval baseline: {error}
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main style={pageStyle}>
        <div style={{ color: "var(--text-tertiary)", padding: "var(--space-xl)" }}>Loading…</div>
      </main>
    );
  }

  return (
    <main style={pageStyle}>
      <header style={{ marginBottom: "var(--space-2xl)" }}>
        <p style={eyebrowStyle}>AGENT EVAL SET · v2 · {data.provider}</p>
        <h1 style={titleStyle}>
          Underwriting Agent <span style={{ color: "var(--brand-primary)" }}>Scoreboard</span>
        </h1>
        <p style={subtitleStyle}>
          {data.scenarios.length} research-grounded scenarios across {grouped.length} exposure classes,
          scored on 5 deterministic dimensions. Each failure points at a specific capability gap —
          the eval is meant to <em>reveal</em> weaknesses, not gate them.
        </p>
        <p style={metaStyle}>
          Run timestamp: <span style={{ fontFamily: "var(--font-mono)" }}>{data.timestamp}</span>
        </p>
      </header>

      {/* Aggregate stats */}
      <section style={sectionStyle}>
        <div style={statRowStyle}>
          <div style={statCardStyle}>
            <div style={statEyebrowStyle}>SCENARIOS PASSING ALL SCORERS</div>
            <div style={{ ...statValueStyle, color: scoreColor(data.aggregate.pass_rate) }}>
              {data.aggregate.passed} / {data.aggregate.total}
            </div>
            <div style={statSubStyle}>{formatPercent(data.aggregate.pass_rate)} aggregate</div>
          </div>
          {data.scorer_averages.map((s) => (
            <div key={s.name} style={statCardStyle}>
              <div style={statEyebrowStyle}>{s.name.replace(/_/g, " ").toUpperCase()}</div>
              <div style={{ ...statValueStyle, color: scoreColor(s.pass_rate) }}>
                {formatPercent(s.pass_rate)}
              </div>
              <div style={statSubStyle}>avg score {s.avg_score.toFixed(2)}</div>
            </div>
          ))}
        </div>
      </section>

      {/* What this means */}
      <section style={{ ...sectionStyle, ...explainerStyle }}>
        <p style={{ marginBottom: "var(--space-md)" }}>
          <strong style={{ color: "var(--text-primary)" }}>How to read this.</strong>{" "}
          The deterministic stub represents what the agent pipeline does today without LLMs.
          A 100% pass rate would mean the eval is too easy — we want failures, because they tell
          us where the LLM uplift will land.
        </p>
        <p style={{ color: "var(--text-tertiary)", fontSize: "0.875rem" }}>
          See <a href="https://github.com/Aakash-Vidiyala/ThirdSpaceRisk/blob/main/docs/evals/README.md" style={linkStyle} target="_blank" rel="noopener noreferrer">methodology doc</a>{" "}
          for the 8 guardrails, scorer reference, and findings ledger linking each failure to its
          root cause classification (agent-gap / gold-error / known-limit).
        </p>
      </section>

      {/* Scenarios grouped by exposure class */}
      <section style={sectionStyle}>
        <h2 style={h2Style}>Scenarios by Exposure Class</h2>
        {grouped.map((group) => {
          const passed = group.scenarios.filter((s) => s.passed).length;
          const total = group.scenarios.length;
          return (
            <div key={group.exposure} style={{ marginBottom: "var(--space-2xl)" }}>
              <div style={groupHeaderStyle}>
                <h3 style={h3Style}>
                  {EXPOSURE_LABEL[group.exposure] ?? group.exposure}
                </h3>
                <span style={groupCountStyle}>
                  {passed}/{total} pass
                </span>
              </div>
              <div style={scenarioListStyle}>
                {group.scenarios.map((s) => (
                  <ScenarioCard key={s.scenario_id} scenario={s} />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      <footer style={footerStyle}>
        <Link href="/dashboard" style={linkStyle}>← back to dashboard</Link>
      </footer>
    </main>
  );
}

function ScenarioCard({ scenario }: { scenario: ScenarioSnapshot }) {
  return (
    <div style={cardStyle}>
      <div style={cardHeaderStyle}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", gap: "var(--space-sm)", alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
            <span style={{ ...statusGlyphStyle, color: scenario.passed ? "var(--state-success)" : "var(--state-error)" }}>
              {scenario.passed ? "✓" : "✗"}
            </span>
            <span style={scenarioIdStyle}>{scenario.scenario_id}</span>
            {scenario.difficulty && (
              <span style={{ ...tagStyle, color: DIFFICULTY_COLOR[scenario.difficulty], borderColor: DIFFICULTY_COLOR[scenario.difficulty] }}>
                {scenario.difficulty}
              </span>
            )}
            {scenario.scenario_type && scenario.scenario_type !== "standard" && (
              <span style={{ ...tagStyle, color: TYPE_COLOR[scenario.scenario_type], borderColor: TYPE_COLOR[scenario.scenario_type] }}>
                {scenario.scenario_type.replace(/_/g, " ")}
              </span>
            )}
          </div>
          {scenario.description && (
            <p style={descriptionStyle}>{scenario.description}</p>
          )}
        </div>
      </div>
      <div style={scorersGridStyle}>
        {scenario.scorers.map((s) => (
          <div key={s.name} style={scorerCellStyle}>
            <div style={scorerHeaderStyle}>
              <span style={{ color: s.passed ? "var(--state-success)" : "var(--state-error)", marginRight: 6 }}>
                {s.passed ? "✓" : "✗"}
              </span>
              <span style={scorerNameStyle}>{s.name.replace(/_/g, " ")}</span>
              <span style={{ ...scorerScoreStyle, color: scoreColor(s.score) }}>{s.score.toFixed(2)}</span>
            </div>
            <div style={scorerDetailStyle}>{s.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Styles ----

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg-base)",
  color: "var(--text-primary)",
  padding: "var(--space-2xl) var(--space-xl)",
  maxWidth: 1280,
  margin: "0 auto",
  fontFamily: "var(--font-body)",
};

const eyebrowStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.7rem",
  fontWeight: 700,
  letterSpacing: "0.18em",
  marginBottom: "var(--space-sm)",
  fontFamily: "var(--font-mono)",
};

const titleStyle: React.CSSProperties = {
  color: "var(--text-primary)",
  fontFamily: "var(--font-display)",
  fontSize: "2.5rem",
  fontWeight: 700,
  letterSpacing: "-0.02em",
  marginBottom: "var(--space-md)",
  lineHeight: 1.1,
};

const subtitleStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "1rem",
  lineHeight: 1.55,
  maxWidth: 720,
  marginBottom: "var(--space-md)",
};

const metaStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.75rem",
};

const sectionStyle: React.CSSProperties = {
  marginBottom: "var(--space-2xl)",
};

const explainerStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-lg)",
  fontSize: "0.95rem",
  lineHeight: 1.55,
  color: "var(--text-secondary)",
};

const statRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "var(--space-md)",
};

const statCardStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-lg)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-xs)",
};

const statEyebrowStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.65rem",
  fontWeight: 700,
  letterSpacing: "0.15em",
  fontFamily: "var(--font-mono)",
};

const statValueStyle: React.CSSProperties = {
  fontSize: "2rem",
  fontWeight: 700,
  letterSpacing: "-0.03em",
  fontFamily: "var(--font-mono)",
};

const statSubStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.75rem",
  fontFamily: "var(--font-mono)",
};

const h2Style: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "1.75rem",
  fontWeight: 700,
  marginBottom: "var(--space-lg)",
  letterSpacing: "-0.02em",
};

const groupHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  marginBottom: "var(--space-md)",
  paddingBottom: "var(--space-sm)",
  borderBottom: "1px solid var(--border-subtle)",
};

const h3Style: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: "1.25rem",
  fontWeight: 600,
  letterSpacing: "-0.01em",
};

const groupCountStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.75rem",
  fontFamily: "var(--font-mono)",
  letterSpacing: "0.05em",
};

const scenarioListStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-md)",
};

const cardStyle: React.CSSProperties = {
  background: "var(--bg-surface)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-xl)",
  padding: "var(--space-lg)",
};

const cardHeaderStyle: React.CSSProperties = {
  marginBottom: "var(--space-md)",
};

const statusGlyphStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 700,
  fontFamily: "var(--font-mono)",
};

const scenarioIdStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--text-primary)",
};

const tagStyle: React.CSSProperties = {
  fontSize: "0.65rem",
  fontFamily: "var(--font-mono)",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  padding: "2px 8px",
  border: "1px solid",
  borderRadius: "var(--radius-sm)",
};

const descriptionStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "0.875rem",
  lineHeight: 1.5,
  marginTop: "var(--space-sm)",
};

const scorersGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: "var(--space-sm)",
};

const scorerCellStyle: React.CSSProperties = {
  background: "var(--bg-base)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  padding: "var(--space-sm) var(--space-md)",
};

const scorerHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  marginBottom: 4,
  fontFamily: "var(--font-mono)",
  fontSize: "0.75rem",
};

const scorerNameStyle: React.CSSProperties = {
  flex: 1,
  color: "var(--text-secondary)",
};

const scorerScoreStyle: React.CSSProperties = {
  fontWeight: 700,
};

const scorerDetailStyle: React.CSSProperties = {
  color: "var(--text-tertiary)",
  fontSize: "0.7rem",
  fontFamily: "var(--font-mono)",
  lineHeight: 1.4,
};

const linkStyle: React.CSSProperties = {
  color: "var(--brand-primary)",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textUnderlineOffset: 3,
};

const footerStyle: React.CSSProperties = {
  borderTop: "1px solid var(--border-subtle)",
  paddingTop: "var(--space-lg)",
  marginTop: "var(--space-2xl)",
};
