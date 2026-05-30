# Onboarding Data Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture an operator's insurance "knowns" (incumbent carrier, renewal date, coverage interest) at onboarding so a broker can actually shop them, gated by a server-computed `onboarding_complete` flag.

**Architecture:** Four structured columns on `Venue` are the source of truth; the existing `_resolve_venue` hydration overlays them onto the `venue_data` dict so current readers (scoring, quoting, display) don't change. A write service validates input against the `CoverageLine` catalog and recomputes completion. Carrier scoring becomes honest (no more hardcoded `"Surplus Lines"`). The quote-gate *guard* ships as a pure tested contract here; wiring it to the live quote action is sub-project #2.

**Tech Stack:** FastAPI + SQLModel (SQLite local / Postgres prod), Next.js (web), React Native/Expo (mobile), pytest / vitest / jest.

**Spec:** `docs/superpowers/specs/2026-05-29-onboarding-data-capture-design.md`

**Sentinels & catalog (referenced throughout):**
- `current_carrier` sentinels: `"uninsured"`, `"unsure"` (a real carrier name is anything else non-empty).
- `CoverageLine` ids (from `backend/app/seed_carriers.py` `COVERAGE_LINES`): `gl, liquor, assault_battery, property, wc, epli, cyber, umbrella`.
- Required-by-default (pre-checked in the form): `gl, liquor, wc`.

**Convention reminders:** run backend tests from `backend/` (`python -m pytest -q`). Commit style: short subject + 2-4 bullets, `git commit -F <file>` (apostrophes break `-m`). Solo repo → commit to `main`.

---

### Task 1: Add the four `Venue` columns + migration

**Files:**
- Modify: `backend/app/models.py:19-22` (the `Venue` class)
- Modify: `backend/app/database.py:25-60` (`_COLUMN_MIGRATIONS`)
- Test: `backend/tests/test_onboarding_profile.py` (new)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_onboarding_profile.py
from sqlmodel import Session
from app.database import engine
from app.models import Venue


def test_venue_persists_coverage_profile_columns():
    with Session(engine) as s:
        s.add(Venue(
            id="tcol-venue", name="Col Test",
            current_carrier="Hiscox",
            renewal_date="2026-09-01",
            coverage_interest='["gl","liquor"]',
            onboarding_complete=True,
        ))
        s.commit()
    with Session(engine) as s:
        v = s.get(Venue, "tcol-venue")
        assert v.current_carrier == "Hiscox"
        assert v.renewal_date == "2026-09-01"
        assert v.coverage_interest == '["gl","liquor"]'
        assert v.onboarding_complete is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_onboarding_profile.py::test_venue_persists_coverage_profile_columns -v`
Expected: FAIL — `TypeError: 'current_carrier' is an invalid keyword argument` (column not on model).

- [ ] **Step 3: Add the columns to the `Venue` model**

```python
# backend/app/models.py
class Venue(SQLModel, table=True):
    id: str = Field(primary_key=True)
    name: str
    venue_data: Optional[str] = Field(default=None)  # JSON-encoded full venue dict
    # Onboarding "knowns" — structured source of truth, overlaid onto venue_data
    # at hydration (see app/api/v1/venues.py:_resolve_venue). Dates/JSON stored as
    # TEXT per the project's migration convention.
    current_carrier: Optional[str] = Field(default=None)   # carrier name OR "uninsured"/"unsure"
    renewal_date: Optional[str] = Field(default=None)      # ISO date string
    coverage_interest: Optional[str] = Field(default=None) # JSON-encoded list of CoverageLine ids
    onboarding_complete: bool = Field(default=False)
```

- [ ] **Step 4: Add the migration rows**

```python
# backend/app/database.py — append inside _COLUMN_MIGRATIONS, before the closing ]
    # Onboarding data capture — added 2026-05-29.
    ("venue", "current_carrier", "TEXT", ""),
    ("venue", "renewal_date", "TEXT", ""),
    ("venue", "coverage_interest", "TEXT", ""),
    ("venue", "onboarding_complete", "BOOLEAN", "NOT NULL DEFAULT 0"),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_onboarding_profile.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/app/database.py backend/tests/test_onboarding_profile.py
