# Design System v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the editorial-dark + bento-hybrid redesign defined in `docs/superpowers/specs/2026-05-20-design-system-v3-design.md`. Update design tokens, build 8 core UI components, rebuild the AppShell with named sidebar, and redesign all Tier 1/2 pages.

**Architecture:** Tokens-first. Update `frontend/src/app/styles.css` design variables once; all pages and components inherit. Build 8 stateless components in `frontend/src/components/ui/` that consume only tokens. Rebuild `AppShell.tsx` with grouped named sidebar. Then redesign pages top-down (Tier 1 full, Tier 2 component swap, Tier 3 inherits).

**Tech Stack:** Next.js 16, React 19, TypeScript 5.8, Playwright (E2E), CSS variables (no Tailwind), `lucide-react` for icons, `clsx` for classnames.

**Verification approach:** No unit test framework exists. Each task verifies via (a) `tsc --noEmit` for type safety, (b) `next build` for build safety, (c) Playwright E2E (`pnpm test:e2e`) for redesigned pages, (d) `screenshot-dashboard.mjs`-style scripts for visual regression. Commits are frequent and small.

---

## File Structure

**Create (new):**
- `frontend/src/components/ui/StatTile.tsx` — single bento stat with optional tier left-border
- `frontend/src/components/ui/StatStrip.tsx` — fused row of 2–4 StatTiles
- `frontend/src/components/ui/PageHeader.tsx` — eyebrow + serif H1 + optional actions
- `frontend/src/components/ui/TierBadge.tsx` — A/B/C/D monospace badge
- `frontend/src/components/ui/StatusPill.tsx` — generic semantic status pill
- `frontend/src/components/ui/TriageRow.tsx` — table row, collapses to card on mobile
- `frontend/src/components/ui/SidebarNavItem.tsx` — icon + label + badge count nav item

**Modify (existing):**
- `frontend/src/app/styles.css` — tokens, base styles, button refresh
- `frontend/src/components/ui/Button.tsx` — adjust variants to new tokens (light touch)
- `frontend/src/components/layout/AppShell.tsx` — rebuild sidebar structure
- `frontend/src/app/login/page.tsx` — Tier 1 full redesign
- `frontend/src/app/dashboard/page.tsx` — Tier 1 full redesign
- `frontend/src/app/risk-profile/[venueId]/page.tsx` — Tier 1 full redesign
- `frontend/src/app/terminal/[venueId]/page.tsx` — Tier 1 full redesign
- `frontend/src/app/venues/page.tsx` — Tier 2 component swap
- `frontend/src/app/incidents/page.tsx` — Tier 2 component swap
- `frontend/src/app/compliance/page.tsx` — Tier 2 component swap
- `frontend/src/app/claims/page.tsx` — Tier 2 component swap

**Test (Playwright, modify):**
- `frontend/e2e/*.spec.ts` — update selectors only where redesigned markup changes them

---

## Phase 1: Design Tokens

### Task 1: Update color, radius, and spacing tokens in styles.css

**Files:**
- Modify: `frontend/src/app/styles.css:1-99`

- [ ] **Step 1: Read the current `:root` block to confirm structure**

Run: `head -100 frontend/src/app/styles.css`
Expected: Existing `:root` with `--bg-dark`, `--brand-primary`, etc.

- [ ] **Step 2: Replace token values**

Replace lines 9–14 with:
```css
  --bg-dark: #08090e;
  --bg-base: #0e0f1a;
  --bg-surface: #13151f;
  --bg-surface-elevated: #1a1c2a;
  --bg-surface-hover: #202234;
  --bg-elevated: #1a1c2a;
```

Add new tier tokens after `--brand-tertiary` line:
```css
  /* Risk Tier Colors — semantic, NOT brand */
  --tier-a: #22c55e;
  --tier-b: #818cf8;
  --tier-c: #f59e0b;
  --tier-d: #f43f5e;
```

Replace radius block (around line 94–98) with:
```css
  --radius-sm: 3px;
  --radius-md: 5px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-full: 9999px;
```

- [ ] **Step 3: Type-check and build to confirm no syntax errors**

Run from `frontend/`: `pnpm exec tsc --noEmit && pnpm exec next build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/styles.css
git commit -m "design: update color/radius tokens to v3 — tier colors + tighter radii"
```

### Task 2: Tighten base typography and remove chunky paddings

**Files:**
- Modify: `frontend/src/app/styles.css:155-260` (headings and buttons)

- [ ] **Step 1: Update heading sizes to tighter scale**

Replace the `h1, h2, h3` block (around line 157–163) with:
```css
h1, h2, h3 {
  font-family: var(--font-display);
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.015em;
  color: var(--text-primary);
}

h1 { font-size: clamp(1.6rem, 1.5vw + 1.1rem, 2.25rem); }
h2 { font-size: clamp(1.3rem, 1vw + 1rem, 1.7rem); }
h3 { font-size: 1.25rem; }
h4 { font-size: 0.95rem; font-family: var(--font-body); font-weight: 600; letter-spacing: 0; }
```

- [ ] **Step 2: Tighten `.btn` padding from 12px/24px to 8px/16px**

