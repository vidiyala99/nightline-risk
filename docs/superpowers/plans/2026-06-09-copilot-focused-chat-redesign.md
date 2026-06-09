# Copilot Focused-Chat Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the operator `/copilot` page into a focused single-column chat — slim header, centered ~720px column, sticky bottom composer, lighter bubbles — without changing any behavior, theme, or backend.

**Architecture:** Pure presentational change across three files: `page.tsx` (header), `CopilotPanel.tsx` (bubble markup + empty-state copy), and the `.copilot*` block in `styles.css` (layout + bubble styling). No state/logic/API changes. Spec: `docs/superpowers/specs/2026-06-09-copilot-focused-chat-redesign.md`.

**Tech Stack:** Next.js (App Router) client component, plain CSS with existing design tokens (`--bg-base`, `--text-primary`, `--accent-ink`, `--radius-*`, `--space-*`).

**Note on testing:** This is a layout/CSS change with no new logic, so verification is **type-check + lint + manual visual walk**, not unit tests (there is no unit-testable behavior here, and the component's behavior is unchanged). Each task ends with `tsc`/`lint` green and a commit; the final task does the visual walk.

---

### Task 1: Slim header + move the promise copy into the empty state

**Files:**
- Modify: `frontend/src/app/copilot/page.tsx`
- Modify: `frontend/src/components/copilot/CopilotPanel.tsx` (empty-state lead text only)
- Modify: `frontend/src/app/styles.css` (add `.copilot-head*`)

- [ ] **Step 1: Replace the `PageHeader` with a slim header in `page.tsx`**

Remove the `PageHeader` import:

```diff
-import { PageHeader } from "@/components/ui/PageHeader";
 import { CopilotPanel } from "@/components/copilot/CopilotPanel";
```

Replace the returned markup's header block:

```tsx
  return (
    <div className="theme-venue copilot-page">
      <header className="copilot-head">
        <p className="copilot-head__eyebrow">Operator</p>
        <h1 className="copilot-head__title">Copilot</h1>
      </header>
      <CopilotPanel />
    </div>
  );
```

(The `<h1>` is kept for accessibility/landmark; it is just visually smaller than the old `PageHeader` title. The old subtitle string is intentionally dropped here — it reappears in Step 2's empty state.)

- [ ] **Step 2: Move the promise line into the empty state in `CopilotPanel.tsx`**

Replace the existing empty-state lead paragraph:

```tsx
            <p className="copilot__empty-lead">
              Grounded answers about your venue — exposure, risk, claims,
              compliance. Every reply cites its sources, and any action waits
              for your confirmation.
            </p>
```

(Replaces the current two-sentence lead. No other JSX changes in this task.)

- [ ] **Step 3: Add slim-header CSS in `styles.css`**

Insert immediately after the `.copilot-page { … }` rule (currently ends at the line with `padding: 0 clamp(20px, 4vw, 48px) 48px;` then `}`):

```css
.copilot-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-top: 8px;
  margin-bottom: 4px;
}
.copilot-head__eyebrow {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-ink);
}
.copilot-head__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
}
```

- [ ] **Step 4: Type-check and lint**

Run from `frontend/`:
```
npx tsc --noEmit
npm run lint
```
Expected: both clean (no errors referencing `copilot/page.tsx` or `CopilotPanel.tsx`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/copilot/page.tsx frontend/src/components/copilot/CopilotPanel.tsx frontend/src/app/styles.css
git commit -F - <<'EOF'
feat(copilot): slim page header, move promise copy into empty state

- Replace tall PageHeader with a compact eyebrow + h1
- Relocate the "grounded / cites sources / confirms actions" line to the empty state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Layout shell — centered column, scrolling log, sticky composer

**Files:**
- Modify: `frontend/src/app/styles.css` (`.copilot-page`, `.copilot`, `.copilot__log`, `.copilot__empty`, `.copilot__composer`)

**Approach:** Make the column narrower and let the transcript grow in normal document flow; pin the composer with `position: sticky; bottom: 0` and a solid background so the log scrolls *under* it. This avoids depending on `AppShell`'s exact height model (it scrolls at the page level).

- [ ] **Step 1: Narrow the page column**

Replace the `.copilot-page` rule:

```css
.copilot-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 clamp(20px, 4vw, 40px) 0;
}
```

- [ ] **Step 2: Convert the log from a bordered box to a growing transcript**

Replace the `.copilot__log` rule (currently a bordered, `max-height: 58vh`, `overflow-y: auto` surface box):

```css
.copilot__log {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 58vh;
  padding: 8px 0 16px;
}
```

(Removes the border, background, fixed max-height, and inner scroll. `min-height: 58vh` keeps the empty-state hero roughly centered. The page itself scrolls.)

- [ ] **Step 3: Keep the empty-state hero centered**

The existing `.copilot__empty` already uses `margin: auto` to center within the flex column — leave it. Just confirm it still reads centered against the new `min-height: 58vh` log (verified visually in Task 4).

- [ ] **Step 4: Pin the composer to the bottom**

Replace the `.copilot__composer` rule (currently `border-top` + `padding-top`):

```css
.copilot__composer {
  position: sticky;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0 16px;
  background: var(--bg-base);
  border-top: 1px solid var(--border-subtle);
}
```

(Solid `--bg-base` so the scrolling transcript passes cleanly behind it. The label + input row markup is unchanged.)

- [ ] **Step 5: Type-check, lint, commit**

Run from `frontend/`:
```
npx tsc --noEmit
npm run lint
```
Expected: clean.

```bash
git add frontend/src/app/styles.css
git commit -F - <<'EOF'
feat(copilot): centered column + scrolling transcript + sticky composer

- Narrow to ~720px; transcript grows in document flow
- Composer pinned to the bottom over a solid background

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Lighter bubbles — dark user bubble, borderless assistant answer

**Files:**
- Modify: `frontend/src/components/copilot/CopilotPanel.tsx` (remove `lc-card` from both bubbles)
- Modify: `frontend/src/app/styles.css` (`.copilot-bubble*`)

- [ ] **Step 1: Check for a dedicated dark-surface token (use it if present)**

Run from repo root:
```
grep -nE -- "--(ink|bg-inverse|surface-inverse|bg-dark)\b" frontend/src/app/styles.css | head
```
If a dark-surface token exists (e.g. `--bg-inverse`), use it for the user-bubble background in Step 3. If nothing matches, fall back to `var(--text-primary)` (near-black) with `var(--bg-base)` text — both already-defined tokens with strong contrast. **Do not introduce a new hex value.**

- [ ] **Step 2: Remove `lc-card` from the user bubble markup in `CopilotPanel.tsx`**

Replace the user-turn block:

```tsx
            <div key={i} className="copilot-turn copilot-turn--user">
              <div className="copilot-bubble copilot-bubble--user">
                <div className="copilot-bubble__inner">{m.text}</div>
              </div>
            </div>
```

- [ ] **Step 3: Remove `lc-card` from the assistant bubble markup in `CopilotPanel.tsx`**

Replace the assistant bubble's outer + inner wrapper (keep everything inside `copilot-bubble__inner` unchanged):

```tsx
              <div className="copilot-bubble copilot-bubble--assistant">
                <div className="copilot-bubble__inner">
```

(Only the two `className` strings change — `lc-card copilot-bubble …` → `copilot-bubble …`, and `lc-card__inner copilot-bubble__inner` → `copilot-bubble__inner`. The `<p>`, link, citations, proposal, and followups inside are untouched.)

- [ ] **Step 4: Style the two bubble variants in `styles.css`**

Replace the `.copilot-bubble` / `.copilot-bubble__inner` / `.copilot-bubble--user .copilot-bubble__inner` rules with:

```css
.copilot-bubble {
  max-width: 92%;
}
.copilot-bubble__inner {
  padding: 0;
}
/* User message: soft dark rounded bubble on the right. */
.copilot-bubble--user {
  max-width: 78%;
}
.copilot-bubble--user .copilot-bubble__inner {
  padding: 10px 14px;
  border-radius: 14px 14px 4px 14px;
  background: var(--text-primary);
  color: var(--bg-base);
  font-weight: 500;
  line-height: 1.5;
}
/* Assistant answer: borderless plain text on the left (no card). */
.copilot-bubble--assistant .copilot-bubble__inner {
  padding: 2px 0;
}
```

(If Step 1 found a dedicated dark token, use it in place of `var(--text-primary)` for `background` here.)

- [ ] **Step 5: Type-check, lint, commit**

Run from `frontend/`:
```
npx tsc --noEmit
npm run lint
```
Expected: clean.

```bash
git add frontend/src/components/copilot/CopilotPanel.tsx frontend/src/app/styles.css
git commit -F - <<'EOF'
feat(copilot): lighter bubbles — dark user, borderless assistant

- Drop lc-card from both bubbles
- User = dark rounded fill (right); assistant = plain text (left)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Visual polish pass (ui-ux-pro-max) + full verification

**Files:**
- Possibly Modify: `frontend/src/app/styles.css` (spacing/hierarchy tuning from the polish pass)

- [ ] **Step 1: Run the ui-ux-pro-max review on the implemented page**

Invoke the `ui-ux-pro-max` skill (action: review/improve) against the redesigned `/copilot` page — focus on spacing rhythm, the dark-bubble contrast (must be AA), interaction states (hover/focus on suggestions, followups, composer), and visual hierarchy between answer text / link / source chips. Apply only token-based tweaks (no new hex, no behavior change).

- [ ] **Step 2: Guard against e2e selector drift**

Run from repo root:
```
grep -rnE "lc-card|copilot" frontend/e2e/ || echo "no copilot e2e selectors"
```
If any Playwright spec pins a removed class (`lc-card` on a copilot element) or old header copy, update the selector to a stable one (role/text). If none, no action.

- [ ] **Step 3: Final type-check + lint**

Run from `frontend/`:
```
npx tsc --noEmit
npm run lint
```
Expected: both clean.

- [ ] **Step 4: Manual visual walk (use the `verify` or `run` skill / local browser-verify recipe)**

Start the app and sign in as the operator demo user, open `/copilot`, and confirm every state renders correctly under the new layout:
- Empty state: centered hero (eyebrow + h1 above, sparkle + promise line + 4 suggestion chips), composer pinned at the bottom.
- Send a question → user dark bubble on the right; assistant borderless answer on the left with link + source chip.
- A `propose_action` reply still shows the confirm/dismiss affordance; the compliance proposal still shows the file picker.
- Followup chips render; "Thinking…" pending indicator shows while awaiting; error alert renders on failure.
- Scroll a long transcript → composer stays pinned, content scrolls cleanly behind it; column stays centered at ~720px.

- [ ] **Step 5: Commit any polish changes**

```bash
git add frontend/src/app/styles.css
git commit -F - <<'EOF'
polish(copilot): spacing + contrast pass on the focused-chat layout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

(If Step 1 produced no changes, skip this commit.)

- [ ] **Step 6: Push**

```bash
git push origin main
```

---

## Self-Review

**Spec coverage:**
- Slim header / move subtitle → Task 1. ✓
- Centered ~720px column, full-height flex, sticky composer, scrolling log → Task 2. ✓
- Lighter bubbles (dark user / borderless assistant, remove lc-card) → Task 3. ✓
- Empty-state hero → copy in Task 1, centering in Task 2, verified Task 4. ✓
- Source chips kept, theme/behavior/backend unchanged → no task touches them (verified Task 4 walk). ✓
- Accessibility (h1 landmark, aria-live preserved, reduced-motion, ≥44px, AA contrast) → h1 in Task 1; aria-live/reduced-motion/44px untouched; AA contrast checked Task 3 Step 1 + Task 4 Step 1. ✓
- Verification (tsc, lint, e2e grep, manual) → Task 4. ✓
- ui-ux-pro-max pass → Task 4 Step 1. ✓
- Mobile = same column, no mobile screen → no task needed. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact diffs/CSS. ✓

**Type/class consistency:** Class names used in JSX (`copilot-bubble--user`, `copilot-bubble__inner`, `copilot-head__eyebrow`, `copilot-head__title`) match the CSS rules defined. ✓
