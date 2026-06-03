# Carrier AI Underwriting Memo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an advisory, eval-gated `UnderwritingRecommendation` (posture + subjectivities + rate-adequacy + rationale) to the carrier quote-decision dossier, with a deterministic-first recommender and 3 CI-gated eval scorers.

**Architecture:** A **pure** deterministic recommender (`app/underwriting/recommender.py`) takes a typed input bundle (tier, loss-by-line, indicated premium, requested exposure, optional appetite) and returns an `UnderwritingRecommendation`. A thin service adapts the already-assembled dossier pieces into that bundle (failure-isolated → `None`). The dossier endpoint surfaces it; `underwrite_quote` snapshots it to the audit trail. Eval scenarios feed the bundle directly (no DB), so the 3 scorers run on the deterministic stack — the reproducible pitch number.

**Tech Stack:** Python 3 / FastAPI / SQLModel / Pydantic; `Decimal` money (strings in JSON); existing eval harness (`app/evals/`); Next.js + React Native for UI.

Spec: `docs/superpowers/specs/2026-06-03-carrier-ai-underwriting-memo-design.md`

---

## File Structure

**Backend (Phase A — the differentiator, shippable alone):**
- Create `backend/app/underwriting/recommender.py` — pure deterministic recommender (the rules) + `RecommenderInputs` dataclass.
- Modify `backend/app/schemas/domain.py` — add `UnderwritingRecommendation` Pydantic model.
- Create `backend/app/services/underwriting_memo.py` — `recommend_underwriting(...)` adapter (dossier pieces → inputs → recommender), failure-isolated.
- Modify `backend/app/services/underwriting_desk.py` — `decision_dossier` adds `"underwriting_recommendation"`; `underwrite_quote` emits an additive audit event with the recommendation snapshot + followed/overrode.
- Create `backend/app/evals/underwriting_scenarios.py` — labeled scenario fixtures.
- Create `backend/app/evals/underwriting_scorers.py` — `posture_match`, `recommendation_faithfulness`, `rate_adequacy_match`.
- Modify `backend/app/evals/runner.py` + `baseline.py` — register + snapshot the new scorers.
- Tests: `backend/tests/test_underwriting_recommender.py`, `test_underwriting_memo_service.py`, `test_underwriting_dossier_recommendation.py`, `test_underwriting_scorers.py`.

**Frontend/mobile (Phase B):**
- Modify `frontend/src/lib/underwriting.ts` (Dossier interface) + `frontend/src/app/underwriting/[qid]/page.tsx` (advisory card).
- Modify `mobile/src/api/underwriting.ts` (Dossier interface) + `mobile/src/screens/UnderwriteDecisionScreen.tsx` (advisory card).

---

# PHASE A — Backend + Eval

## Task 1: `UnderwritingRecommendation` schema

**Files:**
- Modify: `backend/app/schemas/domain.py` (add near `UnderwritingMemo`, ~line 83)
- Test: `backend/tests/test_underwriting_recommender.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_underwriting_recommender.py
from app.schemas.domain import UnderwritingRecommendation


def test_recommendation_schema_fields():
    r = UnderwritingRecommendation(
        posture="quote_with_conditions",
        summary="s",
        rationale="r",
        subjectivities=["subject to inspection"],
        rate_adequacy="lean_debit",
        rate_adequacy_note="thin vs losses",
        confidence=0.75,
        grounding={"tier": "C"},
        provider="deterministic-uw-v1",
        model=None,
        mode="deterministic",
        fallback_reason=None,
    )
    assert r.posture == "quote_with_conditions"
    assert r.rate_adequacy == "lean_debit"
    assert r.subjectivities == ["subject to inspection"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_underwriting_recommender.py::test_recommendation_schema_fields -v`
Expected: FAIL — `ImportError: cannot import name 'UnderwritingRecommendation'`.

- [ ] **Step 3: Add the model**

In `backend/app/schemas/domain.py`, immediately after the `UnderwritingMemo` class:

```python
class UnderwritingRecommendation(BaseModel):
    """Carrier submission-underwriting decision support (distinct from the
    incident-layer UnderwritingMemo). Advisory: the carrier always confirms."""
    posture: str          # "quote" | "quote_with_conditions" | "decline"
    summary: str
    rationale: str
    subjectivities: List[str] = []
    rate_adequacy: str    # "adequate" | "lean_debit" | "lean_credit"
    rate_adequacy_note: str
    confidence: float
    grounding: dict = {}
    provider: Optional[str] = None
    model: Optional[str] = None
    mode: Optional[str] = None          # "deterministic" | "llm"
    fallback_reason: Optional[str] = None
```