Replace `.btn` padding in `.btn` rule (around line 196):
```css
  padding: 8px 16px;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: var(--radius-md);
```

Also update `.btn-sm` and `.btn-lg`:
```css
.btn-sm { padding: 6px 12px; font-size: 0.78rem; }
.btn-lg { padding: 12px 24px; font-size: 0.95rem; }
```

- [ ] **Step 3: Verify build**

Run from `frontend/`: `pnpm exec next build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/styles.css
git commit -m "design: tighten typography scale + button padding"
```

---

## Phase 2: Core Components

### Task 3: Build StatTile component

**Files:**
- Create: `frontend/src/components/ui/StatTile.tsx`

- [ ] **Step 1: Create the component file**

```tsx
"use client";

import { ReactNode } from "react";
import { clsx } from "clsx";

export type TierLevel = "a" | "b" | "c" | "d" | "neutral";

interface StatTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: { text: string; direction: "up" | "down" | "flat" };
  tier?: TierLevel;
  className?: string;
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

export function StatTile({ label, value, unit, delta, tier = "neutral", className }: StatTileProps) {
  return (
    <div
      className={clsx("stat-tile", className)}
      style={{ "--tile-accent": TIER_COLOR[tier] } as React.CSSProperties}
    >
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
    </div>
  );
}
```

- [ ] **Step 2: Add component CSS to styles.css**

Append to end of `frontend/src/app/styles.css`:
```css
/* ============================================
   STAT TILE
   ============================================ */
.stat-tile {
  position: relative;
  padding: 10px 14px;
  background: var(--bg-base);
  border-radius: var(--radius-md);
}
.stat-tile::before {
  content: "";
  position: absolute;
  left: 0; top: 8px; bottom: 8px;
  width: 2px;
  background: var(--tile-accent, var(--border-strong));
  border-radius: 1px;
}
.stat-tile__label {
  color: var(--text-secondary);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  margin-bottom: 4px;
  font-weight: 500;
}
.stat-tile__value {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 1.35rem;
  font-weight: 600;
  line-height: 1;
}
.stat-tile__unit {
  color: var(--text-tertiary);
  font-size: 0.75rem;
  font-weight: 400;
  margin-left: 4px;
}
.stat-tile__delta {
  font-size: 10px;
  margin-top: 5px;
  font-weight: 500;
}
```

- [ ] **Step 3: Type-check**

Run from `frontend/`: `pnpm exec tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/ui/StatTile.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add StatTile component"
```

### Task 4: Build StatStrip component (fuses StatTiles)

**Files:**
- Create: `frontend/src/components/ui/StatStrip.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { ReactNode } from "react";
import { clsx } from "clsx";

interface StatStripProps {
  children: ReactNode;
  className?: string;
}

export function StatStrip({ children, className }: StatStripProps) {
  return <div className={clsx("stat-strip", className)}>{children}</div>;
}
```

- [ ] **Step 2: Add CSS for the strip**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   STAT STRIP — fused row of StatTiles
   ============================================ */