git commit -F <msg>   # feat(onboarding): add Venue coverage-profile columns + migration
```

---

### Task 2: Completion logic, validation, and the (unwired) gate guard

**Files:**
- Create: `backend/app/services/coverage_profile.py`
- Test: `backend/tests/test_coverage_profile_service.py` (new)

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_coverage_profile_service.py
import pytest
from app.services.coverage_profile import (
    compute_onboarding_complete, validate_coverage_interest,
    assert_onboarding_complete, CoverageProfileError, OnboardingIncompleteError,
)


def test_complete_with_real_carrier_and_line():
    assert compute_onboarding_complete("Hiscox", ["gl"]) is True

def test_complete_with_uninsured_and_line_no_renewal():
    assert compute_onboarding_complete("uninsured", ["gl"]) is True

def test_complete_with_unsure_and_line():
    assert compute_onboarding_complete("unsure", ["liquor"]) is True

def test_incomplete_without_carrier_answer():
    assert compute_onboarding_complete(None, ["gl"]) is False

def test_incomplete_with_no_coverage_line():
    assert compute_onboarding_complete("Hiscox", []) is False

def test_validate_rejects_unknown_line():
    with pytest.raises(CoverageProfileError):
        validate_coverage_interest(["gl", "not_a_line"])

def test_validate_accepts_known_lines():
    assert validate_coverage_interest(["gl", "assault_battery"]) == ["gl", "assault_battery"]

def test_assert_guard_raises_when_incomplete():
    with pytest.raises(OnboardingIncompleteError) as ei:
        assert_onboarding_complete({"current_carrier": None, "coverage_interest": []})
    assert "current_carrier" in ei.value.missing

def test_assert_guard_passes_when_complete():
    assert_onboarding_complete({"current_carrier": "Hiscox", "coverage_interest": ["gl"]})
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_coverage_profile_service.py -v`
Expected: FAIL — `ModuleNotFoundError: app.services.coverage_profile`.

- [ ] **Step 3: Implement the service**

