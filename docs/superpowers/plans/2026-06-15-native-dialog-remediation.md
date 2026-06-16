# Native-Dialog Remediation (broker placement flows) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD is mandatory (superpowers:test-driven-development) — pure helpers get a failing vitest spec first.

**Goal:** Replace every native browser dialog (`window.prompt` / `window.confirm` / `alert()`) in the broker placement flows with the in-app primitives the app already owns — `PromptDialog` (form input), a **new** `ConfirmDialog` (yes/no + destructive), and `toastError` (error reporting) — preserving the exact semantics of each site. The reported pain (`window.prompt` on **Bind**) ships first.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind v4. Tests: Vitest (pure helpers + component behaviour) + Playwright (E2E, against the deployed Vercel app). All frontend commands run from `frontend/`.

**Conventions (from CLAUDE.md + backlog):**
- Errors surface via `toastError` from `@/lib/toast` (`toastSuccess`/`toastError` already used elsewhere); always prefer the server message (`PlacementApiError.message`) over a generic string.
- Design system is mid-sweep ("Paper & Ink" on shadcn-style `ds/` primitives). The **migration rule**: a migrated component sets EXPLICIT color classes on every text element (never inherits) — legacy bare-element rules (`h1/p/a { color }`) beat *inherited* Tailwind color. `ds/` primitives live in `frontend/src/components/ds/` (`button`, `card`, `badge`, `input`, `label`, `skeleton`, `tier-badge`) and render Paper & Ink automatically off the re-themed tokens in `globals.css`.
- Pure helpers are unit-testable and tested first (see `components/ui/PromptDialog.test.ts` → `missingRequired`).
- E2E pins to **semantic role hooks** (`getByRole`), not legacy `.lc-*` classes.

---

## 1. Problem statement & why it matters

Broker-facing placement flows use **native browser dialogs** for data entry, confirmation, and error reporting. The trigger case: clicking **Bind** on a quote fires

```js
window.prompt("Carrier-issued policy number (optional — leave blank to assign later):", "")
```

an unstyled, browser-chrome dialog with no validation, no theming, and a jarring flow break — immediately followed by `alert(...)` on failure. This is the worst surface in the app for a professional broker tool, and it is inconsistent with the rest of the product.

Why it matters:

- **Broker UX / brand.** Native dialogs are OS-chrome, unbranded, and visually break the "Paper & Ink" identity the rest of the app is migrating toward. A broker binding a policy is at the highest-trust moment of the funnel; a raw `window.prompt` reads as unfinished.
- **Accessibility.** `window.prompt`/`confirm` give no field labels, no `aria-invalid`, no inline validation, no focus restoration. `ActionModal`/`PromptDialog` already provide a focus-trap, Escape handling, `role="dialog"`, labeled fields, and `role="alert"` validation messages.
- **Testability.** Playwright cannot reliably drive native `window.prompt`/`confirm` (they sit outside the page DOM; the only hook is a fragile `page.on("dialog")` handler). The bind flow is therefore effectively **un-E2E-tested today**. Migrating to in-DOM modals makes the bind/decline flows assertable with ordinary `getByRole` selectors — a real testability win, not just cosmetics.
- **Consistency.** `alert()` is used for error reporting in ~7 places while `toastError` is the house pattern everywhere else. One error channel, surfacing the real server message.

The app already has the right primitives — they are simply not wired into these flows. `policies/[pid]` is the reference for the *form* case (`PROMPT_CONFIG` + `<PromptDialog>`), but even it is only **half-migrated**: it still uses `window.confirm` for expire/reinstate and `alert()` for errors. This plan finishes that pattern and generalizes it.

---

## 2. Inventory of native-dialog sites

Grep verified (`window.prompt|window.confirm|alert(` across `frontend/src/app`). Target column: **P** = `PromptDialog`, **C** = new `ConfirmDialog`, **T** = `toastError`.