(Confirm `List`, `Optional`, `BaseModel` are already imported at the top of the file — they are, used by `UnderwritingMemo`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_underwriting_recommender.py::test_recommendation_schema_fields -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/schemas/domain.py backend/tests/test_underwriting_recommender.py
git commit -F - <<'EOF'
feat(carrier): add UnderwritingRecommendation schema

Decision-support memo for the carrier quote dossier; named distinctly
from the incident-layer UnderwritingMemo.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Deterministic recommender — `RecommenderInputs` + posture

**Files:**
- Create: `backend/app/underwriting/recommender.py`
- Test: `backend/tests/test_underwriting_recommender.py`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```python
from decimal import Decimal
from app.underwriting.recommender import RecommenderInputs, recommend


def _inputs(**over):
    base = dict(
        tier="B", total_score=40, coverage_lines=["gl"],
        loss_by_line={}, indicated_total=Decimal("10000"),
        in_appetite=True,
    )
    base.update(over)
    return RecommenderInputs(**base)


def test_clean_low_risk_quotes():
    r = recommend(_inputs(tier="A", total_score=20, loss_by_line={}))
    assert r.posture == "quote"
    assert r.subjectivities == []


def test_out_of_appetite_declines():
    r = recommend(_inputs(in_appetite=False))
    assert r.posture == "decline"


def test_adverse_loss_gets_conditions():
    r = recommend(_inputs(
        tier="B",
        loss_by_line={"gl": {"claim_count": 2, "incurred": Decimal("60000")}},
    ))
    assert r.posture == "quote_with_conditions"
    assert any("security" in s.lower() for s in r.subjectivities)


def test_worst_tier_with_adverse_loss_declines():
    r = recommend(_inputs(
        tier="D", total_score=90,
        loss_by_line={"gl": {"claim_count": 3, "incurred": Decimal("120000")}},
    ))
    assert r.posture == "decline"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_underwriting_recommender.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.underwriting.recommender'`.

- [ ] **Step 3: Create the recommender (posture + subjectivities first)**

```python
# backend/app/underwriting/recommender.py
"""Deterministic carrier underwriting recommender — a PURE function over a typed
input bundle. No DB, no I/O → reproducible (the eval pitch number) and trivially
testable. The pricing engine owns the premium NUMBER; this owns judgment."""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from app.schemas.domain import UnderwritingRecommendation

PROVIDER_NAME = "deterministic-uw-v1"

# Tiers run A (best) → D (worst).
_ELEVATED_TIERS = {"C", "D"}
_ADVERSE_INCURRED = Decimal("50000")   # total incurred at/above this = adverse
_ADVERSE_FREQUENCY = 2                  # claim_count on a line at/above this = adverse


@dataclass(frozen=True)
class RecommenderInputs:
    tier: str                              # "A" | "B" | "C" | "D"
    total_score: int                       # 0-100
    coverage_lines: list[str]
    loss_by_line: dict                     # line -> {"claim_count": int, "incurred": Decimal}
    indicated_total: Decimal               # engine's indicated premium total
    in_appetite: bool | None = None        # None = not evaluated here
    requested_limits: dict = field(default_factory=dict)


def _total_incurred(loss_by_line: dict) -> Decimal:
    return sum((Decimal(v.get("incurred", 0)) for v in loss_by_line.values()), Decimal("0"))


def _is_adverse(loss_by_line: dict) -> bool:
    if _total_incurred(loss_by_line) >= _ADVERSE_INCURRED:
        return True
    return any(int(v.get("claim_count", 0)) >= _ADVERSE_FREQUENCY for v in loss_by_line.values())


_SUBJECTIVITY_BY_LINE = {
    "liquor": "Subject to current liquor-liability and server-training certificates.",
    "gl": "Subject to a security-staffing plan and incident-log review.",
    "assault_battery": "Subject to a security-staffing plan and incident-log review.",
}


def _subjectivities(inputs: RecommenderInputs, adverse: bool) -> list[str]:
    subs: list[str] = []
    for line, agg in inputs.loss_by_line.items():
        if int(agg.get("claim_count", 0)) >= 1 and line in _SUBJECTIVITY_BY_LINE:
            note = _SUBJECTIVITY_BY_LINE[line]
            if note not in subs:
                subs.append(note)
    if inputs.tier in _ELEVATED_TIERS:
        subs.append("Subject to a satisfactory loss-control inspection.")
    return subs


def _posture(inputs: RecommenderInputs, adverse: bool) -> str:
    if inputs.in_appetite is False:
        return "decline"
    if inputs.tier == "D" and adverse:
        return "decline"
    if inputs.tier in _ELEVATED_TIERS or adverse:
        return "quote_with_conditions"
    return "quote"


def recommend(inputs: RecommenderInputs) -> UnderwritingRecommendation:
    adverse = _is_adverse(inputs.loss_by_line)
    posture = _posture(inputs, adverse)
    subjectivities = _subjectivities(inputs, adverse) if posture == "quote_with_conditions" else []
    # rate-adequacy + summary/rationale filled in Task 3
    return UnderwritingRecommendation(
        posture=posture,
        summary="",
        rationale="",
        subjectivities=subjectivities,
        rate_adequacy="adequate",
        rate_adequacy_note="",
        confidence=0.75,
        grounding={},
        provider=PROVIDER_NAME,
        mode="deterministic",
    )
```

- [ ] **Step 4: Run to verify the posture tests pass**

Run: `cd backend && python -m pytest tests/test_underwriting_recommender.py -v`
Expected: PASS (schema + 4 posture tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/recommender.py backend/tests/test_underwriting_recommender.py
git commit -F - <<'EOF'
feat(carrier): deterministic underwriting recommender — posture + subjectivities

Pure function over a typed input bundle (tier/loss/appetite); engine still
owns the premium number.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Recommender — rate-adequacy + summary/rationale + grounding

**Files:**
- Modify: `backend/app/underwriting/recommender.py`
- Test: `backend/tests/test_underwriting_recommender.py`

- [ ] **Step 1: Write the failing tests** (append)

```python
def test_rate_adequacy_lean_debit_when_losses_heavy_vs_premium():
    r = recommend(_inputs(
        indicated_total=Decimal("10000"),
        loss_by_line={"gl": {"claim_count": 1, "incurred": Decimal("9000")}},
    ))
    assert r.rate_adequacy == "lean_debit"


def test_rate_adequacy_lean_credit_when_premium_generous():
    r = recommend(_inputs(
        indicated_total=Decimal("10000"),
        loss_by_line={"gl": {"claim_count": 1, "incurred": Decimal("1000")}},
    ))
    assert r.rate_adequacy == "lean_credit"


def test_rate_adequacy_adequate_with_no_losses():
    r = recommend(_inputs(loss_by_line={}, indicated_total=Decimal("10000")))
    assert r.rate_adequacy == "adequate"


def test_summary_and_grounding_reference_real_numbers():
    r = recommend(_inputs(
        tier="C", total_score=68,
        loss_by_line={"gl": {"claim_count": 2, "incurred": Decimal("60000")}},
        indicated_total=Decimal("18500"),
    ))
    assert "C" in r.summary
    assert "60000" in r.summary or "60,000" in r.summary
    # faithfulness: every number in grounding, prose references only grounded values
    assert r.grounding["tier"] == "C"
    assert r.grounding["total_score"] == 68
    assert r.grounding["indicated_total"] == "18500"
    assert r.grounding["total_incurred"] == "60000"
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_underwriting_recommender.py -v`
Expected: FAIL (rate_adequacy is hardcoded "adequate"; summary empty; grounding empty).

- [ ] **Step 3: Implement rate-adequacy + summary + grounding**

Replace the body of `recommend(...)` in `recommender.py`:

```python
def _rate_adequacy(total_incurred: Decimal, indicated_total: Decimal) -> tuple[str, str]:
    if indicated_total <= 0:
        return "adequate", "No indicated premium to assess."
    if total_incurred == 0:
        return "adequate", (
            f"No prior loss history; indicated premium ${indicated_total:,.0f} stands as adequate."
        )
    ratio = total_incurred / indicated_total
    if ratio >= Decimal("0.8"):
        return "lean_debit", (
            f"Prior incurred (${total_incurred:,.0f}) is high relative to the indicated "
            f"premium (${indicated_total:,.0f}); the rate looks thin — lean debit."
        )
    if ratio <= Decimal("0.3"):
        return "lean_credit", (
            f"Prior incurred (${total_incurred:,.0f}) is low relative to the indicated "
            f"premium (${indicated_total:,.0f}); room to credit a clean account."
        )
    return "adequate", (
        f"Indicated premium (${indicated_total:,.0f}) is broadly adequate for the "
        f"loss picture (${total_incurred:,.0f} incurred)."
    )


def recommend(inputs: RecommenderInputs) -> UnderwritingRecommendation:
    adverse = _is_adverse(inputs.loss_by_line)
    posture = _posture(inputs, adverse)
    subjectivities = _subjectivities(inputs, adverse) if posture == "quote_with_conditions" else []
    total_incurred = _total_incurred(inputs.loss_by_line)
    rate_adequacy, rate_note = _rate_adequacy(total_incurred, inputs.indicated_total)

    claim_count = sum(int(v.get("claim_count", 0)) for v in inputs.loss_by_line.values())
    summary = (
        f"Tier {inputs.tier} risk (score {inputs.total_score}) across "
        f"{', '.join(inputs.coverage_lines) or 'no lines'}. "
        f"{claim_count} prior loss(es), ${total_incurred:,.0f} incurred. "
        f"Indicated premium ${inputs.indicated_total:,.0f}."
    )
    posture_phrase = {
        "quote": "Clean enough to quote on standard terms.",
        "quote_with_conditions": "Writable, but attach the subjectivities below.",
        "decline": "Recommend declining — exposure outweighs the risk appetite at this tier and loss level.",
    }[posture]
    rationale = f"{posture_phrase} {rate_note}"

    grounding = {
        "tier": inputs.tier,
        "total_score": inputs.total_score,
        "coverage_lines": list(inputs.coverage_lines),
        "claim_count": claim_count,
        "total_incurred": str(total_incurred),
        "indicated_total": str(inputs.indicated_total),
        "in_appetite": inputs.in_appetite,
    }

    return UnderwritingRecommendation(
        posture=posture,
        summary=summary,
        rationale=rationale,
        subjectivities=subjectivities,
        rate_adequacy=rate_adequacy,
        rate_adequacy_note=rate_note,
        confidence=0.75,
        grounding=grounding,
        provider=PROVIDER_NAME,
        mode="deterministic",
    )
```

- [ ] **Step 4: Run to verify all recommender tests pass**

Run: `cd backend && python -m pytest tests/test_underwriting_recommender.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/app/underwriting/recommender.py backend/tests/test_underwriting_recommender.py
git commit -F - <<'EOF'
feat(carrier): recommender rate-adequacy + grounded summary/rationale

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `recommend_underwriting` service adapter (failure-isolated)

**Files:**
- Create: `backend/app/services/underwriting_memo.py`
- Test: `backend/tests/test_underwriting_memo_service.py`

- [ ] **Step 1: Write the failing tests**

```python
# backend/tests/test_underwriting_memo_service.py
from app.services.underwriting_memo import recommendation_from_dossier_parts


def test_maps_dossier_parts_to_recommendation():
    rec = recommendation_from_dossier_parts(
        risk={"tier": "C", "total_score": 68},
        loss_run={"by_coverage_line": [
            {"coverage_line": "gl", "claim_count": 2, "incurred": "60000"},
        ]},
        coverage_lines=["gl"],
        suggested_premium_breakdown={"total": "18500"},
        in_appetite=None,
    )
    assert rec is not None
    assert rec.posture == "quote_with_conditions"
    assert rec.rate_adequacy == "lean_debit"


def test_failure_isolated_returns_none_on_bad_input():
    # missing risk → must not raise; returns None (never 500 the dossier)
    rec = recommendation_from_dossier_parts(
        risk=None, loss_run=None, coverage_lines=[],
        suggested_premium_breakdown=None, in_appetite=None,
    )
    assert rec is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && python -m pytest tests/test_underwriting_memo_service.py -v`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement the adapter**

```python
# backend/app/services/underwriting_memo.py
"""Adapt the already-assembled carrier dossier pieces into the recommender's
typed inputs and run it. Failure-isolated: ANY error → None, so the dossier
endpoint never 500s (mirrors reserve_hint in adjusting.py)."""
from __future__ import annotations

from decimal import Decimal

from app.schemas.domain import UnderwritingRecommendation
from app.underwriting.recommender import RecommenderInputs, recommend


def recommendation_from_dossier_parts(
    *,
    risk: dict | None,
    loss_run: dict | None,
    coverage_lines: list[str] | None,
    suggested_premium_breakdown: dict | None,
    in_appetite: bool | None = None,
) -> UnderwritingRecommendation | None:
    try:
        if not risk or not suggested_premium_breakdown:
            return None
        # Coerce loss_run by-line (JSON money strings → Decimal) at the read boundary.
        loss_by_line: dict = {}
        for row in (loss_run or {}).get("by_coverage_line", []) or []:
            line = row.get("coverage_line")
            if not line:
                continue
            loss_by_line[line] = {
                "claim_count": int(row.get("claim_count", 0)),
                "incurred": Decimal(str(row.get("incurred", "0") or "0")),
            }
        inputs = RecommenderInputs(
            tier=str(risk.get("tier", "")),
            total_score=int(risk.get("total_score", 0)),
            coverage_lines=list(coverage_lines or []),
            loss_by_line=loss_by_line,
            indicated_total=Decimal(str(suggested_premium_breakdown.get("total", "0") or "0")),
            in_appetite=in_appetite,
        )
        return recommend(inputs)
    except Exception:  # noqa: BLE001 — advisory only, never block the desk
        return None
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && python -m pytest tests/test_underwriting_memo_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/underwriting_memo.py backend/tests/test_underwriting_memo_service.py
git commit -F - <<'EOF'
feat(carrier): underwriting-memo service adapter (failure-isolated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Surface on the dossier endpoint

**Files:**
- Modify: `backend/app/services/underwriting_desk.py` (`decision_dossier`, returns dict at ~lines 288-309)
- Test: `backend/tests/test_underwriting_dossier_recommendation.py`

- [ ] **Step 1: Write the failing test**

Reuse the existing carrier-dossier test fixtures. Pattern (mirror `tests/test_underwriting_desk_api.py` setup for a seeded quote with a venue that has risk + an in-flight quote):

```python
# backend/tests/test_underwriting_dossier_recommendation.py
from app.services.underwriting_desk import decision_dossier
# Reuse the shared fixture that seeds a venue + submission + escalated quote.
# (Import the same helpers the existing underwriting_desk tests use.)
from tests.test_underwriting_desk import _seed_quote_for_dossier  # if present; else inline-seed like that test


def test_dossier_includes_underwriting_recommendation(session_with_quote):
    session, quote_id = session_with_quote
    d = decision_dossier(session, quote_id)
    assert "underwriting_recommendation" in d
    rec = d["underwriting_recommendation"]
    # Either a dict with a posture, or None — but the key must exist.
    assert rec is None or rec["posture"] in {"quote", "quote_with_conditions", "decline"}
```

> Note for the implementer: if `tests/test_underwriting_desk.py` has no reusable fixture, inline-seed exactly as that file does (venue with `get_risk_score` data, a `Submission`, and a `CarrierQuote` escalated to the desk), then call `decision_dossier`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_underwriting_dossier_recommendation.py -v`
Expected: FAIL — `KeyError: 'underwriting_recommendation'`.

- [ ] **Step 3: Add the key in `decision_dossier`**

In `backend/app/services/underwriting_desk.py`, inside `decision_dossier`, after the `risk`, `loss_run`, and `suggested_premium_breakdown` locals are computed and before the `return {...}`:

```python
    from app.services.underwriting_memo import recommendation_from_dossier_parts
    _rec = recommendation_from_dossier_parts(
        risk=risk,
        loss_run=loss_run,
        coverage_lines=(sub.coverage_lines if sub else []),
        suggested_premium_breakdown=suggested_premium_breakdown,
        in_appetite=None,  # appetite wiring is a fast-follow; recommender handles None
    )
```

Then add to the returned dict (top level, alongside `"suggested_premium_breakdown"`):

```python
        "underwriting_recommendation": _rec.model_dump() if _rec else None,
```

(Use the actual local variable names present in `decision_dossier` for `risk` / `loss_run` / `suggested_premium_breakdown` / `sub`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/test_underwriting_dossier_recommendation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/underwriting_desk.py backend/tests/test_underwriting_dossier_recommendation.py
git commit -F - <<'EOF'
feat(carrier): surface underwriting_recommendation on the quote dossier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Audit snapshot on `underwrite_quote` (followed/overrode)

**Files:**
- Modify: `backend/app/services/underwriting_desk.py` (`underwrite_quote`)
- Test: `backend/tests/test_underwriting_desk_api.py` (add a case) or `test_underwriting_dossier_recommendation.py`

- [ ] **Step 1: Write the failing test**

```python
def test_underwrite_quote_emits_recommendation_snapshot(session_with_quote):
    from app.services.underwriting_desk import underwrite_quote
    from app.packet_core import _audit_events_for  # if a helper exists; else query AuditEvent directly
    session, quote_id = session_with_quote
    underwrite_quote(session, quote_id, decision="quote", underwriter_id="user_003",
                     premium_breakdown={"total": "12000"}, coverage_terms=None)
    session.commit()
    # An audit event of type "quote.underwriting_recommendation" must carry the snapshot.
    from sqlmodel import select
    from app.models import AuditEvent
    rows = session.exec(select(AuditEvent).where(AuditEvent.entity_id == quote_id)).all()
    snap = [r for r in rows if r.event_type == "quote.underwriting_recommendation"]
    assert snap, "expected a recommendation-snapshot audit event"
    md = snap[0].event_metadata
    assert "recommended_posture" in md and "decision" in md and "followed" in md
```

> Implementer: confirm the audit model name/import (`AuditEvent`) and the `_add_audit_event` signature from `app/packet_core.py` — it is the same helper `record_carrier_response` already uses.

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_underwriting_dossier_recommendation.py::test_underwrite_quote_emits_recommendation_snapshot -v`
Expected: FAIL — no such audit event.

- [ ] **Step 3: Emit the additive audit event**

In `underwrite_quote` (underwriting_desk.py), after computing the decision but before/after the `record_carrier_response` call (it returns the quote `q`), add — additive, does NOT touch the shared `record_carrier_response`:

```python
    # Snapshot what the advisory recommendation WAS vs what the carrier DID
    # (feeds calibration). Failure-isolated — never block the decision.
    try:
        from app.packet_core import _add_audit_event
        from app.services.underwriting_memo import recommendation_from_dossier_parts
        dossier = decision_dossier(session, quote_id)
        rec = (dossier or {}).get("underwriting_recommendation")
        if rec is not None:
            followed = (
                (decision == "quote" and rec["posture"] in {"quote", "quote_with_conditions"})
                or (decision == "decline" and rec["posture"] == "decline")
            )
            _add_audit_event(
                session=session,
                actor_id=underwriter_id, actor_type="user",
                entity_type="quote", entity_id=quote_id,
                event_type="quote.underwriting_recommendation",
                event_metadata={
                    "recommended_posture": rec["posture"],
                    "recommended_rate_adequacy": rec["rate_adequacy"],
                    "decision": decision,
                    "followed": followed,
                    "decision_source": "carrier_desk",
                },
            )
    except Exception:  # noqa: BLE001 — advisory telemetry, never block underwriting
        pass
```

Place this so it runs for both `quote` and `decline` branches (e.g. compute `q = record_carrier_response(...)` into a local, emit the snapshot, then `return q`). Keep the existing return value.

- [ ] **Step 4: Run to verify it passes** + no regressions in the desk suite

Run: `cd backend && python -m pytest tests/test_underwriting_desk_api.py tests/test_underwriting_dossier_recommendation.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/underwriting_desk.py backend/tests/test_underwriting_dossier_recommendation.py
git commit -F - <<'EOF'
feat(carrier): snapshot recommendation vs decision to the audit trail

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Labeled eval scenarios

**Files:**
- Create: `backend/app/evals/underwriting_scenarios.py`
- Test: `backend/tests/test_underwriting_scorers.py`

Labels are assigned from **underwriting first principles**, not by reading the recommender rules (see spec — avoids a circular scorer). Each carries a `why`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_underwriting_scorers.py
from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS


def test_scenarios_are_well_formed():
    assert len(UNDERWRITING_SCENARIOS) >= 8
    for s in UNDERWRITING_SCENARIOS:
        assert s["expected_posture"] in {"quote", "quote_with_conditions", "decline"}
        assert s["expected_rate_adequacy"] in {"adequate", "lean_debit", "lean_credit"}
        assert "inputs" in s and "why" in s
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_underwriting_scorers.py::test_scenarios_are_well_formed -v`
Expected: FAIL — module missing.

- [ ] **Step 3: Create the scenarios**

```python
# backend/app/evals/underwriting_scenarios.py
"""Labeled carrier-underwriting scenarios for eval. Labels reflect what a real
underwriter would do — NOT the recommender's internal rules (avoids a circular
scorer). `inputs` is the RecommenderInputs kwargs (money as strings; coerced by
the scorer)."""

UNDERWRITING_SCENARIOS = [
    {
        "id": "clean-tier-a",
        "inputs": {"tier": "A", "total_score": 18, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "9000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "adequate",
        "why": "Clean low-tier account, no losses — straightforward quote.",
    },
    {
        "id": "clean-tier-b-generous-rate",
        "inputs": {"tier": "B", "total_score": 35, "coverage_lines": ["gl", "liquor"],
                   "loss_by_line": {"gl": {"claim_count": 1, "incurred": "1500"}},
                   "indicated_total": "12000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "lean_credit",
        "why": "Minor stale loss, premium generous vs incurred — writable, could credit.",
    },
    {
        "id": "prior-ab-elevated",
        "inputs": {"tier": "B", "total_score": 52, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 2, "incurred": "60000"}},
                   "indicated_total": "18500", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "lean_debit",
        "why": "Repeat GL/A&B losses — write it but attach security conditions; rate thin.",
    },
    {
        "id": "prior-liquor-loss",
        "inputs": {"tier": "C", "total_score": 64, "coverage_lines": ["liquor"],
                   "loss_by_line": {"liquor": {"claim_count": 1, "incurred": "40000"}},
                   "indicated_total": "22000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "lean_debit",
        "why": "Liquor loss at an elevated tier — conditions on service/training; $40k incurred on a $22k premium is thin, lean debit.",
    },
    {
        "id": "elevated-tier-c-clean",
        "inputs": {"tier": "C", "total_score": 60, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "15000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": "Higher-hazard tier even without losses — a loss-control inspection condition is prudent.",
    },
    {
        "id": "severe-tier-d-adverse",
        "inputs": {"tier": "D", "total_score": 88, "coverage_lines": ["gl", "liquor"],
                   "loss_by_line": {"gl": {"claim_count": 3, "incurred": "120000"}},
                   "indicated_total": "30000", "in_appetite": True},
        "expected_posture": "decline",
        "expected_rate_adequacy": "lean_debit",
        "why": "Worst tier with frequent severe losses — exposure outweighs appetite; decline.",
    },
    {
        "id": "out-of-appetite",
        "inputs": {"tier": "B", "total_score": 40, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "11000", "in_appetite": False},
        "expected_posture": "decline",
        "expected_rate_adequacy": "adequate",
        "why": "Out of appetite regardless of the loss picture — decline.",
    },
    {
        "id": "high-frequency-low-severity",
        "inputs": {"tier": "C", "total_score": 58, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 2, "incurred": "9000"}},
                   "indicated_total": "14000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": "Frequency signal (2 claims) at an elevated tier — conditions warranted, rate ok.",
    },
]
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/test_underwriting_scorers.py::test_scenarios_are_well_formed -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/underwriting_scenarios.py backend/tests/test_underwriting_scorers.py
git commit -F - <<'EOF'
feat(evals): labeled carrier-underwriting scenarios

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: The 3 scorers + aggregate run

**Files:**
- Create: `backend/app/evals/underwriting_scorers.py`
- Test: `backend/tests/test_underwriting_scorers.py`

- [ ] **Step 1: Write the failing tests** (append)

```python
from app.evals.underwriting_scorers import run_underwriting_evals


def test_deterministic_stack_scores_high():
    report = run_underwriting_evals()
    # The deterministic recommender should match the independently-labeled answer
    # key strongly. We assert a meaningful floor (not 100% — labels are independent).
    assert report["posture_accuracy"] >= 0.75
    assert report["rate_adequacy_accuracy"] >= 0.6
    assert report["faithfulness"] == 1.0   # deterministic is faithful by construction
    assert set(report) >= {"posture_accuracy", "rate_adequacy_accuracy", "faithfulness"}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/test_underwriting_scorers.py::test_deterministic_stack_scores_high -v`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement the scorers**

```python
# backend/app/evals/underwriting_scorers.py
"""Three scorers over the labeled underwriting scenarios, deterministic stack:
posture_match, recommendation_faithfulness, rate_adequacy_match. The aggregates
are the reproducible pitch numbers (no API key needed)."""
from __future__ import annotations

import re
from decimal import Decimal

from app.evals.underwriting_scenarios import UNDERWRITING_SCENARIOS
from app.underwriting.recommender import RecommenderInputs, recommend


def _inputs_from(raw: dict) -> RecommenderInputs:
    loss = {
        line: {"claim_count": int(v.get("claim_count", 0)),
               "incurred": Decimal(str(v.get("incurred", "0")))}
        for line, v in (raw.get("loss_by_line") or {}).items()
    }
    return RecommenderInputs(
        tier=raw["tier"], total_score=int(raw["total_score"]),
        coverage_lines=list(raw.get("coverage_lines", [])),
        loss_by_line=loss,
        indicated_total=Decimal(str(raw["indicated_total"])),
        in_appetite=raw.get("in_appetite"),
    )


def _faithful(rec, grounding_numbers: set[str]) -> bool:
    """Every multi-digit number in the prose must be a grounded value."""
    prose = f"{rec.summary} {rec.rationale}"
    nums = {n.replace(",", "") for n in re.findall(r"[\d,]{2,}", prose)}
    return nums.issubset(grounding_numbers)


def run_underwriting_evals() -> dict:
    posture_hits = rate_hits = faithful_hits = 0
    n = len(UNDERWRITING_SCENARIOS)
    for s in UNDERWRITING_SCENARIOS:
        rec = recommend(_inputs_from(s["inputs"]))
        if rec.posture == s["expected_posture"]:
            posture_hits += 1
        if rec.rate_adequacy == s["expected_rate_adequacy"]:
            rate_hits += 1
        grounded = {str(rec.grounding.get("total_score", "")),
                    str(rec.grounding.get("total_incurred", "")),
                    str(rec.grounding.get("indicated_total", "")),
                    str(rec.grounding.get("claim_count", ""))}
        grounded = {g for g in grounded if g}
        if _faithful(rec, grounded):
            faithful_hits += 1
    return {
        "posture_accuracy": posture_hits / n,
        "rate_adequacy_accuracy": rate_hits / n,
        "faithfulness": faithful_hits / n,
        "scenario_count": n,
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/test_underwriting_scorers.py -v`
Expected: PASS. If `posture_accuracy` or `rate_adequacy_accuracy` is below the floor, that is a REAL signal — either a recommender rule is wrong or a label is wrong. Investigate (do not just lower the floor); fix the rule or correct the independently-reasoned label, then re-run.

- [ ] **Step 5: Print the pitch numbers + commit**

Run: `cd backend && python -c "from app.evals.underwriting_scorers import run_underwriting_evals; print(run_underwriting_evals())"`
Record the printed accuracies in the commit body.

```bash
git add backend/app/evals/underwriting_scorers.py backend/tests/test_underwriting_scorers.py
git commit -F - <<'EOF'
feat(evals): underwriting recommender scorers (posture/faithfulness/rate-adequacy)

Deterministic-stack pitch numbers: posture <X>, rate-adequacy <Y>, faithfulness 1.0.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

- [ ] **Step 6: Full backend suite (no regressions)**

Run: `cd backend && python -m pytest -q`
Expected: all pass (prior count + the new tests).

---

# PHASE B — UI (web + mobile)

## Task 9: Web advisory card

**Files:**
- Modify: `frontend/src/lib/underwriting.ts` (add to `Dossier` interface)
- Modify: `frontend/src/app/underwriting/[qid]/page.tsx` (render the card)

- [ ] **Step 1: Extend the `Dossier` interface**

In `frontend/src/lib/underwriting.ts`, add to the `Dossier` interface (after `suggested_premium_breakdown`):

```typescript
  underwriting_recommendation: {
    posture: "quote" | "quote_with_conditions" | "decline";
    summary: string;
    rationale: string;
    subjectivities: string[];
    rate_adequacy: "adequate" | "lean_debit" | "lean_credit";
    rate_adequacy_note: string;
    confidence: number;
  } | null;
```

- [ ] **Step 2: Render the advisory card**

In `frontend/src/app/underwriting/[qid]/page.tsx`, render above the decision form when `dossier.underwriting_recommendation` is present. Use the existing `lc-card` + token styles (match the dossier sections already on the page). Posture → chip color: quote = `var(--state-success)`, quote_with_conditions = `var(--state-warning)`, decline = `var(--state-error)`.

```tsx
{dossier.underwriting_recommendation && (() => {
  const r = dossier.underwriting_recommendation!;
  const postureColor = r.posture === "quote" ? "var(--state-success)"
    : r.posture === "decline" ? "var(--state-error)" : "var(--state-warning)";
  const postureLabel = r.posture === "quote" ? "Quote"
    : r.posture === "decline" ? "Decline" : "Quote with conditions";
  return (
    <div className="lc-card" style={{ marginBottom: "var(--space-lg)", borderLeft: `3px solid ${postureColor}` }}>
      <div className="lc-card__inner">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)", marginBottom: "var(--space-sm)" }}>
          <span style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--text-secondary)" }}>
            AI recommendation · advisory
          </span>
          <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, border: `1px solid ${postureColor}`, color: postureColor,
            background: `color-mix(in srgb, ${postureColor} 12%, transparent)`, borderRadius: "var(--radius-sm)", padding: "2px 8px",
            textTransform: "uppercase", letterSpacing: "0.04em" }}>{postureLabel}</span>
          <span style={{ marginLeft: "auto", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)" }}>
            rate: {r.rate_adequacy.replace("_", " ")}
          </span>
        </div>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", lineHeight: 1.55, margin: "0 0 var(--space-sm)" }}>{r.summary}</p>
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)", lineHeight: 1.55, margin: "0 0 var(--space-sm)" }}>{r.rationale}</p>
        {r.subjectivities.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: "var(--space-md)", fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
            {r.subjectivities.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
})()}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` (filter `.next/` noise).
Expected: no errors in `src/`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/underwriting.ts "frontend/src/app/underwriting/[qid]/page.tsx"
git commit -F - <<'EOF'
feat(carrier-web): advisory AI underwriting-recommendation card on the dossier

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10: Mobile advisory card (parity)

**Files:**
- Modify: `mobile/src/api/underwriting.ts` (add to `Dossier` interface — same shape as web)
- Modify: `mobile/src/screens/UnderwriteDecisionScreen.tsx` (render the card)

- [ ] **Step 1: Extend the mobile `Dossier` interface** — add the identical `underwriting_recommendation` block as in Task 9 Step 1.

- [ ] **Step 2: Render the card** in `UnderwriteDecisionScreen.tsx` above the decision controls, reusing existing RN style primitives (chip + section). Posture colors: `Colors.success` / `Colors.warning` / `Colors.error`. Show posture chip, summary, rationale, subjectivities list, and a `rate: …` line. Label it "AI RECOMMENDATION · ADVISORY". Follow project invariants (accent text uses `Colors.accentInk`, one tier heat ramp).

```tsx
{dossier.underwriting_recommendation && (
  <View style={[styles.sectionBox, { borderLeftWidth: 3, borderLeftColor:
    dossier.underwriting_recommendation.posture === "quote" ? Colors.success
    : dossier.underwriting_recommendation.posture === "decline" ? Colors.error : Colors.warning }]}>
    <Text style={styles.eyebrow}>AI RECOMMENDATION · ADVISORY</Text>
    <Text style={styles.recPosture}>
      {dossier.underwriting_recommendation.posture.replace(/_/g, " ").toUpperCase()}
      {"  ·  rate: "}{dossier.underwriting_recommendation.rate_adequacy.replace("_", " ")}
    </Text>
    <Text style={styles.recBody}>{dossier.underwriting_recommendation.summary}</Text>
    <Text style={styles.recBody}>{dossier.underwriting_recommendation.rationale}</Text>
    {dossier.underwriting_recommendation.subjectivities.map((s, i) => (
      <Text key={i} style={styles.recBullet}>• {s}</Text>
    ))}
  </View>
)}
```

Add the referenced styles (`recPosture`, `recBody`, `recBullet`) to the screen's `StyleSheet` (mono/sans, sizes consistent with the screen's existing text styles; `eyebrow` already exists on sibling screens — reuse the same definition).

- [ ] **Step 3: Typecheck**

Run: `cd mobile && node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add mobile/src/api/underwriting.ts mobile/src/screens/UnderwriteDecisionScreen.tsx
git commit -F - <<'EOF'
feat(carrier-mobile): advisory AI underwriting-recommendation card (parity)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Final verification

- [ ] `cd backend && python -m pytest -q` — full suite green.
- [ ] Frontend + mobile `tsc --noEmit` clean.
- [ ] `python -c "from app.evals.underwriting_scorers import run_underwriting_evals; print(run_underwriting_evals())"` — record the pitch numbers.
- [ ] (Optional, when wiring CI) register `run_underwriting_evals` output into `baseline.py` + `--compare-baseline` + refresh `/evals` scoreboard. Tracked as a fast-follow; the standalone run already produces the reproducible number.

---

## Notes / deferred (YAGNI)

- **Appetite wiring:** `recommend_underwriting` passes `in_appetite=None` in v1 (recommender fully handles None/True/False; eval scenarios exercise the `False` decline path). Wiring real `check_appetite` into the dossier is a small fast-follow once its signature is confirmed.
- **LLM provider upgrade:** the recommender is deterministic-only in v1. An LLM `draft_underwriting_recommendation` is a future drop-in behind the same input bundle, with deterministic fallback (mirrors `_run_underwriter_memo_agent`). The faithfulness scorer exists precisely to guard that path.
- **Baseline/CI registration** of the new scorers is the optional final step above.