```python
# backend/app/services/coverage_profile.py
"""Onboarding coverage-profile rules: completion, validation, and the quote gate.

Pure functions over primitives + dicts — no DB, no session — so they're trivially
testable and reusable by the venue write path (#1) and the placement quote action (#2).
"""
from __future__ import annotations

CARRIER_SENTINELS = {"uninsured", "unsure"}


class CoverageProfileError(Exception):
    """Invalid coverage-profile input (e.g. unknown coverage line). Maps to 400."""


class OnboardingIncompleteError(Exception):
    """Venue isn't shoppable yet. Maps to 422. Carries the missing field names."""
    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__(f"Onboarding incomplete; missing: {', '.join(missing)}")


def _coverage_line_ids() -> set[str]:
    from app.seed_carriers import COVERAGE_LINES
    return {line["id"] for line in COVERAGE_LINES}


def validate_coverage_interest(ids: list[str]) -> list[str]:
    """Return the ids unchanged if every one is a known CoverageLine; else raise."""
    known = _coverage_line_ids()
    unknown = [i for i in ids if i not in known]
    if unknown:
        raise CoverageProfileError(f"Unknown coverage line(s): {', '.join(unknown)}")
    return ids


def compute_onboarding_complete(current_carrier: str | None, coverage_interest: list[str]) -> bool:
    """Shoppable iff the operator answered the insurance question (any branch) and
    picked at least one coverage line. The 'I have a policy' branch's renewal_date
    requirement is enforced at field-validation time (set_coverage_profile), not here."""
    answered = bool(current_carrier)
    return answered and len(coverage_interest) >= 1


def assert_onboarding_complete(venue: dict) -> None:
    """Guard for the quote/coverage-request action. Raises OnboardingIncompleteError
    with the list of missing fields. (Wired to the live quote action in sub-project #2.)"""
    missing: list[str] = []
    if not venue.get("current_carrier"):
        missing.append("current_carrier")
    if not (venue.get("coverage_interest") or []):
        missing.append("coverage_interest")
    if missing:
        raise OnboardingIncompleteError(missing)
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/test_coverage_profile_service.py -v`
Expected: PASS (all 9).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/coverage_profile.py backend/tests/test_coverage_profile_service.py
git commit -F <msg>   # feat(onboarding): coverage-profile completion + validation + gate contract
```

---

### Task 3: Write service — persist the profile onto the Venue

**Files:**
- Modify: `backend/app/services/coverage_profile.py` (add `set_coverage_profile`)
- Test: `backend/tests/test_coverage_profile_service.py` (extend)

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_coverage_profile_service.py
from sqlmodel import Session
from app.database import engine
from app.models import Venue
from app.services.coverage_profile import set_coverage_profile


def _fresh_venue(vid):
    with Session(engine) as s:
        if not s.get(Venue, vid):
            s.add(Venue(id=vid, name=vid)); s.commit()


def test_set_profile_real_carrier_persists_and_completes():
    _fresh_venue("scp-1")
    with Session(engine) as s:
        v = s.get(Venue, "scp-1")
        set_coverage_profile(s, v, current_carrier="Hiscox",
                             renewal_date="2026-09-01", coverage_interest=["gl", "liquor"])
        s.commit()
        v = s.get(Venue, "scp-1")
        assert v.current_carrier == "Hiscox"
        assert v.renewal_date == "2026-09-01"
        assert v.coverage_interest == '["gl", "liquor"]'
        assert v.onboarding_complete is True


def test_set_profile_uninsured_completes_without_renewal():
    _fresh_venue("scp-2")
    with Session(engine) as s:
        v = s.get(Venue, "scp-2")
        set_coverage_profile(s, v, current_carrier="uninsured",
                             renewal_date=None, coverage_interest=["gl"])
        assert v.onboarding_complete is True


def test_set_profile_real_carrier_without_renewal_raises():
    _fresh_venue("scp-3")
    with Session(engine) as s:
        v = s.get(Venue, "scp-3")
        with pytest.raises(CoverageProfileError):
            set_coverage_profile(s, v, current_carrier="Hiscox",
                                 renewal_date=None, coverage_interest=["gl"])
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_coverage_profile_service.py -k set_profile -v`
Expected: FAIL — `ImportError: cannot import name 'set_coverage_profile'`.

- [ ] **Step 3: Implement**

```python
# append to backend/app/services/coverage_profile.py
import json as _json


def set_coverage_profile(session, venue, *, current_carrier, renewal_date, coverage_interest):
    """Validate + write the four onboarding columns onto a Venue row (no commit —
    the caller owns the transaction). Raises CoverageProfileError on bad input."""
    carrier = (current_carrier or "").strip() or None
    lines = validate_coverage_interest(list(coverage_interest or []))

    is_real_carrier = carrier is not None and carrier not in CARRIER_SENTINELS
    if is_real_carrier and not renewal_date:
        raise CoverageProfileError("renewal_date is required when a current carrier is given")

    venue.current_carrier = carrier
    venue.renewal_date = renewal_date or None
    venue.coverage_interest = _json.dumps(lines)
    venue.onboarding_complete = compute_onboarding_complete(carrier, lines)
    session.add(venue)
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/test_coverage_profile_service.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/coverage_profile.py backend/tests/test_coverage_profile_service.py
git commit -F <msg>   # feat(onboarding): set_coverage_profile write service
```

---

### Task 4: Hydration overlay — surface columns in the venue dict

**Files:**
- Modify: `backend/app/api/v1/venues.py:76-94` (`_resolve_venue`)
- Test: `backend/tests/test_onboarding_profile.py` (extend)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_onboarding_profile.py
from sqlmodel import Session
from app.api.v1.venues import _resolve_venue, VENUES
from app.services.coverage_profile import set_coverage_profile


