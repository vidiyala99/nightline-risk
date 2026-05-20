# Design System v3 — Editorial Dark + Bento Hybrid

**Date:** 2026-05-20
**Status:** Design approved, pending implementation plan
**Scope:** Comprehensive UI redesign — design tokens, app shell, core components, and Tier 1 pages

## Motivation

The current UI looks dev-built. We are pre-live and need the product to feel polished for three near-term audiences who will see it within 30 days: founders showing potential broker clients, investors during demos, and brokers using it daily. A page-by-page polish pass would leave seams; the foundation needs to be fixed first so every page (current and future) inherits a coherent, premium aesthetic.

The visual direction is **editorial dark + bento hybrid** — dark background (nightlife-native), Cormorant serif headlines (editorial credibility), bento-style stat tiles with semantic left-border color coding, and dense data presentation that signals "serious risk tool" rather than "generic SaaS dashboard."

## Design Principles

1. **Dark, but editorial.** The product serves nightlife operators and brokers — light mode would feel disconnected from the world. But dark must read as premium publication, not hacker terminal.
2. **Green is a brand moment, not a status color.** `#c8f000` is used only for the logo, primary CTAs, and score highlights. Status uses semantic colors (green/indigo/amber/red) tied to risk tiers.
3. **Tight, not chunky.** Hairline dividers over borders, fused stat strips over boxed cards, table rows directly on page background. Same content fits in ~25% less vertical space.
4. **Numbers are monospace.** Every score, price, percentage, and count uses JetBrains Mono so columns align and values feel precise.
5. **Display headlines are serif.** Page titles and venue names in hero context use Cormorant — signals editorial weight.
6. **Every page has the same skeleton.** Eyebrow label + serif headline + bento stat strip + content. Predictable, scannable, premium.

## Design Tokens

### Color

| Token | Value | Purpose |
|---|---|---|
| `--bg-dark` | `#08090e` | Page background |
| `--bg-base` | `#0e0f1a` | Page surface tier 1 |
| `--bg-surface` | `#13151f` | Card/component fills |
| `--bg-elevated` | `#1a1c2a` | Active nav, hover states |
| `--brand-primary` | `#c8f000` | Brand only — logo, primary CTA, score highlight |
| `--brand-secondary` | `#818cf8` | Tier B, info, secondary accents |
| `--tier-a` | `#22c55e` | Risk tier A, positive change |
| `--tier-b` | `#818cf8` | Risk tier B |
| `--tier-c` | `#f59e0b` | Risk tier C, warnings |
| `--tier-d` | `#f43f5e` | Risk tier D, critical |
| `--text-primary` | `#eeeef5` | Body text, values |
| `--text-secondary` | `#8b8fa8` | Labels, eyebrows |
| `--text-tertiary` | `#50526a` | Captions, table headers |

**Rule:** Green never appears as a status indicator. Tier A uses `#22c55e`. If something is "good," it uses the same green-A color, not the brand green.

### Typography

| Token | Family | Use |
|---|---|---|
| `--font-display` | Cormorant Garamond, 700 weight | Page titles, hero venue names |
| `--font-sans` | DM Sans | Body, nav, labels |
| `--font-mono` | JetBrains Mono | All numbers, codes, IDs |

Type scale (existing fluid scale stays — values already correct in `styles.css`).

### Spacing & Density

- Card padding: `12px–16px` (reduced from `16–24px`)
- Stat tile padding: `10px–12px`
- Table row padding: `8px` vertical, `0` horizontal (rows sit on page bg, not in cards)
- Stat tile strip: 1px hairline divider between tiles, no borders around the strip itself
- Border radius: `5–6px` (down from `8–10px`) — tighter, less rounded SaaS feel

## App Shell

**Named sidebar with section groups** — 180px wide on desktop, collapses to icon rail on tablet, hamburger overlay on mobile.

Structure:
```
[Logo + Wordmark]
─────────────────
PORTFOLIO
  ▣ The Book          ← active
  ⌂ Venues
─────────────────
OPERATIONS
  ⚑ Incidents    [2]  ← badge count
  ✓ Compliance
  ◈ Claims
─────────────────
[bottom]
  ⚙ Settings
```

Active item has left-border accent (`--brand-primary`) and elevated background. Badge counts use tier color (red for urgent).

Mobile bottom nav stays as-is; sidebar is hidden below 640px.

## Core Components

Eight components, defined once, used everywhere:

1. **`StatTile`** — bento stat with optional left-border color. Props: `label`, `value`, `tier?`, `delta?`. Used in stat strips at top of every page.
2. **`StatStrip`** — fuses 2–4 `StatTile`s into a single hairline-divided strip.
3. **`PageHeader`** — eyebrow label + serif H1. Props: `eyebrow`, `title`, `actions?`.
4. **`TriageRow`** — table row with venue context, score, tier badge, premium, renewal, action arrow. Collapses to stacked card on mobile.
5. **`TierBadge`** — small monospace badge (A/B/C/D) with semantic tier color.
6. **`Button`** — primary (green fill), secondary (outline), destructive (red tinted). 5px radius.
7. **`SidebarNavItem`** — icon + label + optional badge count. Active state styled per shell spec.
8. **`StatusPill`** — generic pill for non-tier statuses (Open, Resolved, In Review, etc.). Uses tier colors semantically.

Each component lives in `frontend/src/components/ui/` and consumes only design tokens — no inline values.

## Page Redesign Scope

**Tier 1 — Full redesign (demo-critical):**
- `login/page.tsx` — brand moment landing, not generic form
- `dashboard/page.tsx` — bento strip + triage table, the workhorse
- `risk-profile/[venueId]/page.tsx` — investor drill-down page
- `terminal/[venueId]/page.tsx` — broker triage console

**Tier 2 — Component refresh (uses new components, layout unchanged):**
- `venues/page.tsx`, `incidents/page.tsx`, `compliance/page.tsx`, `claims/page.tsx`

**Tier 3 — Shell inheritance only (auto-updates via design tokens):**
- `alerts/page.tsx`, `evals/page.tsx`, `underwriter/page.tsx`, `settings/page.tsx`

## Build Order

1. **Tokens** — update `frontend/src/app/styles.css` with new color, spacing, and radius values. No new variables needed; values change.
2. **Core components** — build the 8 components in `components/ui/`. Each is mobile-first.
3. **App shell** — rebuild `components/layout/AppShell.tsx` with named sidebar + section groups.
4. **Tier 1 pages** — redesign one at a time. Each consumes the new components.
5. **Tier 2 pages** — swap to new components.
6. **Tier 3 pages** — verify they look correct under new tokens; no bespoke work.

## Mobile / Responsive

- **< 640px:** Bottom nav stays. Sidebar becomes hamburger → overlay. Stat strips horizontal-scroll. Triage rows stack into cards.
- **640–1180px:** Sidebar collapses to icon-only rail (36px wide).
- **1180px+:** Full named sidebar (180px).

Components handle their own collapse; pages do not contain responsive branching.

## Out of Scope

- Storybook / component documentation site (defer)
- New iconography (use existing `lucide-react`)
- Animation system overhaul (keep existing 200ms cubic-bezier transitions)
- Camera/Alert WIP modules (separate workstream)
- Backend / API changes

## Success Criteria

- Every Tier 1 page passes a "would this look at home in an a16z portfolio company demo?" sniff test
- A new page built from the 8 core components requires zero bespoke CSS
- Mobile experience matches desktop in information density per scroll
- Green brand color appears < 5 times on any single page (logo, one CTA, score highlights only)
- The 25% vertical density gain demonstrated in the tight-vs-chunky mockup is achieved