| File:line | Dialog | Semantics to PRESERVE | Target |
|---|---|---|---|
| `app/submissions/[sid]/page.tsx:460` `handleBind` | `prompt` policy number | **null = cancel (return); "" = explicit "assign later"** (`policy_number: trimmed \|\| undefined`). Optional field. On success `router.push(/policies/{id})`. | **P** (one optional text field) |
| `app/submissions/[sid]/page.tsx:472` | `alert` bind error | `PlacementApiError.message` else "Bind failed" | **T** |
| `app/submissions/[sid]/page.tsx:376` `handleRecordResponse` (decline) | `prompt` decline reason | **REQUIRED** (`if (!reason \|\| !reason.trim()) return`). 'quoted' branch is untouched (no dialog). | **P** (one required textarea) |
| `app/submissions/[sid]/page.tsx:385` | `alert` decline record error | `PlacementApiError.message` else "Record failed" | **T** |
| `app/submissions/[sid]/page.tsx:403` | `alert` quoted record error | message else "Record failed" | **T** |
| `app/submissions/[sid]/page.tsx:439` `handleSelect` | `alert` select error | message else "Select failed" | **T** |
| `app/submissions/page.tsx:209` `handleOutcome` | `prompt` reason | **REQUIRED** (`if (!reason \|\| !reason.trim()) return`). One handler, 3 outcomes (lost/declined/withdrawn) → distinct API calls; dialog title must carry the verb + venue. | **P** (required textarea; title from `OUTCOME_VERB`) |
| `app/submissions/page.tsx:220` | `alert` outcome error | message else `${verb} failed` | **T** |
| `app/policy-requests/page.tsx:77` `decide` (declined) | `prompt` decline reason | **OPTIONAL** — `null = cancel (return)`; `"" → note = undefined`. Approve branch has no dialog. | **P** (optional textarea) |
| `app/compliance/page.tsx:148` `handleWaive` | `prompt` waive reason | **OPTIONAL** — `null = cancel`; empty → `reason: null`. | **P** (optional textarea) |
| `app/compliance/[venueId]/[itemId]/page.tsx:130` `handleWaive` | `prompt` waive reason | Same semantics as above (the detail-route twin). | **P** (optional textarea) |
| `app/coverage/page.tsx:89` `onCancelRequest` | `confirm` "Withdraw this request?" | Yes/no, non-destructive (withdraw an operator request). | **C** |
| `app/incidents/[id]/page.tsx:366` `handleEvidenceDelete` | `confirm` delete evidence | Yes/no, **DESTRUCTIVE** ("can't be undone (removal is logged)"). Errors already use `toastError`. | **C** (destructive) |
| `app/policies/[pid]/page.tsx:161` `handleEndOfLife("expire")` | `confirm` expire | Yes/no, **terminal** ("This is terminal."). | **C** (destructive) |
| `app/policies/[pid]/page.tsx:167` | `alert` expire error | `PlacementApiError.message` else "expire failed" | **T** |
| `app/policies/[pid]/page.tsx:196` `runPrompt` | `alert` action error | message else "Action failed" | **T** |
| `app/policies/[pid]/page.tsx:204` `handleReinstate` | `confirm` reinstate | Yes/no, non-destructive (lapsed → active). | **C** |
| `app/policies/[pid]/page.tsx:210` | `alert` reinstate error | message else "Reinstate failed" | **T** |
| `components/claims/ActionModal.tsx:76` `attemptClose` | `confirm` "Discard your changes?" | Internal guard (guard-dismiss-on-unsaved). **DECISION below — keep for now.** | — (see §4) |

**Decision on `ActionModal:76`:** the guard-dismiss `window.confirm` is an *internal* implementation detail of the modal scaffold, fired only on an unsaved-state dismiss attempt. Replacing it with a `ConfirmDialog` means nesting a modal inside a modal (two scrims, two focus traps) — a worse pattern than the native confirm it replaces. **Keep it for this work**, and add a small follow-up (§7 Risks) to swap it for an inline two-button "Discard / Keep editing" footer state *inside* the existing modal (no second modal) if we want to kill the last `window.confirm`. It is out of scope for the placement-flow remediation.

---

## 3. New `ConfirmDialog` — API & location

`PromptDialog` covers form INPUT. The `window.confirm` sites need a sibling for yes/no + destructive confirmation. Build it on the same `ActionModal` scaffold so it inherits the scrim / focus-trap / Escape / body-lock for free.

**Location:** `frontend/src/components/ui/ConfirmDialog.tsx` (sibling of `PromptDialog.tsx`). Test: `frontend/src/components/ui/ConfirmDialog.test.tsx`.

