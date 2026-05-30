# Onboarding Data Capture — design

**Date:** 2026-05-29
**Status:** Approved (brainstorming) → pending implementation plan
**Area:** `backend/app/models.py` (Venue), `backend/app/api/v1/venues.py`, `backend/app/underwriting/scoring.py`, operator dashboard (web + mobile)
**Sub-project:** #1 of 3 in the operator onboarding ↔ carrier ↔ placement decomposition

---

## Context

A production-readiness audit of the operator surface found that onboarding collects venue
basics (name, address, capacity, type) but **none of the data a broker needs to actually
shop coverage**: the incumbent carrier is hardcoded to `"Surplus Lines"`
(`venues.py:178`), the renewal date is optional and defaults to a placeholder, and there
is no capture of which coverage lines the venue wants. The broker placement machinery
(`Submission → CarrierQuote → bind → Policy`) is built but **starved at the source** — it
has nothing real to quote against.

This is sub-project **#1** of a three-part decomposition:

1. **Onboarding data capture** *(this spec)* — record the operator's "knowns" so a broker can shop them.
2. **Operator-visible placement experience** — operator sees the broker shop → quotes → selects → bound.
3. **Incident ↔ bound-policy coverage linkage** — adjudicate a real loss against the policy's coverage lines.

They are dependency-ordered (1 → 2 → 3). This spec covers **#1 only**.

### Decisions taken in brainstorming

| Fork | Decision |
|---|---|
| **Capture model** | Operator provides **knowns only**; broker completes precise limits/lines during placement. Matches real brokerage where the broker advises on coverage. |
| **Completion gate** | **Nudge in-app, gate at quote.** Operator lands in the app and uses it freely; a persistent card blocks only the coverage-request action until the knowns are filled. |
| **Coverage menu** | **Reuse the existing `CoverageLine` catalog** (`seed_carriers.py`) — no new vocabulary. |
| **Data model** | **Structured columns on `Venue`** (source of truth), overlaid onto the `venue_data` dict at hydration so existing readers don't change. |

---

## 1. Data model & persistence

`Venue` is a thin shell today — `id`, `name`, `venue_data` (a JSON-encoded dict). Every
venue attribute (capacity, security_level, renewal_date, current_carrier…) currently lives
*inside* that blob, and all readers (scoring, quoting, display) read the **parsed dict**.

Add four real columns to `Venue`:

| Column | Type | Purpose |
|---|---|---|
| `current_carrier` | `str \| None` | incumbent insurer name **or** a sentinel (`"uninsured"`, `"unsure"`); set ⇔ the operator answered the insurance question; feeds the business-profile carrier bonus |
| `renewal_date` | `date \| None` | required to **save** the "I have a policy" branch; drives broker "renews in <60d" queries |
| `coverage_interest` | `str` (JSON-encoded list of `CoverageLine` ids) | what to shop, e.g. `["gl","liquor","assault_battery"]` |
| `onboarding_complete` | `bool` (default `False`) | the brokers'-eye "is this shoppable?" gate flag |

**`coverage_interest` is a soft reference**, not a join table — a list of `CoverageLine`
ids validated against the catalog at write time. The relational thread
(`coverage_interest → Submission.coverage_lines → Policy.coverage_lines →
Claim.coverage_line`) is **established downstream in #2/#3** when the broker acts on the
intent. Onboarding stays flat: one row, no new tables, no joins.

**Reconciliation — columns as source of truth, dict overlaid at hydration.** The
venue→dict hydration step (where `venue_data` is parsed into the working `VENUES` dict)
overlays these four columns onto the dict. Therefore:

- Brokers query the **columns** directly in SQL (fast renewal-window / incompleteness filters).
- Existing readers (scoring, quote, display) keep reading the **dict** unchanged — no reader migration.
- One write path (the venue-update service) writes the columns; the fact lives in exactly one place. No dual-write drift.

**Migration:** additive `ALTER TABLE` columns; the project already runs idempotent additive
Postgres migrations on boot (ADR-0004). Existing venues default to
`onboarding_complete=False` and surface the nudge on next login.