def test_resolve_venue_overlays_profile_columns():
    with Session(engine) as s:
        if not s.get(Venue, "ovl-1"):
            s.add(Venue(id="ovl-1", name="Overlay", venue_data='{"capacity": 200}'))
        v = s.get(Venue, "ovl-1")
        set_coverage_profile(s, v, current_carrier="Chubb",
                             renewal_date="2026-10-01", coverage_interest=["gl"])
        s.commit()
    VENUES.pop("ovl-1", None)  # force a DB rehydrate, not a cache hit
    with Session(engine) as s:
        d = _resolve_venue("ovl-1", s)
        assert d["current_carrier"] == "Chubb"
        assert d["renewal_date"] == "2026-10-01"
        assert d["coverage_interest"] == ["gl"]
        assert d["onboarding_complete"] is True
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_onboarding_profile.py::test_resolve_venue_overlays_profile_columns -v`
Expected: FAIL — `KeyError: 'current_carrier'` (or stale value from venue_data).

- [ ] **Step 3: Implement the overlay**

In `_resolve_venue`, after `venue_data = {"name": db_venue.name, **data}` and before `VENUES[venue_id] = venue_data`, overlay the columns (column wins over any stale venue_data copy):

```python
    # Overlay the structured onboarding columns onto the dict so scoring/quote/
    # display readers see authoritative values without reading venue_data copies.
    import json as _json2
    if db_venue.current_carrier is not None:
        venue_data["current_carrier"] = db_venue.current_carrier
    if db_venue.renewal_date is not None:
        venue_data["renewal_date"] = db_venue.renewal_date
    if db_venue.coverage_interest is not None:
        try:
            venue_data["coverage_interest"] = _json2.loads(db_venue.coverage_interest)
        except (ValueError, TypeError):
            venue_data["coverage_interest"] = []
    venue_data["onboarding_complete"] = bool(db_venue.onboarding_complete)
```

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/test_onboarding_profile.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/venues.py backend/tests/test_onboarding_profile.py
git commit -F <msg>   # feat(onboarding): overlay profile columns at venue hydration
```

---

### Task 5: Wire the write path into `PATCH /api/venues/{id}` + coverage-lines catalog endpoint

**Files:**
- Modify: `backend/app/api/v1/venues.py:229+` (`update_venue`) and add `GET /api/coverage-lines`
- Test: `backend/tests/test_coverage_profile_api.py` (new)

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_coverage_profile_api.py
import pytest
from fastapi.testclient import TestClient
from app.auth import create_token
from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c

def _op():
    return {"Authorization": f"Bearer {create_token('u-cp', 'cp@x.com', 'venue_operator', 'elsewhere-brooklyn')}"}


def test_coverage_lines_catalog_endpoint(client):
    r = client.get("/api/coverage-lines")
    assert r.status_code == 200
    ids = {l["id"] for l in r.json()}
    assert {"gl", "liquor", "assault_battery"} <= ids
    gl = next(l for l in r.json() if l["id"] == "gl")
    assert gl["name"] and "is_required_by_default" in gl


def test_patch_venue_sets_coverage_profile(client):
    r = client.patch("/api/venues/elsewhere-brooklyn", json={
        "current_carrier": "Hiscox", "renewal_date": "2026-09-01",
        "coverage_interest": ["gl", "liquor"],
    }, headers=_op())
    assert r.status_code == 200, r.text
    assert r.json()["onboarding_complete"] is True
    g = client.get("/api/venues/elsewhere-brooklyn", headers=_op())
    assert g.json()["current_carrier"] == "Hiscox"


def test_patch_venue_rejects_unknown_coverage_line(client):
    r = client.patch("/api/venues/elsewhere-brooklyn", json={
        "current_carrier": "Hiscox", "renewal_date": "2026-09-01",
        "coverage_interest": ["gl", "bogus"],
    }, headers=_op())
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "invalid_coverage_line"


