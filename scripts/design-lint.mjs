#!/usr/bin/env node
/**
 * design-lint — guards the Paper & Ink token system against the drift classes
 * that have actually bitten this codebase (lime-as-text, accent-value drift,
 * dark-era hex leftovers, raw tier hexes). It is the enforcement layer the
 * design system never had: token NAMES are stable, but nothing stopped a page
 * from inlining a raw value or using a fill color as text.
 *
 * Run: node scripts/design-lint.mjs   (exit 1 if any ERROR-level violations)
 *
 * Scans frontend/src and mobile/src .ts/.tsx. Token DEFINITION files are
 * allowlisted (they're allowed to contain raw hex — that's their job).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["frontend/src", "mobile/src"];

// Files that legitimately contain raw color values (the token sources).
const ALLOW = [
  "mobile/src/theme/colors.ts",
  "mobile/src/theme/tiers.ts",
  "frontend/src/lib/risk.ts", // FACTOR_TIER_COLOR maps to var(--tier-*), no raw hex
  "frontend/src/contexts/ThemeContext.tsx", // theme-config definition object (holds literal brand values)
  // Leaflet CircleMarker pathOptions are SVG/canvas paint props — CSS vars
  // don't resolve there, so literal hex (#c8f000 marker, #17150F stroke) is required.
  "frontend/src/app/market/MarketMap.tsx",
];

const LEVEL = { ERROR: "ERROR", WARN: "WARN" };

// Each rule: { test(line), msg, level, platform? ('web'|'mobile'|both) }
const RULES = [
  {
    // Catches direct use AND ternaries/expressions: `color: cond ? "var(--brand-primary)" : x`.
    // [^,};\n] keeps the match inside one declaration so `color: ink, background: lime` is fine.
    re: /\bcolor:\s*[^,};\n]*?var\(--brand-primary\)/,
    msg: "lime as TEXT color — use var(--accent-ink) (brand-primary is fill-only)",
    level: LEVEL.ERROR, platform: "web",
  },
  {
    // Same ternary-tolerant shape for RN style objects: `color: cond ? Colors.accent : x`.
    re: /\bcolor:\s*[^,}\n]*?\bColors\.accent\b/,
    msg: "lime as TEXT color — use Colors.accentInk (accent is fill-only)",
    level: LEVEL.ERROR, platform: "mobile",
  },
  {
    re: /#c8f000|#d4ff00/i,
    msg: "raw lime hex — use var(--brand-primary)/Colors.accent (fill) or var(--accent-ink)/Colors.accentInk (text)",
    level: LEVEL.ERROR, platform: "both",
  },
  {
    re: /\b212\s*,\s*255\s*,\s*0\b/,
    msg: "accent-value drift — canonical lime is 200,240,0 (use the rgba(200,240,0,…) token value)",
    level: LEVEL.ERROR, platform: "both",
  },
  {
    re: /#0d0f1c|#07080f|#0a0b14|#1a1a1a|#111\b/i,
    msg: "dark-era hex leftover — use a --bg-* token (paper theme)",
    level: LEVEL.WARN, platform: "both",
  },
  {
    re: /#197A43|#A87900|#C2410C|#B91C1C/i,
    msg: "raw tier hex — use var(--tier-a..d) / Colors.tierA..D / tierColor()",
    level: LEVEL.WARN, platform: "both",
  },
];

function platformOf(relPath) {
  return relPath.startsWith("mobile") ? "mobile" : "web";
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next" || name === "dist") continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
      yield full;
    }
  }
}

const findings = [];
for (const d of SCAN_DIRS) {
  for (const file of walk(join(ROOT, d))) {
    const rel = relative(ROOT, file).split(sep).join("/");
    if (ALLOW.includes(rel)) continue;
    const platform = platformOf(rel);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const rule of RULES) {
        if (rule.platform !== "both" && rule.platform !== platform) continue;
        if (rule.re.test(line)) {
          findings.push({ file: rel, line: i + 1, level: rule.level, msg: rule.msg, src: line.trim().slice(0, 100) });
        }
      }
    });
  }
}

const errors = findings.filter(f => f.level === LEVEL.ERROR);
const warns = findings.filter(f => f.level === LEVEL.WARN);

for (const f of findings) {
  console.log(`${f.level === "ERROR" ? "✗" : "⚠"} ${f.level}  ${f.file}:${f.line}  ${f.msg}\n    ${f.src}`);
}
console.log(`\ndesign-lint: ${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length > 0 ? 1 : 0);
