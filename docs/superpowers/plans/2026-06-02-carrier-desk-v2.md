# Carrier Desk v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the carrier underwriting desk from "quote-or-decline a pre-priced submission" into a real decision surface — full risk dossier, structured terms & subjectivities, and a carrier⇄broker request-info loop — web + mobile.

**Architecture:** Backend composes a per-quote *decision dossier* server-side (one carrier-gated endpoint) reusing shipped services (`get_risk_score`, `venue_loss_run`, compliance/incident reads, `build_quote_for_carrier`); structured terms live in the existing `CarrierQuote.coverage_terms` JSON column with a validator; a new `info_requested` quote-lifecycle state powers the request-info loop through the existing `_transition_carrier_quote` + audit machinery. The web/mobile decision page is the "B" layout (decision-hero + KPI band + accordion dossier), single layout for both platforms.

**Tech Stack:** FastAPI + SQLModel + SQLite/Postgres (Neon); Next.js App Router (web); React Native/Expo (mobile). TDD with pytest; money as Decimal/strings via `app.money`.

**Spec:** `docs/superpowers/specs/2026-06-02-carrier-desk-v2-design.md`

---

## File structure

**Backend (create/modify):**
- Modify `app/lifecycles.py` — add `info_requested` to `QuoteStatus` + `QUOTE_TRANSITIONS`.
- Modify `app/models.py` — add 4 scalar fields to `CarrierQuote`.
- Modify `app/database.py` — add `_COLUMN_MIGRATIONS` rows for the new columns.
- Modify `app/services/underwriting_desk.py` — `request_info`, `respond_to_info_request`, `validate_coverage_terms`, `decision_dossier`; thread `coverage_terms` validation into `underwrite_quote`.
- Modify `app/api/v1/underwriting.py` — `POST /quotes/{qid}/request-info`, `GET /underwriting/quotes/{qid}`.
- Modify `app/api/v1/placement.py` — `POST /quotes/{qid}/info-response` (broker).
- Tests: `tests/test_underwriting_desk.py`, `tests/test_underwriting_desk_api.py`, new `tests/test_coverage_terms.py`, `tests/test_underwriting_dossier.py`.

**Web (modify/create):**
- Modify `frontend/src/lib/underwriting.ts` — dossier + terms types, `fetchDossier`, `requestInfo`, terms helpers.
- Rewrite `frontend/src/app/underwriting/[qid]/page.tsx` — B layout, dossier-driven, structured terms, request-info.
- Modify `frontend/src/app/underwriting/page.tsx` — richer rows + desk KPI strip.
- Modify `frontend/src/components/layout/AppShell.tsx` — carrier back-home → `/underwriting`.
- Modify the broker submission-detail page — info-response surface (path confirmed in Task 11).

**Mobile (modify):**
- Modify `mobile/src/api/underwriting.ts` — dossier + terms + requestInfo.
- Rewrite `mobile/src/screens/UnderwriteDecisionScreen.tsx` — B layout + terms + request-info.
- Modify `mobile/src/screens/UnderwritingDeskScreen.tsx` — richer rows.

---

## Task 1: Add `info_requested` to the quote lifecycle + CarrierQuote columns

**Files:**
- Modify: `app/lifecycles.py` (QuoteStatus ~50-58, QUOTE_TRANSITIONS ~60-68)
- Modify: `app/models.py` (CarrierQuote ~434-475)
- Modify: `app/database.py` (`_COLUMN_MIGRATIONS` ~26-73)
- Test: `tests/test_quote_lifecycle.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_quote_lifecycle.py`:
```python
import pytest
from app.lifecycles import QUOTE_TRANSITIONS, assert_valid_transition, InvalidTransitionError


def test_info_requested_is_reachable_and_requeues():
    # carrier can ask for info from requested or pending
    assert "info_requested" in QUOTE_TRANSITIONS["requested"]
    assert "info_requested" in QUOTE_TRANSITIONS["pending"]
    # from info_requested the broker re-queues to pending, or carrier decides
    assert QUOTE_TRANSITIONS["info_requested"] >= {"pending", "quoted", "declined"}


def test_info_requested_round_trip_valid():
    assert_valid_transition(QUOTE_TRANSITIONS, "requested", "info_requested", entity_name="CarrierQuote")
    assert_valid_transition(QUOTE_TRANSITIONS, "info_requested", "pending", entity_name="CarrierQuote")


def test_terminal_states_cannot_request_info():
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(QUOTE_TRANSITIONS, "declined", "info_requested", entity_name="CarrierQuote")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_quote_lifecycle.py -q`
Expected: FAIL — `"info_requested" not in QUOTE_TRANSITIONS["requested"]` (KeyError or AssertionError).

- [ ] **Step 3: Add the state + transitions**