def test_patch_venue_real_carrier_requires_renewal(client):
    r = client.patch("/api/venues/elsewhere-brooklyn", json={
        "current_carrier": "Hiscox", "coverage_interest": ["gl"],
    }, headers=_op())
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "renewal_date_required"
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_coverage_profile_api.py -v`
Expected: FAIL — 404 on `/api/coverage-lines`; PATCH ignores the new fields.

- [ ] **Step 3a: Add the catalog endpoint**

```python
# backend/app/api/v1/venues.py — new route (near the other @router.get routes)
@router.get("/coverage-lines")
def list_coverage_lines() -> list[dict]:
    """The CoverageLine catalog for the onboarding coverage-interest checklist."""
    from app.seed_carriers import COVERAGE_LINES
    return [
        {"id": l["id"], "name": l["name"], "description": l["description"],
         "is_required_by_default": l["is_required_by_default"]}
        for l in COVERAGE_LINES
    ]
```

- [ ] **Step 3b: Wire the write path into `update_venue`**

After the existing `editable` field handling in `update_venue`, before it persists, branch on the coverage-profile keys and map errors:

```python
    # Coverage-profile capture (onboarding knowns). Validated + completion-computed
    # by the service; CoverageProfileError → 400 with a specific error code.
    if any(k in payload for k in ("current_carrier", "renewal_date", "coverage_interest")):
        from app.services.coverage_profile import set_coverage_profile, CoverageProfileError
        db_venue = session.get(Venue, venue_id)
        try:
            set_coverage_profile(
                session, db_venue,
                current_carrier=payload.get("current_carrier", db_venue.current_carrier),
                renewal_date=payload.get("renewal_date", db_venue.renewal_date),
                coverage_interest=payload.get("coverage_interest",
                    (_json.loads(db_venue.coverage_interest) if db_venue.coverage_interest else [])),
            )
        except CoverageProfileError as e:
            code = "renewal_date_required" if "renewal_date" in str(e) else "invalid_coverage_line"
            raise error_response(code, str(e), status_code=400)
```

Ensure the handler returns the hydrated venue (so `onboarding_complete` and the columns are in the response) — return `{"id": venue_id, **_resolve_venue(venue_id, session)}` after commit (drop any stale `VENUES` cache entry first: `VENUES.pop(venue_id, None)`).

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/test_coverage_profile_api.py -v`
Expected: PASS (4).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/venues.py backend/tests/test_coverage_profile_api.py
git commit -F <msg>   # feat(onboarding): coverage-profile write on PATCH venue + catalog endpoint
```

---

### Task 6: Honest carrier bonus + stop faking the default

**Files:**
- Modify: `backend/app/api/v1/venues.py:178-184` (`create_venue` defaults)
- Modify: `backend/app/underwriting/scoring.py:296-302` (`_score_business_profile`)
- Test: `backend/tests/test_onboarding_profile.py` (extend)

- [ ] **Step 1: Write the failing tests**

```python
# append to backend/tests/test_onboarding_profile.py
from app.underwriting.scoring import RiskScoringEngine


def _bp(venue):
    return RiskScoringEngine({"v": venue})._score_business_profile(venue)


def test_real_carrier_earns_bonus():
    base = {"years_in_operation": 1, "venue_type": "bar"}
    assert _bp({**base, "current_carrier": "Hiscox"}) > _bp({**base, "current_carrier": None})


def test_sentinel_carrier_earns_no_bonus():
    base = {"years_in_operation": 1, "venue_type": "bar"}
    assert _bp({**base, "current_carrier": "uninsured"}) == _bp({**base, "current_carrier": None})
    assert _bp({**base, "current_carrier": "unsure"}) == _bp({**base, "current_carrier": None})
```

- [ ] **Step 2: Run to verify failure**

Run: `python -m pytest tests/test_onboarding_profile.py -k carrier -v`
Expected: FAIL — current logic reads `prior_carrier`, so `current_carrier` changes nothing.

- [ ] **Step 3a: Make the bonus honest**

```python
# backend/app/underwriting/scoring.py — in _score_business_profile, replace the
# prior-carrier bonus block:
        from app.services.coverage_profile import CARRIER_SENTINELS
        carrier = venue.get("current_carrier") or venue.get("prior_carrier")
        has_real_carrier = bool(carrier) and carrier not in CARRIER_SENTINELS and carrier != "None"
        carrier_bonus = 15 if has_real_carrier else 0