**API:**

```ts
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy — the question / consequences. */
  body?: React.ReactNode;
  confirmLabel?: string;        // default "Confirm"
  cancelLabel?: string;         // default "Cancel"
  /** Red confirm button + destructive framing. Default false. */
  destructive?: boolean;
  /** Disables both buttons + shows a working label on confirm. */
  busy?: boolean;
  /** May be async; the caller flips `busy` while it runs. */
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}
```

Behaviour (mirrors `PromptDialog`):
- Renders `<ActionModal open title onClose busy>` — **`guardDismiss={false}`** (a confirm holds no typed state, so Escape / scrim click should just cancel; no "discard changes?" prompt).
- Body region renders `body` (string or node) with an explicit text color (`text-foreground` / `text-muted-foreground`).
- Footer: a Cancel button + a Confirm button. When `destructive`, the confirm button uses the destructive variant.
- `busy` disables both buttons and the confirm shows "Working…".
- **`onConfirm` is NOT auto-closed** — the caller closes on success (so a failed async action keeps the dialog open and can surface a `toastError`), exactly like `PromptDialog.onSubmit`. Document this in a header comment.

**Styling decision — build `ConfirmDialog` directly on `ds/` primitives (Button), NOT legacy `btn`.** It is brand-new code with no legacy footprint, so there is no reason to incur `btn`/`input-field` debt:
- Confirm → `<Button variant={destructive ? "destructive" : "default"} size="sm">`.
- Cancel → `<Button variant="outline" size="sm">`.
- All body/text elements carry explicit color classes (migration rule).

This makes `ConfirmDialog` the first fully-`ds/` modal and the template for migrating `PromptDialog` (Phase 0b).

---

## 4. Decision: migrate the shared modals (`PromptDialog`, `ActionModal`) to `ds/`?

**Decision: YES — migrate `PromptDialog`'s field/footer styling to `ds/` as part of Phase 0 (0b), and leave `ActionModal`'s scaffold CSS as-is.**

Rationale:
- `PromptDialog` and `ActionModal` are **shared and already consumed by a migrated page** (`policies/[pid]`, which explicitly notes "Shared PromptDialog + ClaimStatusPill are kept as-is"). As more pages migrate and more flows route through these modals, the legacy `btn` / `input-field` / `text-secondary` / `submission-wizard__*` classes inside `PromptDialog` become a visible polished-page → rough-modal jump — the exact "broken" feeling the backlog flags for the list→detail case. Since Phase 1+ wires `PromptDialog` into the highest-trust broker flow (bind), the modal's chrome should match.
- The change is **low-risk and self-contained**: swap the field primitives to `ds/` (`Input`/`Label`/`Button`, `<textarea>`/`<select>` styled with the same token classes as `input.tsx`) and put explicit color classes on labels/help/error text. No behaviour change — `missingRequired`, the open/reset effect, and the submit/validation flow are untouched, so the existing `PromptDialog.test.ts` stays green.
- **`ActionModal` scaffold (scrim/header/body) stays legacy for now.** Its `claim-modal*` CSS is shared by the claims modal family and renders fine; restyling the scaffold is a larger, separate sweep item (it owns the `window.confirm` guard too). Migrating the scaffold here would balloon scope and risk the claims surfaces. Defer to the end-of-sweep modal pass.

Net: after Phase 0, `ConfirmDialog` is pure `ds/`, `PromptDialog`'s *contents* are `ds/`, both sit on the still-legacy `ActionModal` shell. Consistent enough that no flow shows mixed chrome; the residual scaffold migration is tracked as a follow-up.

---

## 5. Phased task breakdown (independently shippable)

Each phase is its own PR, green on `npx vitest run` + `npx eslint .` + `npx next build` before merge (+ Playwright where noted). Run `ui-ux-pro-max` before the visual work in Phase 0.

### Phase 0 — `ConfirmDialog` + shared-modal `ds/` migration (foundation; no flow behaviour change)