In `app/lifecycles.py`, add `"info_requested"` to the `QuoteStatus` Literal (after `"pending"`):
```python
QuoteStatus = Literal[
    "requested",
    "pending",
    "info_requested",   # carrier asked the broker for missing info; paused
    "quoted",
    "declined",
    "expired",
    "bound",
    "withdrawn",
]
```
Update `QUOTE_TRANSITIONS`:
```python
QUOTE_TRANSITIONS: dict[str, set[str]] = {
    "requested":      {"pending", "info_requested", "quoted", "declined", "expired", "withdrawn"},
    "pending":        {"info_requested", "quoted", "declined", "expired", "withdrawn"},
    "info_requested": {"pending", "quoted", "declined", "expired", "withdrawn"},
    "quoted":         {"bound", "expired", "withdrawn"},
    "declined":       set(),
    "expired":        set(),
    "bound":          set(),
    "withdrawn":      set(),
}
```

- [ ] **Step 4: Add CarrierQuote columns**

In `app/models.py` `CarrierQuote`, add after `underwriter_name`:
```python
    info_request_note: Optional[str] = None
    info_response_note: Optional[str] = None
    info_requested_by: Optional[str] = None
    info_requested_at: Optional[str] = None   # ISO string, not datetime — the migration adds a TEXT column; storing a datetime into TEXT mismatches on Postgres
```

In `app/database.py` `_COLUMN_MIGRATIONS`, add (table name is `carrierquote`, all-lowercase, no underscore):
```python
    # Carrier desk v2 — request-info loop. Added 2026-06-02.
    ("carrierquote", "info_request_note", "TEXT", ""),
    ("carrierquote", "info_response_note", "TEXT", ""),
    ("carrierquote", "info_requested_by", "TEXT", ""),
    ("carrierquote", "info_requested_at", "TEXT", ""),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest tests/test_quote_lifecycle.py -q`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/app/lifecycles.py backend/app/models.py backend/app/database.py backend/tests/test_quote_lifecycle.py
git commit -F - <<'EOF'
feat(carrier): add info_requested quote state + request-info columns

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: `request_info` + `respond_to_info_request` services

**Files:**
- Modify: `app/services/underwriting_desk.py`
- Modify: `app/services/submissions.py` (reuse `_transition_carrier_quote`)
- Test: `tests/test_underwriting_desk.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_underwriting_desk.py`:
```python
from app.services.underwriting_desk import request_info, respond_to_info_request


def test_request_info_pauses_quote_with_note_and_audit():
    with _session() as s:
        q = _requested_quote(s)
        out = request_info(s, q.id, note="Need a current security-staffing roster.", underwriter_id="u-carrier")
        s.commit()
        assert out.status == "info_requested"
        assert "security-staffing" in (out.info_request_note or "")
        evt = _decision_audit(s, q.id, "carrier_quote.info_requested")
        assert evt.event_metadata["decision_source"] == "carrier_desk"


def test_request_info_requires_a_note():
    with _session() as s:
        q = _requested_quote(s)
        with pytest.raises(SubmissionsError):
            request_info(s, q.id, note="  ", underwriter_id="u-carrier")


def test_broker_response_requeues_to_pending():
    with _session() as s:
        q = _requested_quote(s)
        request_info(s, q.id, note="roster?", underwriter_id="u-carrier")
        s.commit()
        out = respond_to_info_request(s, q.id, note="Roster attached: 6 SIA guards.", responder_id="u-broker")
        s.commit()
        assert out.status == "pending"
        assert "6 SIA guards" in (out.info_response_note or "")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_underwriting_desk.py -q -k "request_info or info_request"`
Expected: FAIL — `ImportError: cannot import name 'request_info'`.

- [ ] **Step 3: Implement the services**

In `app/services/underwriting_desk.py`, import the transition helper + audit, and add:
```python
from app.time import now_utc
from app.services.submissions import _transition_carrier_quote
from app.models import CarrierQuote, Submission


def request_info(session: Session, quote_id: str, *, note: str, underwriter_id: str) -> CarrierQuote:
    """Carrier pauses a quote and asks the broker for missing info."""
    note = (note or "").strip()
    if not note:
        raise SubmissionsError("A request-info note is required.")
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        raise SubmissionsError(f"Quote {quote_id} not found")
    _transition_carrier_quote(
        session, q, to="info_requested", actor_id=underwriter_id,
        metadata={"decision_source": "carrier_desk", "note": note},
    )
    q.info_request_note = note
    q.info_requested_by = underwriter_id
    q.info_requested_at = now_utc().isoformat()
    session.add(q)
    return q


def respond_to_info_request(session: Session, quote_id: str, *, note: str, responder_id: str) -> CarrierQuote:
    """Broker answers the carrier's info request; the quote re-queues to 'pending'."""
    note = (note or "").strip()
    if not note:
        raise SubmissionsError("A response note is required.")
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        raise SubmissionsError(f"Quote {quote_id} not found")
    _transition_carrier_quote(
        session, q, to="pending", actor_id=responder_id,
        metadata={"note": note, "re_queued_from": "info_requested"},
    )
    q.info_response_note = note
    session.add(q)
    return q
```
**Note for the engineer:** confirm `_transition_carrier_quote` emits the audit event as `carrier_quote.{to}` (it does — `submissions.py:217-243`). It does NOT commit; the API/test owns commit (broker-platform convention).

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_underwriting_desk.py -q -k "request_info or info_request or requeues"`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/underwriting_desk.py backend/tests/test_underwriting_desk.py
git commit -F - <<'EOF'
feat(carrier): request_info + broker info-response services

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Request-info API routes (carrier ask + broker respond)

**Files:**
- Modify: `app/api/v1/underwriting.py` (carrier `request-info`)
- Modify: `app/api/v1/placement.py` (broker `info-response`)
- Test: `tests/test_underwriting_desk_api.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_underwriting_desk_api.py`:
```python
def test_carrier_requests_info_then_broker_responds(client_qid):
    client, qid = client_qid
    r = client.post(f"/api/quotes/{qid}/request-info", headers=_carrier_headers(),
                    json={"note": "Need the security-staffing roster."})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "info_requested"

    # broker answers -> re-queues
    rb = client.post(f"/api/quotes/{qid}/info-response", headers=_broker_headers(),
                     json={"note": "Roster attached."})
    assert rb.status_code == 200, rb.text
    assert rb.json()["status"] == "pending"