.stat-strip {
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  gap: 1px;
  background: var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.stat-strip .stat-tile {
  border-radius: 0;
}
@media (max-width: 640px) {
  .stat-strip {
    grid-auto-flow: row;
    grid-auto-columns: auto;
  }
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/components/ui/StatStrip.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add StatStrip wrapper for fused stat tiles"
```

### Task 5: Build PageHeader component

**Files:**
- Create: `frontend/src/components/ui/PageHeader.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { ReactNode } from "react";
import { clsx } from "clsx";

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={clsx("page-header", className)}>
      <div className="page-header__text">
        {eyebrow ? <div className="page-header__eyebrow">{eyebrow}</div> : null}
        <h1 className="page-header__title">{title}</h1>
        {subtitle ? <p className="page-header__subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   PAGE HEADER
   ============================================ */
.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 18px;
}
.page-header__eyebrow {
  color: var(--text-secondary);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  margin-bottom: 4px;
  font-weight: 500;
}
.page-header__title {
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: -0.015em;
  line-height: 1.1;
  margin: 0;
}
.page-header__subtitle {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-top: 6px;
  max-width: 60ch;
}
.page-header__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
@media (max-width: 640px) {
  .page-header {
    flex-direction: column;
    align-items: flex-start;
  }
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/components/ui/PageHeader.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add PageHeader component"
```

### Task 6: Build TierBadge component

**Files:**
- Create: `frontend/src/components/ui/TierBadge.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { clsx } from "clsx";

export type Tier = "A" | "B" | "C" | "D";

interface TierBadgeProps {
  tier: Tier;
  className?: string;
}

export function TierBadge({ tier, className }: TierBadgeProps) {
  return <span className={clsx("tier-badge", `tier-badge--${tier.toLowerCase()}`, className)}>{tier}</span>;
}
```

- [ ] **Step 2: Add CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   TIER BADGE
   ============================================ */
.tier-badge {
  display: inline-block;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  line-height: 1.4;
}
.tier-badge--a { color: var(--tier-a); background: rgba(34,197,94,0.12); border-color: rgba(34,197,94,0.25); }
.tier-badge--b { color: var(--tier-b); background: rgba(129,140,248,0.12); border-color: rgba(129,140,248,0.25); }
.tier-badge--c { color: var(--tier-c); background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.25); }
.tier-badge--d { color: var(--tier-d); background: rgba(244,63,94,0.12); border-color: rgba(244,63,94,0.25); }
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/components/ui/TierBadge.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add TierBadge component"
```

### Task 7: Build StatusPill component

**Files:**
- Create: `frontend/src/components/ui/StatusPill.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { clsx } from "clsx";
import { ReactNode } from "react";

export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info";

interface StatusPillProps {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}

export function StatusPill({ tone = "neutral", children, className }: StatusPillProps) {
  return <span className={clsx("status-pill", `status-pill--${tone}`, className)}>{children}</span>;
}
```

- [ ] **Step 2: Add CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   STATUS PILL
   ============================================ */
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
  line-height: 1.4;
  text-transform: uppercase;
}
.status-pill--neutral { color: var(--text-secondary); background: var(--bg-surface); border-color: var(--border-default); }
.status-pill--success { color: var(--tier-a); background: rgba(34,197,94,0.10); border-color: rgba(34,197,94,0.22); }
.status-pill--warning { color: var(--tier-c); background: rgba(245,158,11,0.10); border-color: rgba(245,158,11,0.22); }
.status-pill--danger  { color: var(--tier-d); background: rgba(244,63,94,0.10); border-color: rgba(244,63,94,0.22); }
.status-pill--info    { color: var(--tier-b); background: rgba(129,140,248,0.10); border-color: rgba(129,140,248,0.22); }
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/components/ui/StatusPill.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add StatusPill component"
```

### Task 8: Build TriageRow component (collapses to mobile card)

**Files:**
- Create: `frontend/src/components/ui/TriageRow.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { ReactNode } from "react";
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
```

- [ ] **Step 2: Add CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   TRIAGE ROW
   ============================================ */
.triage-row {
  display: grid;
  grid-template-columns: minmax(0,1fr) 60px 50px 90px 90px 28px;
  align-items: center;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-subtle);
  text-decoration: none;
  color: inherit;
  transition: background 0.15s ease;
}
.triage-row:hover { background: rgba(255,255,255,0.02); }
.triage-row--warning { background: rgba(245,158,11,0.04); }
.triage-row--danger { background: rgba(244,63,94,0.05); }
.triage-row--head {
  border-bottom: 1px solid var(--border-default);
  padding: 6px 0;
}
.triage-row--head > * {
  color: var(--text-tertiary);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 500;
}
.triage-row__name-line {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
}
.triage-row__context {
  color: var(--text-secondary);
  font-size: 10px;
  margin-top: 2px;
}
.triage-row__cell {
  text-align: right;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}
.triage-row__flag--warning { color: var(--tier-c); font-size: 10px; font-family: var(--font-body); }
.triage-row__flag--danger { color: var(--tier-d); font-size: 10px; font-family: var(--font-body); }
.triage-row__arrow {
  color: var(--text-tertiary);
  text-align: right;
  display: flex;
  justify-content: flex-end;
}
.triage-row:hover .triage-row__arrow { color: var(--text-primary); }

@media (max-width: 640px) {
  .triage-row {
    grid-template-columns: 1fr auto;
    grid-template-areas:
      "name tier"
      "context score"
      "premium renewal";
    padding: 12px 0;
    gap: 4px 12px;
  }
  .triage-row__name { grid-area: name; }
  .triage-row--head { display: none; }
}
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/components/ui/TriageRow.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add TriageRow component with mobile stacking"
```

### Task 9: Refresh Button styles (tighter, v3-aligned)

**Files:**
- Modify: `frontend/src/app/styles.css` (button block, around line 188–260)

- [ ] **Step 1: Update `.btn-primary` glow to be subtler**

Replace `.btn-primary` block:
```css
.btn-primary {
  background: var(--brand-primary);
  color: var(--text-inverse);
  box-shadow: 0 0 16px rgba(200, 240, 0, 0.18);
}
.btn-primary:hover {
  background: var(--brand-primary-dim);
  box-shadow: 0 0 22px rgba(200, 240, 0, 0.28);
  transform: translateY(-1px);
}
.btn-primary:active {
  transform: scale(0.97);
  box-shadow: 0 0 10px rgba(200, 240, 0, 0.14);
}
```

- [ ] **Step 2: Add `.btn-danger` (used by destructive actions)**

Append after `.btn-ghost:hover`:
```css
.btn-danger {
  background: rgba(244,63,94,0.12);
  color: var(--tier-d);
  border: 1px solid rgba(244,63,94,0.25);
}
.btn-danger:hover {
  background: rgba(244,63,94,0.18);
  border-color: rgba(244,63,94,0.4);
}
```

- [ ] **Step 3: Verify**

```bash
pnpm exec next build
git add frontend/src/app/styles.css
git commit -m "design: tighten Button glow + add danger variant"
```

### Task 10: Build SidebarNavItem component

**Files:**
- Create: `frontend/src/components/ui/SidebarNavItem.tsx`

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { ComponentType } from "react";
import Link from "next/link";
import { clsx } from "clsx";

interface SidebarNavItemProps {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  active?: boolean;
  badge?: number;
  variant?: "full" | "rail";
  onClick?: () => void;
}

export function SidebarNavItem({
  href,
  label,
  icon: Icon,
  active,
  badge,
  variant = "full",
  onClick,
}: SidebarNavItemProps) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={clsx("sidebar-nav-item", active && "sidebar-nav-item--active", `sidebar-nav-item--${variant}`)}
      aria-current={active ? "page" : undefined}
      title={variant === "rail" ? label : undefined}
    >
      <Icon size={16} aria-hidden />
      {variant === "full" ? <span className="sidebar-nav-item__label">{label}</span> : null}
      {badge && badge > 0 && variant === "full" ? (
        <span className="sidebar-nav-item__badge">{badge}</span>
      ) : null}
    </Link>
  );
}
```

- [ ] **Step 2: Add CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   SIDEBAR NAV ITEM
   ============================================ */
.sidebar-nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  text-decoration: none;
  transition: background 0.15s ease, color 0.15s ease;
  border-left: 2px solid transparent;
  margin-left: -2px;
}
.sidebar-nav-item:hover { color: var(--text-primary); background: rgba(255,255,255,0.03); }
.sidebar-nav-item--active {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border-left-color: var(--brand-primary);
}
.sidebar-nav-item__label { flex: 1; }
.sidebar-nav-item__badge {
  background: rgba(244,63,94,0.15);
  color: var(--tier-d);
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
}
.sidebar-nav-item--rail {
  justify-content: center;
  padding: 8px;
}
.sidebar-nav-item--rail .sidebar-nav-item__label { display: none; }
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/components/ui/SidebarNavItem.tsx frontend/src/app/styles.css
git commit -m "feat(ui): add SidebarNavItem component"
```