**0a. `ConfirmDialog`**
- Files: create `frontend/src/components/ui/ConfirmDialog.tsx`; create `frontend/src/components/ui/ConfirmDialog.test.tsx`.
- **TDD test list** (write first, RED → GREEN):
  - `does not render when open=false` (returns null via ActionModal).
  - `renders title + body + confirm/cancel labels (defaults "Confirm"/"Cancel")`.
  - `clicking confirm calls onConfirm; clicking cancel calls onClose`.
  - `destructive renders the destructive Button variant` (assert class/`data-slot` or accessible name; pin to a stable hook, not the raw Tailwind class).
  - `busy disables both buttons and shows the working label`.
  - `does NOT auto-close on confirm` (onClose not called when only onConfirm fires) — locks the "caller closes on success" contract.
  - *(Optional, if a pure helper is extracted)* a `confirmLabels(props)` pure function returning resolved labels — unit-test it like `missingRequired`. Only extract if it removes real branching; don't over-engineer.
- Acceptance: new file renders a themed modal; all tests green; `eslint`/`build` clean. No site wired yet.

**0b. `PromptDialog` contents → `ds/`**
- Files: modify `frontend/src/components/ui/PromptDialog.tsx`.
- Swap `btn`/`input-field`/`text-secondary`/`submission-wizard__*` for `ds/` `Input`/`Label`/`Button` + token classes; explicit colors on label/help/error; keep the `aria-invalid` + `role="alert"` wiring.
- **TDD:** existing `PromptDialog.test.ts` (`missingRequired`) must stay green untouched (proof the pure logic is unchanged). No new behaviour to test here; this is a styling swap guarded by the existing unit test + visual check + `policies/[pid]` smoke (it already consumes `PromptDialog`).
- Acceptance: `policies/[pid]` prompts (assign/cancel/non-renew/lapse) render in Paper & Ink; `missingRequired` test green; `build` clean.

> Phase 0 ships alone (pure additive infra). Nothing downstream is blocked from review.

### Phase 1 — Bind flow (PRIORITY — the reported pain) — `app/submissions/[sid]/page.tsx`