```

- [ ] **Step 3b: Stop hardcoding the fake carrier in `create_venue`**

In `create_venue`'s `venue_data` dict, change the carrier/renewal defaults so a fresh venue starts *unanswered* (the nudge then drives capture):

```python
        "current_carrier": None,
        "renewal_date": None,
        ...
        "prior_carrier": None,
```

- [ ] **Step 4: Run to verify pass + no regressions**

Run: `python -m pytest tests/test_onboarding_profile.py -k carrier -v`
Expected: PASS.
Run: `python -m pytest tests/test_phase_1.py -q`
Expected: PASS (62 cells unchanged — they set carriers explicitly on seeded venues).
If any other create-venue test asserts an exact score, re-baseline it intentionally (a fresh venue now correctly loses the fake +15 → ~2 pts on business_profile × 0.15 weight).

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/scoring.py backend/app/api/v1/venues.py backend/tests/test_onboarding_profile.py
git commit -F <msg>   # feat(onboarding): honest carrier bonus; drop hardcoded Surplus Lines default
```

---

### Task 7: Web — coverage-profile lib + onboarding nudge card + quote-CTA disable

**Files:**
- Create: `frontend/src/lib/coverageProfile.ts`
- Create: `frontend/src/components/OnboardingCard.tsx`
- Modify: `frontend/src/app/dashboard/page.tsx` (render the card for operators)
- Test: `frontend/src/lib/coverageProfile.test.ts` (vitest)

- [ ] **Step 1: Write the failing lib test**

```ts
// frontend/src/lib/coverageProfile.test.ts
import { describe, it, expect } from "vitest";
import { isProfileComplete } from "@/lib/coverageProfile";

describe("isProfileComplete", () => {
  it("true with carrier answer + a line", () => {
    expect(isProfileComplete({ current_carrier: "Hiscox", coverage_interest: ["gl"] })).toBe(true);
  });
  it("false without a carrier answer", () => {
    expect(isProfileComplete({ current_carrier: null, coverage_interest: ["gl"] })).toBe(false);
  });
  it("false with no coverage line", () => {
    expect(isProfileComplete({ current_carrier: "uninsured", coverage_interest: [] })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run (from `frontend/`): `npx vitest run src/lib/coverageProfile.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lib**