---

## Phase 3: App Shell

### Task 11: Rebuild AppShell with named sidebar + section groups

**Files:**
- Modify: `frontend/src/components/layout/AppShell.tsx`

- [ ] **Step 1: Read the current AppShell fully to understand sections to preserve**

Run: `cat frontend/src/components/layout/AppShell.tsx | head -300`

Preserve: `useAuth`, `useRole`, `useTenantId`, `useBreakpoint`, `MobileBottomNav`, mobile drawer toggle, venue-query priority logic.

- [ ] **Step 2: Replace `NavLinks` function with a section-grouped version**

Replace the existing `NavLinks` function with:

```tsx
function NavLinks({ role, tenantId, onNavigate, variant = "full" }: NavLinksProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const queryVenueId = searchParams.get("venue");
  const terminalVenueMatch = pathname?.match(/^\/terminal\/([^/]+)/);
  const pathVenueId = terminalVenueMatch?.[1];
  const contextVenueId = queryVenueId ?? pathVenueId ?? tenantId ?? null;
  const venueQuery = contextVenueId ? `?venue=${encodeURIComponent(contextVenueId)}` : "";

  type Item = { href: string; label: string; icon: typeof LayoutDashboard; roles?: string[]; badge?: number };
  type Group = { label: string; items: Item[] };

  const groups: Group[] = [
    {
      label: "Portfolio",
      items: [
        { href: `/dashboard${venueQuery}`, label: "The Book", icon: LayoutDashboard },
        ...(role === "broker" ? [{ href: "/venues", label: "Venues", icon: Building2 }] : []),
      ],
    },
    {
      label: "Operations",
      items: [
        { href: `/incidents${venueQuery}`, label: "Incidents", icon: AlertTriangle },
        { href: `/compliance${venueQuery}`, label: "Compliance", icon: CheckSquare },
        { href: "/claims", label: "Claims", icon: FileSpreadsheet, roles: ["broker", "admin"] },
        { href: "/alerts", label: "Alerts", icon: Bell },
      ].filter((i) => !i.roles || (role && i.roles.includes(role))),
    },
    {
      label: "Underwriting",
      items: [
        { href: "/underwriter", label: "Reports", icon: FileSearch, roles: ["broker", "admin"] },
        { href: "/evals", label: "Evals", icon: Activity, roles: ["admin"] },
      ].filter((i) => !i.roles || (role && i.roles.includes(role))),
    },
  ].filter((g) => g.items.length > 0);

  const isActive = (href: string) => {
    const base = href.split("?")[0];
    return pathname === base || pathname?.startsWith(base + "/");
  };

  return (
    <nav className={`app-sidebar__nav app-sidebar__nav--${variant}`}>
      {groups.map((group) => (
        <div key={group.label} className="app-sidebar__group">
          {variant === "full" ? <div className="app-sidebar__group-label">{group.label}</div> : null}
          {group.items.map((item) => (
            <SidebarNavItem
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(item.href)}
              badge={item.badge}
              variant={variant === "drawer" ? "full" : variant}
              onClick={onNavigate}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
```

- [ ] **Step 3: Add `SidebarNavItem` import at top of AppShell.tsx**

Add to imports:
```tsx
import { SidebarNavItem } from "@/components/ui/SidebarNavItem";
```

- [ ] **Step 4: Add sidebar shell CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   APP SIDEBAR — v3
   ============================================ */