def test_request_info_is_carrier_only(client_qid):
    client, qid = client_qid
    denied = client.post(f"/api/quotes/{qid}/request-info", headers=_broker_headers(), json={"note": "x"})
    assert denied.status_code == 403


def test_info_response_is_broker_only(client_qid):
    client, qid = client_qid
    client.post(f"/api/quotes/{qid}/request-info", headers=_carrier_headers(), json={"note": "x"})
    denied = client.post(f"/api/quotes/{qid}/info-response", headers=_carrier_headers(), json={"note": "y"})
    assert denied.status_code == 403
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_underwriting_desk_api.py -q -k "request_info or info_respon"`
Expected: FAIL — 404 (routes don't exist yet).

- [ ] **Step 3: Implement the routes**

In `app/api/v1/underwriting.py`, add (reusing the file's `_quote_to_dict`, `error_response`, `require_carrier`):
```python
from app.services.underwriting_desk import request_info  # add to existing import

@router.post("/quotes/{quote_id}/request-info")
def post_request_info(
    quote_id: str,
    payload: dict,
    user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    try:
        q = request_info(session, quote_id, note=str(payload.get("note", "")), underwriter_id=str(user.get("sub")))
    except SubmissionsError as e:
        raise error_response("request_info_invalid", str(e), status_code=400)
    session.commit()
    session.refresh(q)
    return _quote_to_dict(q)
```
Extend `_quote_to_dict` in this file to include the info fields:
```python
        "info_request_note": q.info_request_note,
        "info_response_note": q.info_response_note,
```

In `app/api/v1/placement.py`, add a broker route (uses `require_broker`, already imported):
```python
from app.services.underwriting_desk import respond_to_info_request

@router.post("/quotes/{qid}/info-response", dependencies=[Depends(require_broker)])
def api_info_response(qid: str, payload: dict, session: Session = Depends(get_session)) -> dict:
    try:
        q = respond_to_info_request(session, qid, note=str(payload.get("note", "")), responder_id="broker")
    except SubmissionsError as e:
        session.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    session.commit()
    session.refresh(q)
    return _quote_to_dict(q)
```
**Note:** if `placement.py` lacks `respond_to_info_request`/`SubmissionsError` imports, add them.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_underwriting_desk_api.py -q`
Expected: PASS (all, including the 3 new).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/underwriting.py backend/app/api/v1/placement.py backend/tests/test_underwriting_desk_api.py
git commit -F - <<'EOF'
feat(carrier): request-info + info-response API routes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `validate_coverage_terms` validator

**Files:**
- Modify: `app/services/underwriting_desk.py`
- Test: `tests/test_coverage_terms.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_coverage_terms.py`:
```python
import pytest
from app.services.underwriting_desk import validate_coverage_terms
from app.services.submissions import SubmissionsError


def _ok_terms():
    return {
        "lines": {"gl": {"limit": "1000000", "deductible": "2500", "sublimit": None}},
        "subjectivities": [{"text": "Proof of licensed security staffing", "status": "open"}],
        "exclusions": ["Communicable disease"],
        "endorsements": ["Liquor liability endorsement"],
        "schedule_mods": [{"category": "Loss experience", "kind": "debit", "pct": "10"}],
        "valid_until": "2099-01-01",
    }


def test_valid_terms_pass():
    validate_coverage_terms(_ok_terms(), coverage_lines=["gl", "liquor"])  # no raise


def test_empty_terms_allowed():
    validate_coverage_terms({}, coverage_lines=["gl"])  # no terms is fine


def test_bad_subjectivity_status_rejected():
    t = _ok_terms(); t["subjectivities"][0]["status"] = "maybe"
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])


def test_line_not_in_submission_rejected():
    t = _ok_terms(); t["lines"]["cyber"] = {"limit": "1000000", "deductible": "0"}
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])


def test_past_valid_until_rejected():
    t = _ok_terms(); t["valid_until"] = "2000-01-01"
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])


def test_negative_pct_rejected():
    t = _ok_terms(); t["schedule_mods"][0]["pct"] = "-5"
    with pytest.raises(SubmissionsError):
        validate_coverage_terms(t, coverage_lines=["gl"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_coverage_terms.py -q`
Expected: FAIL — `ImportError: cannot import name 'validate_coverage_terms'`.

- [ ] **Step 3: Implement the validator**

In `app/services/underwriting_desk.py`:
```python
from datetime import date as _date

_SUBJ_STATUSES = {"open", "met", "waived"}
_MOD_KINDS = {"credit", "debit"}


def validate_coverage_terms(terms: dict, *, coverage_lines: list[str]) -> None:
    """Validate the structured-terms object stored in CarrierQuote.coverage_terms.
    Raises SubmissionsError on any malformed field. Empty/missing keys are allowed."""
    if not terms:
        return
    lines = terms.get("lines") or {}
    for line_id, spec in lines.items():
        if line_id not in coverage_lines:
            raise SubmissionsError(f"terms.lines has '{line_id}' not in the submission's coverage lines")
        for k in ("limit", "deductible"):
            if k in spec and spec[k] is not None and not _is_money(spec[k]):
                raise SubmissionsError(f"terms.lines.{line_id}.{k} must be a money string")
    for subj in terms.get("subjectivities") or []:
        if not (subj.get("text") or "").strip():
            raise SubmissionsError("each subjectivity needs non-empty text")
        if subj.get("status") not in _SUBJ_STATUSES:
            raise SubmissionsError(f"subjectivity status must be one of {sorted(_SUBJ_STATUSES)}")
    for key in ("exclusions", "endorsements"):
        if any(not str(x).strip() for x in (terms.get(key) or [])):
            raise SubmissionsError(f"terms.{key} entries must be non-empty strings")
    for mod in terms.get("schedule_mods") or []:
        if mod.get("kind") not in _MOD_KINDS:
            raise SubmissionsError(f"schedule_mod kind must be one of {sorted(_MOD_KINDS)}")
        try:
            if float(mod.get("pct")) < 0:
                raise ValueError
        except (TypeError, ValueError):
            raise SubmissionsError("schedule_mod pct must be a number >= 0")
    vu = terms.get("valid_until")
    if vu is not None:
        try:
            parsed = _date.fromisoformat(vu)
        except (TypeError, ValueError):
            raise SubmissionsError("valid_until must be an ISO date (YYYY-MM-DD)")
        if parsed < now_utc().date():
            raise SubmissionsError("valid_until cannot be in the past")


def _is_money(v) -> bool:
    try:
        float(v); return True
    except (TypeError, ValueError):
        return False
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_coverage_terms.py -q`
Expected: PASS (6 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/underwriting_desk.py backend/tests/test_coverage_terms.py
git commit -F - <<'EOF'
feat(carrier): validate_coverage_terms for structured quote terms

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Validate terms in the underwrite path

**Files:**
- Modify: `app/services/underwriting_desk.py` (`underwrite_quote`)
- Test: `tests/test_underwriting_desk.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_underwriting_desk.py`:
```python
def test_underwrite_rejects_malformed_terms():
    with _session() as s:
        q = _requested_quote(s)
        with pytest.raises(SubmissionsError):
            underwrite_quote(
                s, q.id, decision="quote",
                premium_breakdown=_well_formed_breakdown(),
                coverage_terms={"subjectivities": [{"text": "x", "status": "bogus"}]},
                underwriter_id="u-carrier",
            )


def test_underwrite_persists_valid_terms():
    with _session() as s:
        q = _requested_quote(s)
        out = underwrite_quote(
            s, q.id, decision="quote",
            premium_breakdown=_well_formed_breakdown(),
            coverage_terms={"subjectivities": [{"text": "Inspection", "status": "open"}]},
            underwriter_id="u-carrier",
        )
        s.commit()
        assert out.coverage_terms["subjectivities"][0]["status"] == "open"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_underwriting_desk.py -q -k "malformed_terms or persists_valid_terms"`
Expected: FAIL — `test_underwrite_rejects_malformed_terms` does not raise (no validation yet).

- [ ] **Step 3: Wire validation into `underwrite_quote`**

In `underwrite_quote`, in the `decision == "quote"` branch, before calling `record_carrier_response`, look up the submission's coverage lines and validate:
```python
    if decision == "quote":
        if coverage_terms:
            q = session.get(CarrierQuote, quote_id)
            sub = session.get(Submission, q.submission_id) if q else None
            validate_coverage_terms(coverage_terms, coverage_lines=(sub.coverage_lines if sub else []))
        return record_carrier_response(
            session, quote_id, status="quoted",
            premium_breakdown=premium_breakdown,
            coverage_terms=coverage_terms,
            underwriter_name=underwriter_id,
            recorded_by=underwriter_id,
            decision_source="carrier_desk",
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_underwriting_desk.py -q`
Expected: PASS (all desk tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/underwriting_desk.py backend/tests/test_underwriting_desk.py
git commit -F - <<'EOF'
feat(carrier): validate coverage_terms on the underwrite quote path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Decision-dossier composer + endpoint

**Files:**
- Modify: `app/services/underwriting_desk.py` (`decision_dossier`)
- Modify: `app/api/v1/underwriting.py` (`GET /underwriting/quotes/{qid}`)
- Test: `tests/test_underwriting_dossier.py` (new), `tests/test_underwriting_desk_api.py`

- [ ] **Step 1: Write the failing test**

Create `tests/test_underwriting_dossier.py` (reuse the `_session`/`_requested_quote` helpers — import them or duplicate the small fixture from `test_underwriting_desk.py`):
```python
from datetime import date
from sqlmodel import Session, SQLModel, create_engine
from app.models import Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.submissions import create_submission, submit_to_market
from app.services.underwriting_desk import decision_dossier

VENUE_ID = "elsewhere-brooklyn"


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
    seed_broker_platform_data(s)
    s.commit()
    return s


def _quote(s):
    sub = create_submission(s, venue_id=VENUE_ID, effective_date=date(2026, 11, 1),
                            coverage_lines=["gl", "liquor"], requested_limits={"gl": {"per_occurrence": "1000000"}},
                            actor_id="u-broker")
    s.commit()
    res = submit_to_market(s, sub.id, target_carriers=["markel-specialty"], submitted_by="u-broker")
    s.commit()
    return res.quotes_created[0]


def test_dossier_composes_all_sections():
    with _session() as s:
        q = _quote(s)
        d = decision_dossier(s, q.id)
        assert d["quote"]["id"] == q.id
        assert d["venue"]["name"]
        assert d["risk"]["tier"] in ("A", "B", "C", "D")
        assert "factors" in d["risk"]
        assert "summary" in d["loss_run"] or d["loss_run"] is None
        assert "open_count" in d["incidents"]
        assert "status" in d["compliance"]
        assert d["suggested_premium_breakdown"]["total"]
        assert d["decidable"] is True


def test_dossier_missing_quote_returns_none():
    with _session() as s:
        assert decision_dossier(s, "q-nope") is None


def test_dossier_unknown_venue_degrades_not_500():
    with _session() as s:
        q = _quote(s)
        from app.models import Submission
        sub = s.get(Submission, q.submission_id); sub.venue_id = "venue-x"; s.add(sub); s.commit()
        d = decision_dossier(s, q.id)
        assert d["suggested_premium_breakdown"] is None
        assert d["loss_run"] is None or d["loss_run"]["summary"]["claim_count"] == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_underwriting_dossier.py -q`
Expected: FAIL — `ImportError: cannot import name 'decision_dossier'`.

- [ ] **Step 3: Implement the composer (each section failure-isolated)**

In `app/services/underwriting_desk.py`:
```python
from app.models import ComplianceSignal, IncidentRecord  # add to imports

AWAITING_QUOTE_STATES_DECIDABLE = ("requested", "pending", "info_requested")


def decision_dossier(session: Session, quote_id: str) -> dict | None:
    """Full decision context for one quote, composed server-side. Returns None if
    the quote doesn't exist. Every section is failure-isolated (degrades to
    null/empty, never raises out of this function)."""
    q = session.get(CarrierQuote, quote_id)
    if q is None:
        return None
    sub = session.get(Submission, q.submission_id)
    venue_id = sub.venue_id if sub else None
    venue_name, risk = _venue_read(session, venue_id)   # reuse the Phase-1 helper

    return {
        "quote": {
            "id": q.id, "status": q.status,
            "premium_breakdown": q.premium_breakdown, "coverage_terms": q.coverage_terms,
            "decline_reason": q.decline_reason, "underwriter_name": q.underwriter_name,
            "info_request_note": q.info_request_note, "info_response_note": q.info_response_note,
        },
        "submission": {
            "id": sub.id if sub else None, "venue_id": venue_id,
            "effective_date": sub.effective_date.isoformat() if sub and sub.effective_date else None,
            "coverage_lines": sub.coverage_lines if sub else [],
            "requested_limits": sub.requested_limits if sub else {},
            "status": sub.status if sub else None,
        },
        "venue": {"id": venue_id, "name": venue_name,
                  "venue_type": _venue_type(venue_id)},
        "risk": _full_risk(session, venue_id),
        "loss_run": _loss_run_section(session, venue_id),
        "incidents": _incidents_section(session, venue_id),
        "compliance": _compliance_section(session, venue_id),
        "suggested_premium_breakdown": _suggested_breakdown(session, sub, q.carrier_id) if sub else None,
        "decidable": q.status in AWAITING_QUOTE_STATES_DECIDABLE,
    }


def _venue_type(venue_id):
    from app.seed_data import VENUES
    return VENUES.get(venue_id, {}).get("venue_type", "") if venue_id else ""


def _full_risk(session, venue_id) -> dict:
    try:
        from app.seed_data import VENUES
        from app.underwriting.scoring import get_risk_score
        if venue_id not in VENUES:
            return {"tier": "B", "total_score": 0, "factors": {}}
        r = get_risk_score(venue_id, VENUES, session=session)
        return {"tier": r.get("tier", "B"), "total_score": r.get("total_score", 0), "factors": r.get("factors", {})}
    except Exception:
        return {"tier": "B", "total_score": 0, "factors": {}}


def _loss_run_section(session, venue_id) -> dict | None:
    try:
        from app.services.loss_run import venue_loss_run
        lr = venue_loss_run(session, venue_id)
        return {"summary": lr["summary"], "by_coverage_line": lr["by_coverage_line"]}
    except Exception:
        return None


def _incidents_section(session, venue_id) -> dict:
    try:
        rows = session.exec(
            select(IncidentRecord).where(IncidentRecord.venue_id == venue_id)
            .where(IncidentRecord.status == "open")
        ).all()
        recent = sorted(rows, key=lambda i: i.created_at, reverse=True)[:5]
        return {"open_count": len(rows),
                "recent": [{"id": i.id, "summary": i.summary, "occurred_at": i.occurred_at} for i in recent]}
    except Exception:
        return {"open_count": 0, "recent": []}


def _compliance_section(session, venue_id) -> dict:
    try:
        from app.services.compliance_signals import open_signals_for
        rows = open_signals_for(venue_id, session)
        return {"status": "clear" if not rows else "open_items",
                "open_items": [{"title": r.title, "severity": r.severity} for r in rows]}
    except Exception:
        return {"status": "unknown", "open_items": []}
```

- [ ] **Step 4: Add the endpoint**

In `app/api/v1/underwriting.py`:
```python
from app.services.underwriting_desk import decision_dossier  # add to import
from fastapi import HTTPException

@router.get("/underwriting/quotes/{quote_id}")
def get_decision_dossier(
    quote_id: str,
    _user: dict = Depends(require_carrier),
    session: Session = Depends(get_session),
) -> dict:
    d = decision_dossier(session, quote_id)
    if d is None:
        raise HTTPException(status_code=404, detail=f"Quote {quote_id} not found")
    return d
```

- [ ] **Step 5: Add an API test**

Append to `tests/test_underwriting_desk_api.py`:
```python
def test_dossier_endpoint_carrier_only(client_qid):
    client, qid = client_qid
    ok = client.get(f"/api/underwriting/quotes/{qid}", headers=_carrier_headers())
    assert ok.status_code == 200
    body = ok.json()
    assert body["risk"]["tier"] in ("A", "B", "C", "D")
    assert body["suggested_premium_breakdown"]["total"]
    assert body["decidable"] is True
    denied = client.get(f"/api/underwriting/quotes/{qid}", headers=_broker_headers())
    assert denied.status_code == 403
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `python -m pytest tests/test_underwriting_dossier.py tests/test_underwriting_desk_api.py -q`
Expected: PASS (all).

- [ ] **Step 7: Run the full backend suite (regression gate)**

Run: `python -m pytest -q`
Expected: all pass (≥ 1089 + the new tests).

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/underwriting_desk.py backend/app/api/v1/underwriting.py backend/tests/test_underwriting_dossier.py backend/tests/test_underwriting_desk_api.py
git commit -F - <<'EOF'
feat(carrier): decision-dossier composer + GET /api/underwriting/quotes/{qid}

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Web client lib — dossier + terms + request-info

**Files:**
- Modify: `frontend/src/lib/underwriting.ts`
- Test: `tsc` (no unit harness for this lib today)

- [ ] **Step 1: Add types + calls**

Add to `frontend/src/lib/underwriting.ts`:
```typescript
export interface RiskFactor { score: number; weight: number; explanation?: string }
export interface Dossier {
  quote: { id: string; status: string; premium_breakdown: SuggestedBreakdown | null;
           coverage_terms: CoverageTerms; decline_reason: string | null;
           underwriter_name: string | null; info_request_note: string | null; info_response_note: string | null };
  submission: { id: string | null; venue_id: string | null; effective_date: string | null;
                coverage_lines: string[]; requested_limits: Record<string, Record<string, string>>; status: string | null };
  venue: { id: string | null; name: string; venue_type: string };
  risk: { tier: Tier; total_score: number; factors: Record<string, RiskFactor> };
  loss_run: { summary: Record<string, string | number>; by_coverage_line: any[] } | null;
  incidents: { open_count: number; recent: { id: string; summary: string; occurred_at: string }[] };
  compliance: { status: string; open_items: { title: string; severity: string }[] };
  suggested_premium_breakdown: SuggestedBreakdown | null;
  decidable: boolean;
}
export interface Subjectivity { text: string; status: "open" | "met" | "waived" }
export interface ScheduleMod { category: string; kind: "credit" | "debit"; pct: string }
export interface CoverageTerms {
  lines?: Record<string, { limit?: string; deductible?: string; sublimit?: string | null }>;
  subjectivities?: Subjectivity[]; exclusions?: string[]; endorsements?: string[];
  schedule_mods?: ScheduleMod[]; valid_until?: string;
}

export async function fetchDossier(qid: string): Promise<Dossier> {
  const res = await fetch(`${API_URL}/api/underwriting/quotes/${qid}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Dossier load failed (${res.status})`);
  return res.json();
}

export async function requestInfo(qid: string, note: string): Promise<{ status: string }> {
  const res = await fetch(`${API_URL}/api/quotes/${qid}/request-info`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.detail?.message ?? e?.detail ?? `Request failed (${res.status})`); }
  return res.json();
}
```
Extend the existing `underwriteQuote` payload union so the `quote` decision can carry `coverage_terms?: CoverageTerms`.

- [ ] **Step 2: Verify types compile**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep "src/lib/underwriting" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/underwriting.ts
git commit -F - <<'EOF'
feat(carrier-web): dossier + structured-terms + request-info client lib

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Web decision page — B layout (dossier-driven)

**Files:**
- Rewrite: `frontend/src/app/underwriting/[qid]/page.tsx`

**Run `ui-ux-pro-max` for the visual build (match the `lc-*` system: tabular money, accessible tier color, error-below-field, loading/disabled states, single primary CTA).**

- [ ] **Step 1: Replace the queue-find data load with the dossier endpoint**

Use `fetchDossier(qid)` on mount (replaces the "fetch whole queue and find qid" code). Keep the carrier guard + `notInQueue`→"already decided" state (now driven by `dossier === null` 404 → catch → show the decided/not-found card).

- [ ] **Step 2: Render the B layout** (top→bottom), all in `lc-shell`/`lc-card`:
  1. Header: "‹ Desk" back, eyebrow `CARRIER · UNDERWRITING DECISION`, venue name, coverage + effective.
  2. **KPI band** (`lc-meta-cell` row): TierBadge + score · open incidents (`dossier.incidents.open_count`) · compliance (`dossier.compliance.status` + count) · loss-run headline (`dossier.loss_run?.summary.total_incurred`, if present). Color never the only signal.
  3. **Suggested premium** card (existing per-line breakdown render; keep `fmtMoney`, tabular figures).
  4. **Structured terms** form: per-line `limit`/`deductible`/`sublimit` inputs prefilled from `dossier.submission.requested_limits`; a **subjectivities** editor (add/remove rows, each text + a status `<select>` open/met/waived rendered as a chip); `exclusions` + `endorsements` (free-text add/remove lists); `schedule_mods` (category + kind + pct rows); `valid_until` date input. Assemble into a `CoverageTerms` object.
  5. **Actions** (one primary CTA): **Quote at $X** (editable total → `rescaleBreakdownToTotal`, submits `underwriteQuote(qid, {decision:"quote", premium_breakdown, coverage_terms})`); **Decline** (reason); **Request info** (note → `requestInfo`). Disable while submitting; show form error below.
  6. **Dossier accordions** (`<details>`): Risk factors (bar per `dossier.risk.factors`), Loss run (by-line table), Incidents (recent list), Compliance (open items). Collapsed by default.

- [ ] **Step 3: Verify compile + visual smoke**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep "app/underwriting" || echo "clean"`
Expected: `clean`. Then load the page as the carrier demo user against a running backend and confirm the dossier renders, a quote with subjectivities submits (200), and request-info flips the row.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/underwriting/[qid]/page.tsx
git commit -F - <<'EOF'
feat(carrier-web): B-layout decision page (dossier + structured terms + request-info)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Broker info-response surface

**Files:**
- Modify: the broker submission-detail page. **First confirm the path:** run `cd frontend && npx grep` equivalent — `rg -l "requested_limits|CarrierQuote|quotes" src/app/submissions` — likely `frontend/src/app/submissions/[id]/page.tsx`.

- [ ] **Step 1: Locate the quote list on the broker submission detail**

Run: `cd frontend && rg -n "info_requested|quote.status|record-response|build-indicative" src/app/submissions` to find where quotes are rendered.

- [ ] **Step 2: Add the respond control**

For any quote with `status === "info_requested"`, render the carrier's question (`quote.info_request_note`) + a textarea + "Respond & re-queue" button that POSTs `/api/quotes/{qid}/info-response` with `{ note }` (use `authHeaders()`), then refetches. Mirror the operator-response control in `frontend/src/app/underwriter/[id]/page.tsx` (the `submitOperatorResponse` shape).

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep "app/submissions" || echo "clean"`
Expected: `clean`. Manually: carrier requests info → broker submission detail shows the question → broker responds → quote returns to the carrier queue.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/submissions
git commit -F - <<'EOF'
feat(broker-web): respond to a carrier info request (re-queues the quote)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10: Web queue rows + back-home fix + desk KPI strip

**Files:**
- Modify: `frontend/src/app/underwriting/page.tsx`
- Modify: `frontend/src/components/layout/AppShell.tsx`

- [ ] **Step 1: Richer queue rows + KPI strip**

In `underwriting/page.tsx`: add to each row a status chip (so `info_requested` shows) and the effective date / requested-limit summary. Add a desk KPI strip (`lc-hero__meta` cells) computed from the queue: awaiting-decision count, info-requested count, oldest-in-queue (min effective/age). (These are queue-derived only; loss-ratio/hit-ratio wait for the C5 portfolio spec.)

- [ ] **Step 2: Back-home fix for carrier**

In `AppShell.tsx`, the `showBackHome`/back link currently targets `/dashboard`. For a carrier (`role === "carrier"`), target `/underwriting` instead:
```tsx
const homeHref = role === "carrier" ? "/underwriting" : "/dashboard";
const showBackHome = !!pathname && pathname !== homeHref;
// ...use homeHref in the <Link href=...> and the "back to home" target
```

- [ ] **Step 3: Verify**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep -E "app/underwriting/page|layout/AppShell" || echo "clean"`
Expected: `clean`. Manually: carrier never hops through `/dashboard`; `info_requested` quotes are visible in the queue.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/underwriting/page.tsx frontend/src/components/layout/AppShell.tsx
git commit -F - <<'EOF'
feat(carrier-web): richer queue rows, desk KPI strip, carrier back-home fix

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 11: Mobile client lib — dossier + terms + request-info

**Files:**
- Modify: `mobile/src/api/underwriting.ts`

- [ ] **Step 1: Mirror the web lib**

Add `Dossier`, `CoverageTerms`, `Subjectivity`, `ScheduleMod`, `RiskFactor` interfaces (identical shape to web Task 7), plus:
```typescript
export async function fetchDossier(qid: string): Promise<Dossier> {
  return api.request<Dossier>(`/api/underwriting/quotes/${qid}`);
}
export async function requestInfo(qid: string, note: string): Promise<{ status: string }> {
  // custom fetch (like underwriteQuote) so the server message is parsed on error
  const token = await getToken();
  const res = await fetch(`${API_URL}/api/quotes/${qid}/request-info`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ note }),
  });
  if (!res.ok) { let m = `Request failed (${res.status})`; try { const b = await res.json(); m = typeof b?.detail === "string" ? b.detail : b?.detail?.message ?? m; } catch {} throw new Error(m); }
  return res.json();
}
```
Extend `underwriteQuote`'s `quote` payload to carry `coverage_terms?: CoverageTerms`.

- [ ] **Step 2: Verify + commit**

Run: `cd mobile && npx tsc --noEmit 2>&1 | tail -3` (expect exit 0)
```bash
git add mobile/src/api/underwriting.ts
git commit -F - <<'EOF'
feat(carrier-mobile): dossier + terms + request-info api

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 12: Mobile decision screen — B layout + terms + request-info; richer rows

**Files:**
- Rewrite: `mobile/src/screens/UnderwriteDecisionScreen.tsx`
- Modify: `mobile/src/screens/UnderwritingDeskScreen.tsx`

**Run `ui-ux-pro-max` for the mobile visual build (RN: reuse the `Field` primitive, theme tokens, tier heat ramp, accessible chips).**

- [ ] **Step 1: Decision screen → dossier-driven B layout**

Replace the queue-find load with `fetchDossier(qid)`. Render top→bottom (single ScrollView): KPI band (tier+score, open incidents, compliance) → suggested premium card → structured-terms form (reuse `Field`; subjectivities as add/remove rows with a status chip; schedule_mods rows; valid_until) → actions (Quote at $X / Decline / Request info) → accordion dossier sections (risk factors, loss run, incidents, compliance) using collapsible `Pressable` headers. On request-info: call `requestInfo(qid, note)` then `navigation.goBack()`.

- [ ] **Step 2: Richer desk rows**

In `UnderwritingDeskScreen.tsx`, add a status chip (surfaces `info_requested`) + effective date to each row (mirror web Task 10).

- [ ] **Step 3: Verify + commit**

Run: `cd mobile && npx tsc --noEmit 2>&1 | tail -3` (expect exit 0)
```bash
git add mobile/src/screens/UnderwriteDecisionScreen.tsx mobile/src/screens/UnderwritingDeskScreen.tsx
git commit -F - <<'EOF'
feat(carrier-mobile): B-layout decision screen + richer desk rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 13: Full verification

- [ ] **Step 1: Backend regression gate**

Run: `cd backend && python -m pytest -q`
Expected: all pass (≥ 1089 baseline + new tests).

- [ ] **Step 2: Type-check both frontends**

Run: `cd frontend && npx tsc --noEmit 2>&1 | grep "^src/" || echo "web clean"`
Run: `cd mobile && npx tsc --noEmit 2>&1 | tail -3` (exit 0)
Expected: `web clean`; mobile exit 0.

- [ ] **Step 3: Manual end-to-end loop** (carrier + broker demo users, running backend)

  1. Carrier opens Brooklyn Mirage → dossier renders (risk factors, loss run, incidents, compliance).
  2. Carrier adds a subjectivity + sets valid-until + Quote → 200, returns to desk.
  3. On a second submission, carrier Request-info → quote shows `info_requested` in the queue.
  4. Broker opens that submission → sees the question → responds → quote re-queues to the carrier.

- [ ] **Step 4: Push**

```bash
git push
```

---

## Landmines (carry from spec §6)
- Neon `Column(JSON)` returns **strings** — `coverage_terms` / `requested_limits` / `premium_breakdown` coerce at the read boundary; the dossier composer is the single place to get this right.
- New `CarrierQuote` columns need the `_COLUMN_MIGRATIONS` allowlist rows (Task 1) — without them, existing-table SELECTs fail "no such column" on Postgres.
- Every status mutation goes through `_transition_carrier_quote` (Tasks 2) — never set `q.status` ad-hoc.
- After adding columns locally, `rm backend/database.db` if a stale local DB lacks them (or rely on the migration; the allowlist handles existing tables).