- Files: modify `app/submissions/[sid]/page.tsx`. Optionally add `e2e/placement-bind.spec.ts` (+ a `SubmissionDetailPage` page-object if one doesn't exist).
- Wire `handleBind` to a `<PromptDialog>` with a single **optional** text field `policy_number` (placeholder `BW-2026-00123`, help "Leave blank to assign later"). Preserve semantics precisely:
  - Open dialog (store the pending `quote`) instead of `window.prompt`.
  - On submit: `policiesApi.bindQuote(quote.id, { policy_number: values.policy_number.trim() || undefined })`. Blank submit = "assign later" (the `|| undefined`); the dialog's Cancel/close = the old `null` cancel path (no API call). This faithfully maps the null-vs-empty contract.
  - On success: close dialog, `router.push(/policies/{id})`.
  - On error: `toastError(e instanceof PlacementApiError ? e.message : "Bind failed")` (replaces the `alert`). Keep the dialog open so the broker can retry.
- Use a `busy` state on the dialog during the bind call.
- **TDD test list:**
  - *(Unit, optional)* if any pure mapping helper is extracted (e.g. `policyNumberArg(value) → string | undefined`), unit-test the trim/empty→undefined rule.
  - *(E2E)* `e2e/placement-bind.spec.ts`: broker logs in → opens a bindable submission → clicks **Bind** → asserts the in-DOM dialog (`getByRole("dialog")` / heading) → submits blank → asserts navigation to `/policies/…`. Tolerant-empty pattern (skip if no bindable quote in the demo book), mirroring `renewals.spec.ts`. **This is net-new coverage** — the native-prompt bind flow had none.
- Acceptance: no `window.prompt`/`alert` left in `handleBind`; blank-submit assigns later, Cancel makes no API call, error toasts the server message; E2E green (or correctly skips on an empty demo book); `eslint`/`build`/`vitest` clean.

### Phase 2 — Decline reason (submission detail + submissions list)

- Files: `app/submissions/[sid]/page.tsx` (`handleRecordResponse` decline branch + the two `alert`s at 385/403 + `handleSelect` 439), `app/submissions/page.tsx` (`handleOutcome` 209 + `alert` 220).
- Detail `handleRecordResponse(declined)`: `<PromptDialog>` with one **required** textarea `decline_reason`. Quoted branch untouched. Replace the three `alert`s in this file (385/403/439) with `toastError(message else "<verb> failed")`.
- List `handleOutcome`: `<PromptDialog>` with one **required** textarea `reason`; title carries `OUTCOME_VERB[outcome]` + venue (e.g. "Mark declined — submission for {venue_id}"); on submit call the matching `lose/decline/withdraw` API; `alert` → `toastError`.
- **TDD test list:**
  - *(Unit)* `missingRequired` already covers required-blank → blocked submit (the shared guard); no new pure logic unless a verb→title/`apiCall` map is extracted, in which case unit-test the mapping.
  - *(E2E, optional)* extend `broker-surfaces.spec.ts` to open a decline dialog and assert the required-field block (submit with empty reason keeps the dialog open / shows the `role="alert"` "Required."), then a filled submit closes it. Keep tolerant-empty.
- Acceptance: decline requires a reason via the in-DOM dialog (no native prompt); all `alert`s in both files gone; errors toast server messages; gates green.

### Phase 3 — Optional-reason prompts (policy-requests + compliance ×2)

- Files: `app/policy-requests/page.tsx:77`, `app/compliance/page.tsx:148`, `app/compliance/[venueId]/[itemId]/page.tsx:130`.
- Each → `<PromptDialog>` with one **optional** textarea. Preserve: Cancel/close = the old `null`-cancel (no API call); empty submit → the old empty-string path (`note = undefined` for policy-requests; `reason: null` for compliance). The two compliance sites share identical copy/semantics — use the same field config (consider a tiny shared const, but don't force a premature abstraction across two files).
- Errors: policy-requests already routes to `setError`; compliance already uses `toastError` — keep those, no `alert` here.
- **TDD:** rely on the shared `PromptDialog`/`missingRequired` coverage (optional field → never blocks). Add a component/E2E assertion only if cheap; these are low-risk.
- Acceptance: three optional-reason prompts run in-DOM with the null-vs-empty contract intact; gates green.

### Phase 4 — Confirm sites (coverage + incidents + policies expire/reinstate)

- Files: `app/coverage/page.tsx:89`, `app/incidents/[id]/page.tsx:366`, `app/policies/[pid]/page.tsx` (161 expire, 204 reinstate; + the three `alert`s 167/196/210).
- `coverage` withdraw → `<ConfirmDialog>` (non-destructive, "Withdraw request").
- `incidents` delete-evidence → `<ConfirmDialog destructive>` ("Delete evidence", body = the "can't be undone (logged)" copy). Errors already `toastError`.
- `policies/[pid]` expire → `<ConfirmDialog destructive>` ("Mark expired", terminal copy); reinstate → `<ConfirmDialog>` (non-destructive). Replace `alert` at 167/196/210 with `toastError(message else "<action> failed")`. **This fully finishes the half-migrated reference page** (no `window.confirm`/`alert` left in it).
- Each handler: open the confirm (store pending target where needed), run the API in `onConfirm` with a `busy` flag, close on success, `toastError` on failure.
- **TDD test list:**
  - *(Component)* `ConfirmDialog.test.tsx` from Phase 0 already covers confirm/cancel/destructive/busy/no-auto-close — the behavioural contract these sites depend on.
  - *(E2E, optional)* an incidents/policies spec asserting the destructive confirm opens and a Cancel makes no state change. Keep tolerant-empty.
- Acceptance: zero `window.confirm`/`alert` remain in these four files; destructive sites visually distinct; `policies/[pid]` is fully native-dialog-free; gates green.

### Phase 5 — Sweep & wrap-up

- **Verify:** `rg "window\.prompt|window\.confirm|alert\(" frontend/src/app` returns **only** any intentionally-deferred site (none expected in `app/`); `ActionModal:76` is the single remaining `window.confirm` (internal guard, tracked as follow-up).
- Run full `npx vitest run`, `npx eslint .`, `npx next build`, and the Playwright suite (deployed app, with the redeploy warm-up).
- Update `docs/backlog.md` "Recently shipped": native-dialog remediation complete (bind/decline/optional-reason/confirms migrated to `PromptDialog`/`ConfirmDialog`/`toastError`), note the `ActionModal` guard-confirm follow-up.

---

## 6. Risks / edge cases

- **null-vs-empty semantics regression (bind, policy-requests, compliance).** The native prompt encodes *cancel* and *empty* as two distinct outcomes; the dialog encodes them as *close* vs *submit-blank*. Map them explicitly per §5 and assert with the inventory table — the single highest-risk regression. Reviewer checklist item per site.
- **Required-vs-optional drift.** Decline/lose reasons are REQUIRED; waive/policy-request-decline are OPTIONAL. The `required` flag on the field is the only thing enforcing this — copy it straight from the table; `missingRequired` enforces required, and optional must NOT block.
- **Focus management.** `ActionModal` focuses the first focusable element on open and locks body scroll. `ConfirmDialog` has no input, so first-focus lands on the Cancel button (acceptable; avoids a destructive default-focus). Confirm focus restoration to the trigger is "managed by the calling page's ref pattern" per `ActionModal`'s doc — for these call sites the trigger is a row/menu button; restoring focus isn't currently wired and isn't a regression vs. native dialogs, but note it as a polish item.
- **`ActionModal:76` internal `window.confirm`.** Left intentionally (§2 decision). Nesting a modal would double the scrim/focus-trap. Follow-up: inline "Discard / Keep editing" footer state inside the existing modal.
- **E2E selector seams.** New dialogs must expose stable hooks. Use `getByRole("dialog")` + heading-by-name + button-by-name (the `ds/` Button keeps an accessible name). Do **not** pin to Tailwind classes (they churn). Preserve any existing `data-testid` on the trigger rows. The suite runs against the **deployed** app, so a Phase's E2E only goes green after deploy — keep specs tolerant-empty so they pass on a clean demo book.
- **`busy` double-submit.** Each migrated handler must set `busy` before the await and clear it in `finally`, and the dialog must disable its confirm while `busy` — otherwise a double-click double-binds. The dialogs already gate on `busy`; the call sites must drive it.
- **Server-message surfacing.** Replacing `alert(e.message)` with `toastError` must keep the `e instanceof PlacementApiError ? e.message : "<fallback>"` shape — don't drop the real reason on the floor.

---

## 7. Smallest-first PR (recommended starting slice)

**PR #1 = Phase 0a + Phase 1, bind only.** Concretely:

1. Add `ConfirmDialog.tsx` + `ConfirmDialog.test.tsx` (Phase 0a) — pure additive, nothing else depends on it yet, and it unblocks Phase 4.
2. Migrate **`handleBind`** in `app/submissions/[sid]/page.tsx` to `<PromptDialog>` (single optional `policy_number` field) + `toastError` (Phase 1), preserving the null-vs-empty contract.
3. Add `e2e/placement-bind.spec.ts` (tolerant-empty) — net-new coverage for the previously-untestable flow.

Why this slice: it kills the **reported pain** (the bind `window.prompt`) in the smallest reviewable diff, lands the reusable `ConfirmDialog` that every confirm site needs, and converts the app's least-testable flow into an E2E-covered one. `PromptDialog` already exists and is proven on `policies/[pid]`, so Phase 1 needs no new primitive. Defer Phase 0b (`PromptDialog` `ds/` restyle) to PR #2 if you want PR #1 to carry zero shared-component risk — bind works identically on the legacy-styled `PromptDialog`; the restyle is cosmetic and can trail by one PR.

---

## 8. Self-review

**Site coverage:** every grep hit in §2 is assigned a target and a phase (bind P1; decline/outcome P2; optional-reason P3; confirms P4; `ActionModal` guard explicitly deferred). **No gaps.**

**Semantics pinned:** null-vs-empty (bind/policy-requests/compliance), required (decline/outcome) vs optional (waive/policy-request-decline), destructive (delete-evidence/expire) vs non-destructive (withdraw/reinstate) — each enumerated in the table and restated in the phase. 

**Primitive reuse:** `PromptDialog` (existing) for all input; new `ConfirmDialog` (built on `ActionModal`, `ds/` Button) for all yes/no; `toastError` for all errors. No third modal type introduced.

**TDD:** `ConfirmDialog` gets a failing-first behavioural spec (incl. the no-auto-close contract); `PromptDialog.test.ts` guards the 0b restyle; bind gets net-new E2E. Pure helpers extracted only where they remove real branching.

**Design-system:** `ConfirmDialog` is pure `ds/`; `PromptDialog` contents migrate (0b); `ActionModal` scaffold deferred with rationale — no flow shows mixed chrome.