.app-sidebar {
  width: 180px;
  background: var(--bg-base);
  border-right: 1px solid var(--border-subtle);
  padding: 14px 0;
  display: flex;
  flex-direction: column;
}
.app-sidebar--rail { width: 52px; }
.app-sidebar__brand {
  padding: 0 14px 14px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.app-sidebar__logo {
  width: 24px; height: 24px;
  background: var(--brand-primary);
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.app-sidebar__logo-mark { color: var(--text-inverse); font-size: 11px; font-weight: 900; }
.app-sidebar__wordmark { color: var(--text-primary); font-size: 11px; font-weight: 600; line-height: 1; }
.app-sidebar__wordmark-sub { color: var(--text-secondary); font-size: 9px; }
.app-sidebar__nav { padding: 0 8px; flex: 1; }
.app-sidebar__nav--rail { padding: 0 4px; }
.app-sidebar__group { margin-bottom: 14px; }
.app-sidebar__group-label {
  color: var(--text-tertiary);
  font-size: 9px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 0 10px;
  margin-bottom: 4px;
  font-weight: 600;
}
.app-sidebar__footer {
  padding: 12px 8px 0;
  border-top: 1px solid var(--border-subtle);
}
```

- [ ] **Step 5: Update the shell render block to use new sidebar markup**

Find the existing sidebar `<aside>` render (search for `className="lc-sidebar"` or equivalent). Replace it with:

```tsx
<aside className={`app-sidebar ${variant === "rail" ? "app-sidebar--rail" : ""}`}>
  <div className="app-sidebar__brand">
    <div className="app-sidebar__logo"><span className="app-sidebar__logo-mark">T</span></div>
    {variant !== "rail" && (
      <div>
        <div className="app-sidebar__wordmark">Nightline</div>
        <div className="app-sidebar__wordmark-sub">Risk OS</div>
      </div>
    )}
  </div>
  <NavLinks role={role} tenantId={tenantId} onNavigate={closeDrawer} variant={variant} />
  <div className="app-sidebar__footer">
    <button onClick={signOut} className="sidebar-nav-item">
      <LogOut size={16} aria-hidden />
      {variant !== "rail" && <span className="sidebar-nav-item__label">Sign out</span>}
    </button>
  </div>
</aside>
```

(Adjust `variant` source to match existing breakpoint logic: `full` for ≥1180px, `rail` for 640–1180px, `drawer` (overlay) for <640px.)

- [ ] **Step 6: Type-check, build, smoke test**

```bash
pnpm exec tsc --noEmit
pnpm exec next build
```

Manually verify `/dashboard` loads with the new sidebar visible on desktop.

- [ ] **Step 7: Run E2E to catch broken selectors**

```bash
pnpm test:e2e
```

If any test fails because of changed sidebar markup, note the failures (fix in Task 22).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/layout/AppShell.tsx frontend/src/app/styles.css
git commit -m "feat(shell): rebuild AppShell with named sidebar + section groups"
```

---

## Phase 4: Tier 1 Page Redesigns

### Task 12: Redesign Login page

**Files:**
- Modify: `frontend/src/app/login/page.tsx`
- Modify: `frontend/src/app/styles.css` (add `.login-shell` styles)

- [ ] **Step 1: Read existing login page**

Run: `cat frontend/src/app/login/page.tsx | head -60`

Preserve: form submission logic, auth context calls, error state.

- [ ] **Step 2: Replace the page wrapper markup**

The page should render with this structure (adapt to existing form logic):

```tsx
<div className="login-shell">
  <div className="login-shell__brand">
    <div className="app-sidebar__logo" style={{ width: 36, height: 36 }}>
      <span className="app-sidebar__logo-mark" style={{ fontSize: 14 }}>T</span>
    </div>
    <div>
      <div style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>Nightline</div>
      <div style={{ color: "var(--text-secondary)", fontSize: 11 }}>Risk OS</div>
    </div>
  </div>
  <div className="login-shell__card">
    <h1 className="login-shell__title">Sign in</h1>
    <p className="login-shell__subtitle">Access your portfolio, claims, and live venue data.</p>
    {/* existing form fields go here, wrapped in <form className="login-shell__form"> */}
  </div>
  <div className="login-shell__quote">
    <p>"Keep cultural businesses alive."</p>
    <span>Nightline · Backed by a16z SpeedRun &amp; Dorm Room Fund</span>
  </div>
</div>
```

- [ ] **Step 3: Add login styles**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   LOGIN SHELL
   ============================================ */
.login-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  position: relative;
}
.login-shell__brand {
  position: absolute;
  top: 24px; left: 24px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.login-shell__card {
  width: 100%;
  max-width: 380px;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 32px;
}
.login-shell__title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(1.6rem, 1.5vw + 1rem, 2.1rem);
  letter-spacing: -0.015em;
  margin-bottom: 6px;
}
.login-shell__subtitle {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 24px;
}
.login-shell__form { display: flex; flex-direction: column; gap: 14px; }
.login-shell__quote {
  position: absolute;
  bottom: 24px;
  text-align: center;
  width: 100%;
  left: 0;
}
.login-shell__quote p {
  font-family: var(--font-display);
  font-style: italic;
  color: var(--text-secondary);
  font-size: 0.95rem;
}
.login-shell__quote span {
  color: var(--text-tertiary);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  display: block;
  margin-top: 6px;
}
```

- [ ] **Step 4: Type-check, build, manual visual check**

```bash
pnpm exec tsc --noEmit
pnpm dev
# Visit http://localhost:3000/login, confirm brand mark top-left, centered card, quote bottom
```

- [ ] **Step 5: Update login E2E selectors if needed**

Check `frontend/e2e/auth.spec.ts` (or equivalent). If selectors reference old form structure, update them.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/login/page.tsx frontend/src/app/styles.css frontend/e2e/
git commit -m "feat(login): v3 redesign — branded shell + editorial quote"
```

### Task 13: Redesign Dashboard page (broker view)

**Files:**
- Modify: `frontend/src/app/dashboard/page.tsx`

- [ ] **Step 1: Identify the broker view section**

Search the file for the broker portfolio render block. Preserve all data-fetching `useEffect` and state.

- [ ] **Step 2: Replace the page render with new structure**

The dashboard should render as:

```tsx
import { PageHeader } from "@/components/ui/PageHeader";
import { StatStrip } from "@/components/ui/StatStrip";
import { StatTile } from "@/components/ui/StatTile";
import { TriageRow, TriageRowHeader } from "@/components/ui/TriageRow";

// Inside the broker view JSX:
<div className="dashboard">
  <PageHeader
    eyebrow={`Portfolio · ${venues.length} venues`}
    title="The Book"
  />

  <StatStrip className="dashboard__stats">
    <StatTile label="Avg Risk Score" value={avgScore} unit="/100" tier="a" delta={scoreDelta} />
    <StatTile label="Open Claims" value={openClaims} tier={openClaims > 0 ? "c" : "neutral"} />
    <StatTile label="Renewing in 30d" value={renewingSoon} tier={renewingSoon > 0 ? "c" : "neutral"} />
    <StatTile label="Urgent Alerts" value={urgentCount} tier={urgentCount > 0 ? "d" : "neutral"} />
  </StatStrip>

  <section className="dashboard__table" aria-label="Venue triage">
    <TriageRowHeader />
    {venues.map((v) => (
      <TriageRow
        key={v.id}
        href={`/risk-profile/${v.id}`}
        name={v.name}
        context={v.address}
        score={v.total_score}
        tier={v.tier as Tier}
        premium={formatPremium(v.premium)}
        renewal={formatRenewal(v.renewal_date)}
        flag={v.has_degraded_infra ? { tone: "danger", label: "infra" } : v.current_capacity > v.capacity * 0.95 ? { tone: "danger", label: "capacity" } : undefined}
      />
    ))}
  </section>
</div>
```

Compute `avgScore`, `scoreDelta`, `openClaims`, `renewingSoon`, `urgentCount` from the existing fetched state.

- [ ] **Step 3: Add dashboard CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   DASHBOARD
   ============================================ */
.dashboard { padding: 20px 24px; max-width: 1200px; }
.dashboard__stats { margin-bottom: 18px; }
.dashboard__table { margin-top: 8px; }
@media (max-width: 640px) {
  .dashboard { padding: 16px; }
}
```

- [ ] **Step 4: Remove old VenuePortfolioCard / grid markup**

Delete any leftover `.lc-vcard`, `.lc-triage__row`, or portfolio-grid JSX that the new components replace. Grep first:

```bash
grep -n "lc-vcard\|lc-triage\|VenuePortfolio" frontend/src/app/dashboard/page.tsx
```

- [ ] **Step 5: Type-check, build, visual check**

```bash
pnpm exec tsc --noEmit
pnpm exec next build
pnpm dev
# Visit http://localhost:3000/dashboard, confirm stat strip + triage table
```

- [ ] **Step 6: Update E2E selectors**

Grep `frontend/e2e/` for old selectors and update to use new class names (`.triage-row`, `.stat-tile`, `.page-header__title`).

```bash
grep -rn "lc-vcard\|lc-triage" frontend/e2e/
```

Update each match to the new selector. Run `pnpm test:e2e` to confirm tests pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/dashboard/ frontend/src/app/styles.css frontend/e2e/
git commit -m "feat(dashboard): v3 redesign — bento stat strip + TriageRow table"
```

### Task 14: Redesign Risk Profile page

**Files:**
- Modify: `frontend/src/app/risk-profile/[venueId]/page.tsx`

- [ ] **Step 1: Read existing page structure**

Run: `wc -l frontend/src/app/risk-profile/[venueId]/page.tsx`
Skim the file to identify: data fetch, score display, factor breakdown, premium quote section.

- [ ] **Step 2: Replace page header and top stats**

Wrap the page with `PageHeader` and `StatStrip`:

```tsx
<div className="risk-profile">
  <PageHeader
    eyebrow={`Risk Profile · ${venue.venue_type}`}
    title={venue.name}
    subtitle={venue.address}
    actions={<Button variant="secondary">Export PDF</Button>}
  />

  <StatStrip>
    <StatTile label="Total Score" value={venue.total_score} unit="/100" tier={tierFromScore(venue.total_score)} />
    <StatTile label="Tier" value={venue.tier} tier={venue.tier.toLowerCase() as TierLevel} />
    <StatTile label="Annual Premium" value={formatPremium(quote.annual_premium)} tier="neutral" />
    <StatTile label="Market Savings" value={`${quote.savings_pct ?? 0}%`} tier={quote.savings_pct ? "a" : "neutral"} />
  </StatStrip>

  {/* existing factor breakdown + premium detail sections — wrap each in <section className="risk-profile__section"> */}
</div>
```

- [ ] **Step 3: Add risk-profile CSS**

Append to `frontend/src/app/styles.css`:
```css
/* ============================================
   RISK PROFILE PAGE
   ============================================ */
.risk-profile { padding: 20px 24px; max-width: 1200px; }
.risk-profile__section {
  margin-top: 20px;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: 18px;
}
.risk-profile__section-title {
  font-family: var(--font-body);
  font-size: 0.78rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-secondary);
  margin-bottom: 14px;
}
```

Within the file, replace any existing section headers with `<h4 className="risk-profile__section-title">...</h4>`.

- [ ] **Step 4: Replace factor cards with StatTile usage where possible**

If factor breakdown uses bespoke cards, replace each with a `<StatTile>` using `tier={factorTier(factor.score)}`.

- [ ] **Step 5: Build, visual check**

```bash
pnpm exec next build
pnpm dev
# Visit a risk profile URL, confirm header + stat strip + sections
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/risk-profile/ frontend/src/app/styles.css
git commit -m "feat(risk-profile): v3 redesign — PageHeader + StatStrip + sectioned layout"
```

### Task 15: Redesign Terminal / Operator floor page

**Files:**
- Modify: `frontend/src/app/terminal/[venueId]/page.tsx`

- [ ] **Step 1: Identify the operator hero + secondary cards**

The recent commit `b99c1a5` redesigned this page already. Confirm structure with:
```bash
grep -n "lc-" frontend/src/app/terminal/\[venueId\]/page.tsx | head -20
```

- [ ] **Step 2: Replace the page header with `PageHeader`**

Add at top of return JSX:
```tsx
<PageHeader
  eyebrow="Operator Floor · Live"
  title={venue.name}
  subtitle={`${venue.current_capacity}/${venue.capacity} · updated ${ago(lastUpdate)}`}
/>
```

- [ ] **Step 3: Replace top hero stat cards with `StatStrip`**

```tsx
<StatStrip>
  <StatTile label="Capacity" value={`${capacityPct}%`} tier={capacityPct > 95 ? "d" : capacityPct > 80 ? "c" : "a"} />
  <StatTile label="Infra Status" value={infraOk ? "OK" : "Degraded"} tier={infraOk ? "a" : "d"} />
  <StatTile label="Compliance Queue" value={complianceQueue.length} tier={complianceQueue.length > 0 ? "c" : "a"} />
  <StatTile label="Premium Impact" value={formatPremiumDelta(premiumImpact)} tier={premiumImpact > 0 ? "c" : "a"} />
</StatStrip>
```

- [ ] **Step 4: Build + commit**

```bash
pnpm exec next build
git add frontend/src/app/terminal/ frontend/src/app/styles.css
git commit -m "feat(terminal): v3 PageHeader + StatStrip on operator floor"
```

---

## Phase 5: Tier 2 Page Component Swaps

### Task 16: Refresh Venues list page

**Files:**
- Modify: `frontend/src/app/venues/page.tsx`

- [ ] **Step 1: Replace page header with `<PageHeader>`**

Add at top of return:
```tsx
<PageHeader eyebrow={`Portfolio · ${venues.length} venues`} title="Venues" />
```

- [ ] **Step 2: Replace existing venue list/table with `<TriageRow>` mapping**

Wrap in `<TriageRowHeader />` followed by `.map(v => <TriageRow ... />)`.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/app/venues/page.tsx
git commit -m "feat(venues): swap to TriageRow + PageHeader"
```

### Task 17: Refresh Incidents page

**Files:**
- Modify: `frontend/src/app/incidents/page.tsx`

- [ ] **Step 1: Add `<PageHeader>` and `<StatStrip>`**

```tsx
<PageHeader eyebrow={`Incidents · ${incidents.length} total`} title="Incidents" />
<StatStrip>
  <StatTile label="Open" value={openCount} tier={openCount > 0 ? "c" : "a"} />
  <StatTile label="Critical" value={criticalCount} tier={criticalCount > 0 ? "d" : "neutral"} />
  <StatTile label="Resolved This Week" value={resolvedCount} tier="a" />
</StatStrip>
```

- [ ] **Step 2: Replace status labels with `<StatusPill>`**

For each incident row, where the existing markup shows status as colored text, replace with:
```tsx
<StatusPill tone={incident.status === "open" ? "warning" : incident.status === "critical" ? "danger" : "success"}>
  {incident.status}
</StatusPill>
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/app/incidents/
git commit -m "feat(incidents): PageHeader + StatStrip + StatusPill"
```

### Task 18: Refresh Compliance page

**Files:**
- Modify: `frontend/src/app/compliance/page.tsx`

- [ ] **Step 1: Add `<PageHeader>` + `<StatStrip>`**

```tsx
<PageHeader eyebrow={`Compliance · ${items.length} checklist items`} title="Compliance" />
<StatStrip>
  <StatTile label="Complete" value={`${completePct}%`} tier={completePct >= 90 ? "a" : completePct >= 60 ? "c" : "d"} />
  <StatTile label="Overdue" value={overdueCount} tier={overdueCount > 0 ? "d" : "neutral"} />
  <StatTile label="Due This Week" value={dueSoonCount} tier={dueSoonCount > 0 ? "c" : "neutral"} />
</StatStrip>
```

- [ ] **Step 2: Replace status badges on each row with `<StatusPill>` and `<TierBadge>` as appropriate**

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/app/compliance/
git commit -m "feat(compliance): PageHeader + StatStrip + StatusPill"
```

### Task 19: Refresh Claims page

**Files:**
- Modify: `frontend/src/app/claims/page.tsx`

- [ ] **Step 1: Add `<PageHeader>` + `<StatStrip>`**

```tsx
<PageHeader eyebrow={`Claims · ${claims.length} packets`} title="Claims" />
<StatStrip>
  <StatTile label="In Review" value={inReviewCount} tier="c" />
  <StatTile label="Approved" value={approvedCount} tier="a" />
  <StatTile label="Denied" value={deniedCount} tier="d" />
</StatStrip>
```

- [ ] **Step 2: Replace claim status labels with `<StatusPill>`**

- [ ] **Step 3: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add frontend/src/app/claims/
git commit -m "feat(claims): PageHeader + StatStrip + StatusPill"
```

---

## Phase 6: Verification & Cleanup

### Task 20: Tier 3 page sweep — confirm inherit-only pages look right

**Files:**
- Verify (no code changes expected): `frontend/src/app/alerts/page.tsx`, `evals/page.tsx`, `underwriter/page.tsx`, `settings/page.tsx`

- [ ] **Step 1: Start dev server and visit each Tier 3 page**

```bash
pnpm dev
```

Visit `/alerts`, `/evals`, `/underwriter`, `/settings`. Confirm: sidebar is the new named sidebar, fonts/colors match v3, no broken card backgrounds.

- [ ] **Step 2: For any page showing visual regressions, add a `PageHeader` only**

Minimal change — wrap the existing page content with:
```tsx
<PageHeader eyebrow="..." title="..." />
```

Don't redesign the body. Keep this purely additive.

- [ ] **Step 3: Commit any fixes**

```bash
git add frontend/src/app/alerts/ frontend/src/app/evals/ frontend/src/app/underwriter/ frontend/src/app/settings/
git commit -m "feat(tier3): add PageHeader to inherit-only pages where missing"
```

### Task 21: Full E2E test sweep

**Files:**
- Modify (selectors only, if needed): `frontend/e2e/*.spec.ts`

- [ ] **Step 1: Run full E2E suite**

```bash
cd frontend
pnpm test:e2e
```

- [ ] **Step 2: For each failure, identify the cause**

Most failures will be: old selectors (`.lc-vcard`, `.lc-triage`, etc.) referencing markup that was replaced. Update each selector to the new class.

Mapping reference:
- `.lc-vcard` → `.triage-row`
- `.lc-triage__row` → `.triage-row`
- Portfolio grid stat → `.stat-tile`
- Page title heading → `.page-header__title`

- [ ] **Step 3: Re-run until green**

```bash
pnpm test:e2e
```

- [ ] **Step 4: Commit selector fixes**

```bash
git add frontend/e2e/
git commit -m "test(e2e): update selectors for v3 component markup"
```

### Task 22: Visual regression screenshots

**Files:**
- Use existing: `frontend/screenshot-dashboard.mjs`, `screenshot-login.mjs`, `screenshot-operator.mjs`

- [ ] **Step 1: Run the existing screenshot scripts**

```bash
cd frontend
node screenshot-login.mjs
node screenshot-dashboard.mjs
node screenshot-operator.mjs
```

- [ ] **Step 2: Manually inspect the captured PNGs**

Open each output PNG. Check:
- Login: brand top-left, centered card, editorial quote at bottom
- Dashboard: named sidebar, eyebrow + serif "The Book" title, fused stat strip, triage table
- Operator: named sidebar, serif venue name, status strip, no chunky cards

- [ ] **Step 3: If anything looks off, capture the issue in a follow-up task list**

For any issue, write a one-line description in `docs/superpowers/plans/2026-05-20-design-system-v3-followups.md`. Do NOT block this plan on cosmetic touch-ups — the design system is done; followups are polish.

- [ ] **Step 4: Final commit**

```bash
git add frontend/*.png docs/superpowers/plans/
git commit -m "chore(design): capture v3 visual baseline screenshots"
```

---

## Done Criteria

- All 22 tasks committed
- `pnpm exec tsc --noEmit` passes
- `pnpm exec next build` passes
- `pnpm test:e2e` passes
- The four Tier 1 pages (login, dashboard, risk profile, terminal) visually match the design spec
- The four Tier 2 pages use `PageHeader` + `StatStrip` + `StatusPill`/`TierBadge`
- Sidebar shows named section groups on desktop, icon rail on tablet, drawer on mobile
- Green (`--brand-primary`) appears only on logo, primary CTA, and score highlights — never as status indicator