```ts
// frontend/src/lib/coverageProfile.ts
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface CoverageLine {
  id: string; name: string; description: string; is_required_by_default: boolean;
}
export interface ProfileShape {
  current_carrier: string | null;
  coverage_interest: string[] | null;
}

export function isProfileComplete(v: ProfileShape): boolean {
  return Boolean(v.current_carrier) && (v.coverage_interest?.length ?? 0) >= 1;
}

export async function fetchCoverageLines(): Promise<CoverageLine[]> {
  const r = await fetch(`${API_URL}/api/coverage-lines`);
  return r.ok ? r.json() : [];
}

export async function saveCoverageProfile(venueId: string, body: {
  current_carrier: string; renewal_date?: string | null; coverage_interest: string[];
}): Promise<Response> {
  return fetch(`${API_URL}/api/venues/${venueId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/coverageProfile.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Build `OnboardingCard.tsx`**

Component contract (final styling via the `ui-ux-pro-max` flow; this fixes structure + behavior):
- Props: `{ venueId: string; profile: ProfileShape; renewalDate: string | null; onSaved: () => void }`.
- Renders nothing-but-a-confirmation chip when `isProfileComplete(profile)` is true.
- Otherwise renders the **"Complete your profile to get quoted"** card:
  - Insurance status radios: `have_policy | uninsured | unsure`. `have_policy` reveals a carrier-name text input + a renewal-date `<input type="date">` (required).
  - Coverage checklist from `fetchCoverageLines()`; pre-check the `is_required_by_default` ids on first load.
  - Save button → `saveCoverageProfile(venueId, { current_carrier, renewal_date, coverage_interest })`. On 200 call `onSaved()`. On 400 show the `detail.message` inline.
  - Map radios to `current_carrier`: `have_policy` → the typed name; `uninsured`/`unsure` → that literal sentinel.

- [ ] **Step 6: Render it on the operator dashboard**

In `frontend/src/app/dashboard/page.tsx`, for `venue_operator` users, render `<OnboardingCard ... />` near the top of the dashboard, fed by the venue the dashboard already loads. Disable any "Request a quote" CTA when `!isProfileComplete(profile)` with a tooltip "Complete your profile to request coverage."

- [ ] **Step 7: Verify typecheck**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: exit 0. Grep `frontend/e2e/` for any dashboard selectors that might pin to changed copy before pushing.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/coverageProfile.ts frontend/src/lib/coverageProfile.test.ts frontend/src/components/OnboardingCard.tsx frontend/src/app/dashboard/page.tsx
git commit -F <msg>   # feat(onboarding): web nudge card + coverage-profile capture
```

---

### Task 8: Mobile parity

**Files:**
- Create: `mobile/src/api/coverageProfile.ts`
- Modify: a dashboard/home screen under `mobile/src/screens/` to render the same nudge card
- Test: `mobile/src/api/coverageProfile.test.ts` (jest) for `isProfileComplete`

- [ ] **Step 1: Write the failing jest test** for `isProfileComplete` (mirror Task 7 Step 1; same three cases).

- [ ] **Step 2: Run to verify failure** — Run (from `mobile/`): `npx jest coverageProfile` → FAIL (module missing).

- [ ] **Step 3: Implement `coverageProfile.ts`** — `isProfileComplete` (identical logic), plus `fetchCoverageLines()` and `saveCoverageProfile()` using the mobile `api` client (`mobile/src/api/client.ts`, which injects the bearer). PATCH via `api.request('/api/venues/{id}', { method: 'PATCH', body })`.

- [ ] **Step 4: Run to verify pass** — `npx jest coverageProfile` → PASS.

- [ ] **Step 5: Build the nudge card** on the operator dashboard screen: same branching insurance control + coverage checklist (React Native controls), same save→onSaved behavior, collapses when complete. Honor the web/mobile consistency rule (copy + behavior parity). Avoid the letter `d` in any Caveat-accent phrase (RN renders it as `a`).

- [ ] **Step 6: Verify typecheck** — Run (from `mobile/`): `npx tsc --noEmit` → exit 0.

- [ ] **Step 7: Commit**

```bash
git add mobile/src/api/coverageProfile.ts mobile/src/api/coverageProfile.test.ts mobile/src/screens/
git commit -F <msg>   # feat(onboarding): mobile parity for coverage-profile capture
```

---

### Task 9: Full-suite verification

- [ ] **Step 1: Backend** — Run (from `backend/`): `python -m pytest -q`. Expected: all green (926 existing + new). Investigate any create-venue score-assertion shifts from Task 6 and re-baseline intentionally.
- [ ] **Step 2: Web** — Run (from `frontend/`): `npx tsc --noEmit` and `npx vitest run`. Expected: clean.
- [ ] **Step 3: Mobile** — Run (from `mobile/`): `npx tsc --noEmit` and `npx jest`. Expected: clean.
- [ ] **Step 4: Acceptance walk-through** — confirm the five success criteria in the spec §5 by inspection (fresh operator can capture; broker can query renewal/incomplete; completion doesn't move the score; phase_1 green; incident logging never gated).

---

## Deferred to sub-project #2 (noted, not in this plan)
- Wiring `assert_onboarding_complete` to the operator's **initial quote-request action** (that action is #2's placement work; today's `PolicyRequest` only changes existing policies).
- The broker renewals-prospecting dashboard (this plan ships only the queryable columns + a "profile complete" indicator).