---

## 2. Capture form & UX

**Where it lives:** a persistent **"Complete your profile to get quoted"** card on the
operator dashboard. The same fields are editable later under venue settings. Web + mobile
parity from the start.

**Fields — three groups mapping 1:1 to the columns:**

1. **Current insurance** — a branching control:
   - ◉ *"I have a current policy"* → reveals **carrier name** (text) + **renewal date** (required)
   - ◯ *"Currently uninsured / between policies"* → no carrier, renewal optional → still completable (`current_carrier = "uninsured"`)
   - ◯ *"Not sure"* → `current_carrier = "unsure"`; broker follows up
2. **Renewal date** — surfaced inside group 1; the field the broker queries to time the shop.
3. **Coverage interest** — a checklist rendered from the `CoverageLine` catalog (`name` +
   one-line `description`), with `is_required_by_default` lines (GL, Liquor, Workers Comp)
   **pre-checked**. Operator toggles the optional ones (Assault & Battery, Property, EPLI,
   Cyber, Umbrella). Stores `coverage_interest` as the list of line ids.

**Completion behavior:** on valid save → `onboarding_complete=True` → the card collapses to
a quiet *"✓ Profile complete — ready for quotes"* state. Until then it persists on every
dashboard load.

**Quote CTA (UI side of the gate):** the "Request a quote" CTA is disabled with a tooltip
("Complete your profile to request coverage") and deep-links to the card while
`onboarding_complete` is false.

> Detailed visual treatment (card layout, component styling) goes through the
> `ui-ux-pro-max` flow at implementation time. This spec fixes the fields, flow, and
> states — not the pixels.

---

## 3. Backend — the quote gate & validation

**Write path (one service function).** Extend the existing venue-update path
(`PATCH /api/venues/{id}`) to accept `current_carrier`, `renewal_date`,
`coverage_interest`. It writes the columns and calls a single
`recompute_onboarding_complete(venue)`:

```
onboarding_complete = current_carrier is not None AND len(coverage_interest) >= 1
```

`current_carrier is not None` means the operator answered the insurance question via *any*
of the three branches (a real carrier name, `"uninsured"`, or `"unsure"`) — so no branch is
trapped. The "I have a policy" branch additionally requires `renewal_date` at
**field-validation** time (below), so a saved has-policy venue always carries a date; the
uninsured/unsure branches complete without one. `onboarding_complete` is **always
server-computed** — never trusted from the client.

**Validation** (typed service errors → router translates, per the `_map_service_error`
convention):

- `coverage_interest`: every id must exist in the `CoverageLine` catalog → else `400 invalid_coverage_line`.
- `renewal_date`: parseable date; **required when the operator chose "I have a policy"** (a real carrier name) → else `400 renewal_date_required`. Not required for the uninsured/unsure branches.
- `current_carrier`: length-bounded free text or a known sentinel (`"uninsured"`, `"unsure"`).

**The gate — a shared guard.** `assert_onboarding_complete(venue)` raises
`OnboardingIncompleteError` → `422` with `{error, message, details: {missing: [...]}}`. It
is wired into the **entry point of the operator's coverage-request flow** (the
`PolicyRequest` creation path). A standalone guard (not inline) so sub-project #2 reuses the
**same** "is this venue shoppable?" check. The exact request-creation endpoint to attach to
is confirmed against existing code in the implementation plan.

### What is NOT gated

`onboarding_complete` gates **only** the coverage-request / quote action. Everything else
is always open, with zero dependency on onboarding:

- Logging incidents — **anytime, from minute one** (the evidence-first core loop).
- Uploading evidence, resolving compliance items, viewing the risk profile.

The gate is on placement, not on the app. No future reader should mistake the quote-gate
for an app-wide gate.

---

## 4. Scoring & broker-query integration

**The honest carrier bonus (the one scoring change).** Today `_score_business_profile`
gives every venue a `+15` "has prior carrier" bonus because the carrier is hardcoded to
`"Surplus Lines"`. After onboarding:

- A real `current_carrier` name → the `+15` is **earned**.
- Either sentinel (`"uninsured"` or `"unsure"`) → **no** bonus (no *confirmed* continuous coverage is a weaker business-profile signal; only a named incumbent counts).

Because hydration overlays the column onto the dict, the existing `venue.get(...)` read
picks up the real value — no scoring-engine rewrite.

> `test_phase_1.py`'s 62 characterization cells are **unaffected**: those fixtures set the
> carrier explicitly, so their scores don't move. The change only removes the *fake default*
> for freshly-created operator venues.

**Broker queries the columns unlock** (data ships in #1; full views are #2):

- `WHERE renewal_date BETWEEN now AND now+60d` → renewal-prospecting hook.
- `WHERE onboarding_complete = false` → a "needs attention" / data-quality list.
- `coverage_interest` → pre-populates lines when the broker opens a submission (#2).

#1 ships the **data + a minimal "profile complete" indicator** on the broker's venue view;
the full renewals dashboard is #2.

**Completion is explicitly NOT a risk-score factor.** We do not reward/punish the score for
filling a form — that is the same moral-hazard trap as operator self-attestation.
Completion gates *placement* and improves *data quality*; the only score movement is the
now-honest carrier bonus, driven by a real-world fact, not by the act of completing
onboarding.

---

## 5. Testing & success criteria

**Testing (TDD, test-first):**

- **Unit — `onboarding_complete`:** carrier name + renewal + ≥1 line → True; `uninsured` + ≥1 line (no renewal) → True; `unsure` + ≥1 line (no renewal) → True; no insurance answer (`current_carrier` None) → False; empty `coverage_interest` → False; recomputed on every write.
- **Validation:** unknown `coverage_interest` id → `400 invalid_coverage_line`; "I have a policy" branch without `renewal_date` → `400 renewal_date_required`; known ids accepted.
- **API write path:** `PATCH /api/venues/{id}` persists the four fields, recomputes completion, round-trips on read.
- **API gate:** incomplete venue → `422 onboarding_incomplete` with `details.missing`; complete venue → request succeeds.
- **Scoring:** real `current_carrier` → +15; `uninsured` → no bonus; **`test_phase_1.py` stays green**.
- **Hydration overlay:** `get_risk_score` reads the column-sourced `current_carrier` through the dict.
- **Frontend (web + mobile parity):** nudge card renders while incomplete, collapses on completion; quote CTA disabled while incomplete.

**Success criteria (acceptance):**

1. A fresh self-registered operator: sign up → land in app (can log incidents immediately) → persistent "complete to get quoted" card → fill carrier/renewal/coverage in one short form → becomes broker-shoppable.
2. Broker can query "renews in <60d" and "incomplete profiles," and sees a "profile complete" indicator.
3. An incomplete venue **cannot** start a placement (`422` at the request entry).
4. Carrier bonus reflects reality; **completion itself does not move the score**; `phase_1` green.
5. No regression: full backend suite green; web + mobile `tsc` clean.

---

## Non-goals (explicitly out of scope)

- **Operator-visible placement experience** (quotes list, selection) — sub-project #2.
- **Incident ↔ bound-policy coverage adjudication** — sub-project #3.
- **Precise limits / deductibles / sublimits capture** — the broker sets these during placement (the "broker completes" half of the capture model).
- **Onboarding completion as a risk-score factor** — deliberately excluded (moral-hazard guard).

## Future enhancement (noted, not in scope)

**Dec-page auto-extract.** Let the operator upload their current policy's declarations page
(PDF) and auto-extract carrier, renewal date, and coverage lines to pre-fill the knowns.
This brings the unstructured→structured (vision/OCR) pipeline into onboarding. Deliberately
deferred: #1 uses manual structured entry (low friction, 100% reliable, no extraction
failure modes). Revisit after #1 ships, reusing the evidence pipeline's extraction
machinery.
