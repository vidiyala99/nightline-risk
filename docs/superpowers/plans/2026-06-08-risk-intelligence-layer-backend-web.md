# Risk Intelligence Layer (Backend + Web Exposure Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic, persona-scoped Risk Intelligence Layer (a registry of cross-entity risk `Finding`s), expose it at `GET /api/intelligence/exposure`, persist findings as predictions for the future calibration loop, gate it with an eval baseline, and surface it as a proactive "Attention / Exposure" panel on the web dashboard.

**Architecture:** A decoupled `app/intelligence/` package. Each judgment kind is a pure function `find(scope) -> list[Finding]` that queries only the persona's gated rows and attaches `Citation`s. An `engine` resolves the persona's allowed kinds + gated scope, runs the modules (isolating failures), ranks by deterministic severity, persists `RiskFindingRecord` rows, and returns. No LLM, no retrieval — deterministic graph traversal over the existing relational schema, so there is zero hallucination risk. The web panel fetches the persona-scoped findings and renders them with click-through citations.

**Tech Stack:** FastAPI + SQLModel (SQLite local / Postgres prod), pytest. Next.js 16 / React 19 + TypeScript, vitest. Reuses existing `app.auth` gates, `app.schemas.domain.Citation`, `app.time.now_utc`/`as_utc`, and `app.evals.baseline`.

**Scope note:** This plan delivers backend + web. The React Native mobile exposure panel is a thin follow-on plan against this same finished API (`GET /api/intelligence/exposure`). It is intentionally out of scope here to keep this plan focused and testable.

**Spec:** `docs/superpowers/specs/2026-06-08-risk-intelligence-layer-design.md`

---

## File Structure

**Backend (create):**
- `backend/app/intelligence/__init__.py` — package marker.
- `backend/app/intelligence/finding.py` — `Finding`, `FindingScope`, `Subject`, `RecommendedAction`, `Prediction` Pydantic models + `SEVERITY_RANK` + `PERSONA_KINDS`.
- `backend/app/intelligence/findings/__init__.py` — the kind→function registry (`REGISTRY`).
- `backend/app/intelligence/findings/evidence_gap.py` — operator.
- `backend/app/intelligence/findings/compliance_overdue.py` — operator.
- `backend/app/intelligence/findings/renewal_approaching.py` — operator.
- `backend/app/intelligence/findings/coverage_gap_eo.py` — broker.
- `backend/app/intelligence/findings/renewal_at_risk.py` — broker.
- `backend/app/intelligence/findings/submission_stalled.py` — broker.
- `backend/app/intelligence/findings/reserve_light.py` — carrier.
- `backend/app/intelligence/findings/fraud_unreviewed.py` — carrier.
- `backend/app/intelligence/engine.py` — `compute_exposure(user, session, *, now=None)`.
- `backend/app/schemas/intelligence.py` — `FindingOut`/`ExposureResponse` API models.
- `backend/app/api/v1/intelligence.py` — `GET /api/intelligence/exposure`.
- `backend/app/evals/intelligence_scorers.py` — `findings_recall`, `severity_match`, `false_alarm_rate`.
- `backend/app/evals/intelligence_scenarios.py` — gold scenarios (DB fixtures).
- `backend/app/evals/intelligence_runner.py` — runs scenarios → snapshot → baseline gate.
- `backend/app/evals/intelligence_baseline.json` — committed baseline (written by Task 10).
- `backend/tests/intelligence/__init__.py`, `backend/tests/intelligence/conftest.py`, and `test_*.py` per task.

**Backend (modify):**
- `backend/app/models.py` — add `RiskFindingRecord` (fresh table; create_all handles it — NO `_COLUMN_MIGRATIONS` line needed, mirroring `CommsReviewItem`).
- `backend/app/main.py` — register the intelligence router.

**Frontend (create):**
- `frontend/src/lib/intelligence.ts` — typed client `fetchExposure()`.
- `frontend/src/lib/intelligence.test.ts` — vitest.
- `frontend/src/components/intelligence/ExposurePanel.tsx` — the proactive panel.

**Frontend (modify):**
- `frontend/src/app/dashboard/page.tsx` — render `<ExposurePanel />`.

---

## Task 1: `RiskFindingRecord` model

**Files:**
- Modify: `backend/app/models.py` (append after `CommsReviewItem`, ~line 850)
- Test: `backend/tests/intelligence/test_model.py`
- Create: `backend/tests/intelligence/__init__.py` (empty)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/intelligence/__init__.py` (empty file), then `backend/tests/intelligence/test_model.py`:

```python
from sqlmodel import SQLModel, Session, create_engine
from app.models import RiskFindingRecord
from app.time import now_utc


def test_risk_finding_record_roundtrips_json_columns():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        rec = RiskFindingRecord(
            id="rf-test-1",
            persona="venue_operator",
            kind="evidence_gap",
            subject_type="incident",
            subject_id="inc-1",
            subject_label="Brawl at entrance",
            subject_href="/incidents/inc-1",
            severity="high",
            severity_rank=3,
            why=[{"source_id": "inc-1", "source_type": "incident", "excerpt": "..."}],
            recommended_action={"label": "Attach evidence", "href": "/incidents/inc-1"},
            prediction={"claim": "likely denied", "falsifiable_by": "claim_outcome", "horizon": "on_claim"},
            venue_id="v1",
            computed_at=now_utc(),
        )
        session.add(rec)
        session.commit()
        got = session.get(RiskFindingRecord, "rf-test-1")
        assert got is not None
        assert got.why[0]["source_id"] == "inc-1"
        assert got.recommended_action["label"] == "Attach evidence"
        assert got.status == "open"
        assert got.severity_rank == 3
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_model.py -q`
Expected: FAIL with `ImportError: cannot import name 'RiskFindingRecord'`.

- [ ] **Step 3: Add the model**

Append to `backend/app/models.py` (after `CommsReviewItem`):

```python
class RiskFindingRecord(SQLModel, table=True):
    """A persisted risk judgment produced by app.intelligence.

    Fresh table (created by create_all, no _COLUMN_MIGRATIONS line needed —
    mirrors CommsReviewItem). JSON columns (why/recommended_action/prediction)
    round-trip as parsed objects on SQLite but as JSON STRINGS on Postgres —
    callers must coerce at the read boundary (see app.schemas.intelligence).

    `prediction` is the outcome-capture seam: the falsifiable claim the
    calibration loop (a later sub-project) will score against reality. Nothing
    scores it yet."""
    id: str = Field(primary_key=True)
    persona: str = Field(index=True)
    kind: str = Field(index=True)
    subject_type: str
    subject_id: str = Field(index=True)
    subject_label: str = ""
    subject_href: str = ""
    severity: str
    severity_rank: int = 0
    why: list = Field(default_factory=list, sa_column=Column(JSON))
    recommended_action: dict = Field(default_factory=dict, sa_column=Column(JSON))
    prediction: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="open", index=True)  # open | resolved
    venue_id: Optional[str] = Field(default=None, index=True)
    computed_at: datetime = Field(default_factory=now_utc)
    resolved_at: Optional[datetime] = Field(default=None)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_model.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/models.py backend/tests/intelligence/__init__.py backend/tests/intelligence/test_model.py
rtk git commit -m "feat(intelligence): add RiskFindingRecord model"
```

---

## Task 2: Core types — `Finding`, `FindingScope`, severity, persona map

**Files:**
- Create: `backend/app/intelligence/__init__.py` (empty), `backend/app/intelligence/finding.py`
- Test: `backend/tests/intelligence/test_finding_types.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_finding_types.py`:

```python
from app.intelligence.finding import (
    Finding, Subject, RecommendedAction, Prediction,
    SEVERITY_RANK, PERSONA_KINDS, rank_for,
)


def test_severity_rank_orders_high_above_low():
    assert SEVERITY_RANK["critical"] > SEVERITY_RANK["high"] > SEVERITY_RANK["medium"] > SEVERITY_RANK["low"]
    assert rank_for("high") == SEVERITY_RANK["high"]
    assert rank_for("unknown-severity") == 0


def test_persona_kinds_are_disjoint_per_persona():
    assert "evidence_gap" in PERSONA_KINDS["venue_operator"]
    assert "coverage_gap_eo" in PERSONA_KINDS["broker"]
    assert "reserve_light" in PERSONA_KINDS["carrier"]
    # operator cannot see broker kinds
    assert "coverage_gap_eo" not in PERSONA_KINDS["venue_operator"]


def test_finding_builds_with_nested_models():
    f = Finding(
        id="evidence_gap:incident:inc-1",
        persona="venue_operator",
        kind="evidence_gap",
        subject=Subject(entity_type="incident", entity_id="inc-1", label="Brawl", href="/incidents/inc-1"),
        severity="high",
        why=[],
        recommended_action=RecommendedAction(label="Attach evidence", href="/incidents/inc-1"),
        prediction=Prediction(claim="likely denied", falsifiable_by="claim_outcome", horizon="on_claim"),
        venue_id="v1",
    )
    assert f.severity_rank == SEVERITY_RANK["high"]
    assert f.id == "evidence_gap:incident:inc-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_finding_types.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.intelligence'`.

- [ ] **Step 3: Implement the types**

Create `backend/app/intelligence/__init__.py` (empty). Create `backend/app/intelligence/finding.py`:

```python
"""Core types for the Risk Intelligence Layer.

A judgment module is a pure function `find(scope: FindingScope) -> list[Finding]`.
Findings are deterministic, persona-gated, and cited — no LLM, no retrieval.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, computed_field
from sqlmodel import Session

from app.schemas.domain import Citation

# Higher = more urgent. 0 is reserved for unknown severities so a typo can never
# outrank a real finding.
SEVERITY_RANK: dict[str, int] = {"critical": 4, "high": 3, "medium": 2, "low": 1}


def rank_for(severity: str) -> int:
    return SEVERITY_RANK.get(severity, 0)


# Which judgment kinds each persona is allowed to see. Enforced in code (the
# engine only runs these), never in a prompt. admin sees everything.
PERSONA_KINDS: dict[str, list[str]] = {
    "venue_operator": ["evidence_gap", "compliance_overdue", "renewal_approaching"],
    "broker": ["coverage_gap_eo", "renewal_at_risk", "submission_stalled"],
    "carrier": ["reserve_light", "fraud_unreviewed"],
}
PERSONA_KINDS["admin"] = [k for kinds in PERSONA_KINDS.values() for k in kinds]


class Subject(BaseModel):
    entity_type: str
    entity_id: str
    label: str = ""
    href: str = ""


class RecommendedAction(BaseModel):
    label: str
    href: str = ""


class Prediction(BaseModel):
    claim: str
    falsifiable_by: str = ""
    horizon: str = ""


class Finding(BaseModel):
    id: str
    persona: str
    kind: str
    subject: Subject
    severity: str
    why: list[Citation] = Field(default_factory=list)
    recommended_action: RecommendedAction
    prediction: Prediction
    venue_id: Optional[str] = None

    @computed_field  # type: ignore[misc]
    @property
    def severity_rank(self) -> int:
        return rank_for(self.severity)


@dataclass
class FindingScope:
    """Everything a judgment module needs, with persona scope already resolved.

    `venue_ids` is None for unrestricted personas (broker/admin) and a concrete
    set for operators (their tenant + extra_venue_ids). `now` is injected so
    time-window findings (renewals, staleness) are deterministically testable.
    """
    persona: str
    user: dict
    venue_ids: Optional[set[str]]
    session: Session
    now: datetime
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_finding_types.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/__init__.py backend/app/intelligence/finding.py backend/tests/intelligence/test_finding_types.py
rtk git commit -m "feat(intelligence): core Finding types + persona kind map"
```

---

## Task 3: `evidence_gap` finding (operator) — the template

**Files:**
- Create: `backend/app/intelligence/findings/__init__.py` (empty for now), `backend/app/intelligence/findings/evidence_gap.py`
- Test: `backend/tests/intelligence/test_evidence_gap.py`
- Create: `backend/tests/intelligence/conftest.py`

- [ ] **Step 1: Write the shared test fixture + the failing test**

Create `backend/tests/intelligence/conftest.py`:

```python
import pytest
from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401 — register all tables


@pytest.fixture()
def session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as s:
        yield s
```

Create `backend/tests/intelligence/test_evidence_gap.py`:

```python
from datetime import datetime, timezone

from app.intelligence.finding import FindingScope
from app.intelligence.findings.evidence_gap import find
from app.models import IncidentRecord, EvidenceFile


def _scope(session):
    return FindingScope(
        persona="venue_operator", user={"sub": "u1", "role": "venue_operator"},
        venue_ids={"v1"}, session=session, now=datetime(2026, 6, 8, tzinfo=timezone.utc),
    )


def test_flags_open_incident_with_no_evidence(session):
    session.add(IncidentRecord(
        id="inc-1", venue_id="v1", occurred_at="2026-06-01", location="entrance",
        summary="Brawl at the door", reported_by="staff",
        injury_observed=True, police_called=True, ems_called=False, status="open",
    ))
    session.commit()
    findings = find(_scope(session))
    assert len(findings) == 1
    f = findings[0]
    assert f.kind == "evidence_gap"
    assert f.subject.entity_id == "inc-1"
    assert f.severity == "high"  # injury + police escalate
    assert f.why and f.why[0].source_id == "inc-1"
    assert f.id == "evidence_gap:incident:inc-1"


def test_does_not_flag_incident_with_evidence(session):
    session.add(IncidentRecord(
        id="inc-2", venue_id="v1", occurred_at="2026-06-01", location="bar",
        summary="Minor", reported_by="staff",
        injury_observed=False, police_called=False, ems_called=False, status="open",
    ))
    session.add(EvidenceFile(
        id="ev-1", incident_id="inc-2", filename="clip.mp4",
        content_type="video/mp4", file_path="/x",
    ))
    session.commit()
    assert find(_scope(session)) == []


def test_ignores_incidents_outside_scope(session):
    session.add(IncidentRecord(
        id="inc-3", venue_id="OTHER", occurred_at="2026-06-01", location="bar",
        summary="x", reported_by="s", injury_observed=False,
        police_called=False, ems_called=False, status="open",
    ))
    session.commit()
    assert find(_scope(session)) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_evidence_gap.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.intelligence.findings.evidence_gap'`.

- [ ] **Step 3: Implement the finding**

Create `backend/app/intelligence/findings/__init__.py` (empty). Create `backend/app/intelligence/findings/evidence_gap.py`:

```python
"""Operator finding: an open incident with no attached evidence is a
claim-defense exposure (most venue claims fail on thin documentation)."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import IncidentRecord, EvidenceFile
from app.schemas.domain import Citation

OPEN_STATUSES = ("open", "under_review")


def find(scope: FindingScope) -> list[Finding]:
    if scope.venue_ids is None or not scope.venue_ids:
        # operator-scoped finding; needs a concrete venue set
        return [] if scope.venue_ids is not None else []
    q = select(IncidentRecord).where(
        IncidentRecord.venue_id.in_(scope.venue_ids),
        IncidentRecord.status.in_(OPEN_STATUSES),
    )
    findings: list[Finding] = []
    for inc in scope.session.exec(q).all():
        has_evidence = scope.session.exec(
            select(EvidenceFile.id).where(EvidenceFile.incident_id == inc.id)
        ).first()
        if has_evidence:
            continue
        severe = inc.injury_observed or inc.police_called or inc.ems_called
        findings.append(Finding(
            id=f"evidence_gap:incident:{inc.id}",
            persona="venue_operator",
            kind="evidence_gap",
            subject=Subject(
                entity_type="incident", entity_id=inc.id,
                label=inc.summary[:80], href=f"/incidents/{inc.id}",
            ),
            severity="high" if severe else "medium",
            why=[Citation(
                source_id=inc.id, source_type="incident",
                excerpt=inc.summary[:240],
            )],
            recommended_action=RecommendedAction(
                label="Attach evidence to defend this incident",
                href=f"/incidents/{inc.id}",
            ),
            prediction=Prediction(
                claim="If a claim is filed on this incident it will likely be "
                      "denied or disputed for insufficient evidence.",
                falsifiable_by="claim_outcome",
                horizon="on_claim",
            ),
            venue_id=inc.venue_id,
        ))
    return findings
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_evidence_gap.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/findings/__init__.py backend/app/intelligence/findings/evidence_gap.py backend/tests/intelligence/conftest.py backend/tests/intelligence/test_evidence_gap.py
rtk git commit -m "feat(intelligence): evidence_gap finding (operator)"
```

---

## Task 4: Operator findings — `compliance_overdue` + `renewal_approaching`

**Files:**
- Create: `backend/app/intelligence/findings/compliance_overdue.py`, `backend/app/intelligence/findings/renewal_approaching.py`
- Test: `backend/tests/intelligence/test_operator_findings.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_operator_findings.py`:

```python
from datetime import datetime, timezone, timedelta, date

from app.intelligence.finding import FindingScope
from app.intelligence.findings.compliance_overdue import find as find_compliance
from app.intelligence.findings.renewal_approaching import find as find_renewal
from app.models import ComplianceSignal, Policy

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _scope(session):
    return FindingScope(persona="venue_operator", user={"sub": "u1"},
                        venue_ids={"v1"}, session=session, now=NOW)


def test_compliance_overdue_flags_open_and_escalates_old(session):
    session.add(ComplianceSignal(
        id="c1", venue_id="v1", title="Fire exit blocked", description="d",
        provenance="underwriter_verified", severity="medium", status="open",
        created_at=NOW - timedelta(days=40),
    ))
    session.add(ComplianceSignal(
        id="c2", venue_id="v1", title="Resolved", description="d",
        provenance="auto_generated", severity="high", status="resolved",
    ))
    session.commit()
    findings = find_compliance(_scope(session))
    assert len(findings) == 1
    assert findings[0].subject.entity_id == "c1"
    assert findings[0].severity == "high"  # 40 days old escalates medium -> high


def test_renewal_approaching_flags_within_window(session):
    session.add(Policy(
        id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id="v1",
        carrier_id="c1", status="active",
        effective_date=date(2025, 6, 20), expiration_date=date(2026, 6, 20),  # 12 days out
        annual_premium=0, commission_amount=0, commission_rate=0,
    ))
    session.add(Policy(
        id="pol-2", submission_id="s2", bound_quote_id="q2", venue_id="v1",
        carrier_id="c1", status="active",
        effective_date=date(2025, 1, 1), expiration_date=date(2027, 1, 1),  # far out
        annual_premium=0, commission_amount=0, commission_rate=0,
    ))
    session.commit()
    findings = find_renewal(_scope(session))
    assert [f.subject.entity_id for f in findings] == ["pol-1"]
    assert findings[0].severity == "high"  # <=14 days
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_operator_findings.py -q`
Expected: FAIL with `ModuleNotFoundError` for `compliance_overdue`.

- [ ] **Step 3: Implement both findings**

Create `backend/app/intelligence/findings/compliance_overdue.py`:

```python
"""Operator finding: an open compliance item, escalated by age."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import ComplianceSignal
from app.schemas.domain import Citation
from app.time import as_utc

# severity from the signal, escalated one step if older than this.
ESCALATE_AFTER_DAYS = 30
_BUMP = {"low": "medium", "medium": "high", "high": "high", "urgent": "critical"}


def find(scope: FindingScope) -> list[Finding]:
    if not scope.venue_ids:
        return []
    q = select(ComplianceSignal).where(
        ComplianceSignal.venue_id.in_(scope.venue_ids),
        ComplianceSignal.status == "open",
    )
    findings: list[Finding] = []
    for sig in scope.session.exec(q).all():
        severity = sig.severity
        created = as_utc(sig.created_at)
        if created is not None and (scope.now - created).days > ESCALATE_AFTER_DAYS:
            severity = _BUMP.get(sig.severity, sig.severity)
        findings.append(Finding(
            id=f"compliance_overdue:compliance:{sig.id}",
            persona="venue_operator",
            kind="compliance_overdue",
            subject=Subject(
                entity_type="compliance", entity_id=sig.id,
                label=sig.title[:80], href="/compliance",
            ),
            severity=severity,
            why=[Citation(source_id=sig.id, source_type="compliance",
                          excerpt=sig.description[:240])],
            recommended_action=RecommendedAction(
                label="Resolve this compliance item", href="/compliance",
            ),
            prediction=Prediction(
                claim="Unresolved compliance items raise premium or risk "
                      "non-renewal at the next term.",
                falsifiable_by="renewal_outcome", horizon="renewal",
            ),
            venue_id=sig.venue_id,
        ))
    return findings
```

Create `backend/app/intelligence/findings/renewal_approaching.py`:

```python
"""Operator finding: an in-force policy nearing expiration."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy
from app.schemas.domain import Citation

WINDOW_DAYS = 60
IN_FORCE = ("active", "bound_pending_number")


def _severity(days: int) -> str:
    if days <= 14:
        return "high"
    if days <= 30:
        return "medium"
    return "low"


def find(scope: FindingScope) -> list[Finding]:
    if not scope.venue_ids:
        return []
    q = select(Policy).where(
        Policy.venue_id.in_(scope.venue_ids),
        Policy.status.in_(IN_FORCE),
    )
    today = scope.now.date()
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        days = (pol.expiration_date - today).days
        if days < 0 or days > WINDOW_DAYS:
            continue
        findings.append(Finding(
            id=f"renewal_approaching:policy:{pol.id}",
            persona="venue_operator",
            kind="renewal_approaching",
            subject=Subject(
                entity_type="policy", entity_id=pol.id,
                label=pol.policy_number or pol.id, href=f"/policies/{pol.id}",
            ),
            severity=_severity(days),
            why=[Citation(source_id=pol.id, source_type="policy",
                          excerpt=f"Expires {pol.expiration_date.isoformat()} ({days} days).")],
            recommended_action=RecommendedAction(
                label="Review upcoming renewal", href=f"/policies/{pol.id}",
            ),
            prediction=Prediction(
                claim="Policy will lapse if not renewed by its expiration date.",
                falsifiable_by="policy_status", horizon="expiration_date",
            ),
            venue_id=pol.venue_id,
        ))
    return findings
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_operator_findings.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/findings/compliance_overdue.py backend/app/intelligence/findings/renewal_approaching.py backend/tests/intelligence/test_operator_findings.py
rtk git commit -m "feat(intelligence): compliance_overdue + renewal_approaching findings"
```

---

## Task 5: Broker findings — `coverage_gap_eo` + `renewal_at_risk` + `submission_stalled`

**Files:**
- Create: `backend/app/intelligence/findings/coverage_gap_eo.py`, `renewal_at_risk.py`, `submission_stalled.py`
- Test: `backend/tests/intelligence/test_broker_findings.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_broker_findings.py`:

```python
from datetime import datetime, timezone, timedelta, date
from decimal import Decimal

from app.intelligence.finding import FindingScope
from app.intelligence.findings.coverage_gap_eo import find as find_gap
from app.intelligence.findings.renewal_at_risk import find as find_risk
from app.intelligence.findings.submission_stalled import find as find_stalled
from app.models import Policy, CoverageLine, Submission, PolicyRequest

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _scope(session):
    # broker => venue_ids None (unrestricted)
    return FindingScope(persona="broker", user={"sub": "b1", "role": "broker"},
                        venue_ids=None, session=session, now=NOW)


def _coverage_lines(session):
    session.add(CoverageLine(id="gl", name="General Liability", description="d",
                             is_required_by_default=True,
                             default_per_occurrence_limit=Decimal("1000000")))
    session.add(CoverageLine(id="liquor", name="Liquor Liability", description="d",
                             is_required_by_default=False,
                             default_per_occurrence_limit=Decimal("1000000")))


def test_coverage_gap_flags_missing_required_line(session):
    _coverage_lines(session)
    session.add(Policy(id="pol-1", submission_id="s1", bound_quote_id="q1",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0"), coverage_lines=["liquor"]))
    session.commit()
    findings = find_gap(_scope(session))
    assert len(findings) == 1
    assert findings[0].kind == "coverage_gap_eo"
    assert "gl" in findings[0].why[0].excerpt


def test_renewal_at_risk_flags_expiring_without_request(session):
    session.add(Policy(id="pol-2", submission_id="s2", bound_quote_id="q2",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0")))
    session.add(Policy(id="pol-3", submission_id="s3", bound_quote_id="q3",
                       venue_id="v1", carrier_id="c1", status="active",
                       effective_date=date(2025, 6, 20), expiration_date=date(2026, 7, 1),
                       annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                       commission_rate=Decimal("0")))
    # pol-3 already has a renewal request in motion -> not at risk
    session.add(PolicyRequest(id="preq-1", policy_id="pol-3", venue_id="v1",
                              request_type="renewal", status="pending", requested_by="op"))
    session.commit()
    ids = {f.subject.entity_id for f in find_risk(_scope(session))}
    assert ids == {"pol-2"}


def test_submission_stalled_flags_old_non_terminal(session):
    session.add(Submission(id="sub-1", venue_id="v1", status="in_market",
                           effective_date=date(2026, 7, 1),
                           updated_at=NOW - timedelta(days=20)))
    session.add(Submission(id="sub-2", venue_id="v1", status="bound",
                           effective_date=date(2026, 7, 1),
                           updated_at=NOW - timedelta(days=90)))  # terminal -> skip
    session.add(Submission(id="sub-3", venue_id="v1", status="quoting",
                           effective_date=date(2026, 7, 1),
                           updated_at=NOW - timedelta(days=2)))  # fresh -> skip
    session.commit()
    ids = {f.subject.entity_id for f in find_stalled(_scope(session))}
    assert ids == {"sub-1"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_broker_findings.py -q`
Expected: FAIL with `ModuleNotFoundError` for `coverage_gap_eo`.

- [ ] **Step 3: Implement the three findings**

Create `backend/app/intelligence/findings/coverage_gap_eo.py`:

```python
"""Broker finding: a bound policy missing a default-required coverage line is
direct E&O exposure for the broker."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy, CoverageLine
from app.schemas.domain import Citation

IN_FORCE = ("active", "bound_pending_number")


def _scope_filter(q, scope: FindingScope):
    if scope.venue_ids is not None:
        q = q.where(Policy.venue_id.in_(scope.venue_ids))
    return q


def find(scope: FindingScope) -> list[Finding]:
    required = {
        cl.id for cl in scope.session.exec(
            select(CoverageLine).where(CoverageLine.is_required_by_default == True)  # noqa: E712
        ).all()
    }
    if not required:
        return []
    q = _scope_filter(select(Policy).where(Policy.status.in_(IN_FORCE)), scope)
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        have = set(pol.coverage_lines or [])
        missing = sorted(required - have)
        if not missing:
            continue
        findings.append(Finding(
            id=f"coverage_gap_eo:policy:{pol.id}",
            persona="broker",
            kind="coverage_gap_eo",
            subject=Subject(entity_type="policy", entity_id=pol.id,
                            label=pol.policy_number or pol.id, href=f"/policies/{pol.id}"),
            severity="high",
            why=[Citation(source_id=pol.id, source_type="policy",
                          excerpt=f"Missing required coverage: {', '.join(missing)}.")],
            recommended_action=RecommendedAction(
                label="Close coverage gap (E&O exposure)", href=f"/policies/{pol.id}"),
            prediction=Prediction(
                claim="A loss on a missing required line is an uncovered E&O exposure.",
                falsifiable_by="claim_outcome", horizon="on_claim"),
            venue_id=pol.venue_id,
        ))
    return findings
```

Create `backend/app/intelligence/findings/renewal_at_risk.py`:

```python
"""Broker finding: a policy nearing expiration with no renewal in motion."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Policy, PolicyRequest
from app.schemas.domain import Citation

WINDOW_DAYS = 60
IN_FORCE = ("active", "bound_pending_number")
# A renewal request that is still live counts as "in motion".
LIVE_REQUEST_STATUSES = ("pending", "approved")


def find(scope: FindingScope) -> list[Finding]:
    q = select(Policy).where(Policy.status.in_(IN_FORCE))
    if scope.venue_ids is not None:
        q = q.where(Policy.venue_id.in_(scope.venue_ids))
    today = scope.now.date()
    findings: list[Finding] = []
    for pol in scope.session.exec(q).all():
        days = (pol.expiration_date - today).days
        if days < 0 or days > WINDOW_DAYS:
            continue
        in_motion = scope.session.exec(
            select(PolicyRequest.id).where(
                PolicyRequest.policy_id == pol.id,
                PolicyRequest.request_type == "renewal",
                PolicyRequest.status.in_(LIVE_REQUEST_STATUSES),
            )
        ).first()
        if in_motion:
            continue
        findings.append(Finding(
            id=f"renewal_at_risk:policy:{pol.id}",
            persona="broker",
            kind="renewal_at_risk",
            subject=Subject(entity_type="policy", entity_id=pol.id,
                            label=pol.policy_number or pol.id, href=f"/policies/{pol.id}"),
            severity="high" if days <= 30 else "medium",
            why=[Citation(source_id=pol.id, source_type="policy",
                          excerpt=f"Expires in {days} days, no renewal request in motion.")],
            recommended_action=RecommendedAction(
                label="Start the renewal", href=f"/policies/{pol.id}"),
            prediction=Prediction(
                claim="Client will be uninsured at term if no renewal is placed.",
                falsifiable_by="policy_status", horizon="expiration_date"),
            venue_id=pol.venue_id,
        ))
    return findings
```

Create `backend/app/intelligence/findings/submission_stalled.py`:

```python
"""Broker finding: a non-terminal submission with no movement for too long."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Submission
from app.schemas.domain import Citation
from app.time import as_utc

STALE_AFTER_DAYS = 14
VERY_STALE_DAYS = 30
# Keep in sync with app.lifecycles.SUBMISSION_TRANSITIONS terminal states.
TERMINAL = ("bound", "declined", "lost", "expired", "withdrawn")


def find(scope: FindingScope) -> list[Finding]:
    q = select(Submission)
    if scope.venue_ids is not None:
        q = q.where(Submission.venue_id.in_(scope.venue_ids))
    findings: list[Finding] = []
    for sub in scope.session.exec(q).all():
        if sub.status in TERMINAL:
            continue
        updated = as_utc(sub.updated_at)
        if updated is None:
            continue
        age = (scope.now - updated).days
        if age <= STALE_AFTER_DAYS:
            continue
        findings.append(Finding(
            id=f"submission_stalled:submission:{sub.id}",
            persona="broker",
            kind="submission_stalled",
            subject=Subject(entity_type="submission", entity_id=sub.id,
                            label=sub.id, href=f"/submissions/{sub.id}"),
            severity="high" if age > VERY_STALE_DAYS else "medium",
            why=[Citation(source_id=sub.id, source_type="submission",
                          excerpt=f"Status '{sub.status}', no movement for {age} days.")],
            recommended_action=RecommendedAction(
                label="Follow up on this submission", href=f"/submissions/{sub.id}"),
            prediction=Prediction(
                claim="A stalled submission risks the effective date and the placement.",
                falsifiable_by="submission_status", horizon="effective_date"),
            venue_id=sub.venue_id,
        ))
    return findings
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_broker_findings.py -q`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/findings/coverage_gap_eo.py backend/app/intelligence/findings/renewal_at_risk.py backend/app/intelligence/findings/submission_stalled.py backend/tests/intelligence/test_broker_findings.py
rtk git commit -m "feat(intelligence): broker findings (coverage gap, renewal risk, stalled submission)"
```

---

## Task 6: Carrier findings — `reserve_light` + `fraud_unreviewed`

**Files:**
- Create: `backend/app/intelligence/findings/reserve_light.py`, `fraud_unreviewed.py`
- Test: `backend/tests/intelligence/test_carrier_findings.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_carrier_findings.py`:

```python
from datetime import datetime, timezone, date
from decimal import Decimal

from app.intelligence.finding import FindingScope
from app.intelligence.findings.reserve_light import find as find_reserve
from app.intelligence.findings.fraud_unreviewed import find as find_fraud
from app.models import Claim, EvidenceAnalysis

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _scope(session):
    return FindingScope(persona="carrier", user={"sub": "uw1", "role": "carrier"},
                        venue_ids=None, session=session, now=NOW)


def test_reserve_light_flags_paid_exceeding_reserve(session):
    session.add(Claim(id="clm-1", policy_id="pol-1", coverage_line="gl",
                      status="open", date_of_loss=date(2026, 5, 1),
                      current_reserve=Decimal("1000"),
                      indemnity_paid_to_date=Decimal("900"),
                      expense_paid_to_date=Decimal("300")))  # 1200 paid > 1000 reserve
    session.add(Claim(id="clm-2", policy_id="pol-1", coverage_line="gl",
                      status="open", date_of_loss=date(2026, 5, 1),
                      current_reserve=Decimal("5000"),
                      indemnity_paid_to_date=Decimal("100"),
                      expense_paid_to_date=Decimal("0")))  # healthy
    session.add(Claim(id="clm-3", policy_id="pol-1", coverage_line="gl",
                      status="closed_paid", date_of_loss=date(2026, 5, 1),
                      current_reserve=Decimal("0"),
                      indemnity_paid_to_date=Decimal("9999")))  # closed -> skip
    session.commit()
    ids = {f.subject.entity_id for f in find_reserve(_scope(session))}
    assert ids == {"clm-1"}


def test_fraud_unreviewed_flags_contradicted_corroboration(session):
    session.add(EvidenceAnalysis(id="ea-1", evidence_id="ev-1", incident_id="inc-1",
                                 analysis_type="video", corroboration="CONTRADICTED",
                                 status="complete"))
    session.add(EvidenceAnalysis(id="ea-2", evidence_id="ev-2", incident_id="inc-2",
                                 analysis_type="video", corroboration="CONSISTENT",
                                 status="complete"))
    session.commit()
    findings = find_fraud(_scope(session))
    assert [f.subject.entity_id for f in findings] == ["inc-1"]
    assert findings[0].severity == "high"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_carrier_findings.py -q`
Expected: FAIL with `ModuleNotFoundError` for `reserve_light`.

- [ ] **Step 3: Implement both findings**

Create `backend/app/intelligence/findings/reserve_light.py`:

```python
"""Carrier finding: an open claim whose reserve looks inadequate."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import Claim
from app.schemas.domain import Citation

# Any claim status starting with "closed" is terminal for this finding.
def _is_open(status: str) -> bool:
    return not status.startswith("closed")


def find(scope: FindingScope) -> list[Finding]:
    findings: list[Finding] = []
    for clm in scope.session.exec(select(Claim)).all():
        if not _is_open(clm.status):
            continue
        paid = (clm.indemnity_paid_to_date or 0) + (clm.expense_paid_to_date or 0)
        reserve = clm.current_reserve or 0
        # Light if paid has caught up to/exceeded the reserve, or reserve is zero
        # on an open claim.
        if reserve == 0 or paid > reserve:
            findings.append(Finding(
                id=f"reserve_light:claim:{clm.id}",
                persona="carrier",
                kind="reserve_light",
                subject=Subject(entity_type="claim", entity_id=clm.id,
                                label=clm.carrier_claim_number or clm.id,
                                href=f"/adjusting/{clm.id}"),
                severity="high",
                why=[Citation(source_id=clm.id, source_type="claim",
                              excerpt=f"Paid {paid} vs reserve {reserve} on an open claim.")],
                recommended_action=RecommendedAction(
                    label="Review reserve adequacy", href=f"/adjusting/{clm.id}"),
                prediction=Prediction(
                    claim="An inadequate reserve understates incurred loss and will "
                          "require an upward development.",
                    falsifiable_by="reserve_change", horizon="claim_life"),
                venue_id=None,
            ))
    return findings
```

Create `backend/app/intelligence/findings/fraud_unreviewed.py`:

```python
"""Carrier finding: a CONTRADICTED corroboration verdict needs human review.

v1 limitation: there is no per-analysis review marker yet, so every CONTRADICTED
verdict surfaces (the finding itself is the review surface). When a review marker
lands, filter on it here."""
from __future__ import annotations

from sqlmodel import select

from app.intelligence.finding import (
    Finding, FindingScope, Subject, RecommendedAction, Prediction,
)
from app.models import EvidenceAnalysis
from app.schemas.domain import Citation

FLAGGED = ("CONTRADICTED",)


def find(scope: FindingScope) -> list[Finding]:
    q = select(EvidenceAnalysis).where(
        EvidenceAnalysis.corroboration.in_(FLAGGED),
        EvidenceAnalysis.status == "complete",
    )
    findings: list[Finding] = []
    for ea in scope.session.exec(q).all():
        findings.append(Finding(
            id=f"fraud_unreviewed:incident:{ea.incident_id}",
            persona="carrier",
            kind="fraud_unreviewed",
            subject=Subject(entity_type="incident", entity_id=ea.incident_id,
                            label=ea.incident_id, href=f"/incidents/{ea.incident_id}"),
            severity="high",
            why=[Citation(source_id=ea.id, source_type="evidence_analysis",
                          excerpt=f"Evidence corroboration: {ea.corroboration}.")],
            recommended_action=RecommendedAction(
                label="Review contradicted evidence", href=f"/incidents/{ea.incident_id}"),
            prediction=Prediction(
                claim="A contradicted corroboration left unreviewed risks paying a "
                      "fraudulent or misstated claim.",
                falsifiable_by="review_decision", horizon="claim_life"),
            venue_id=None,
        ))
    return findings
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_carrier_findings.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/findings/reserve_light.py backend/app/intelligence/findings/fraud_unreviewed.py backend/tests/intelligence/test_carrier_findings.py
rtk git commit -m "feat(intelligence): carrier findings (reserve_light, fraud_unreviewed)"
```

---

## Task 7: Findings registry

**Files:**
- Modify: `backend/app/intelligence/findings/__init__.py`
- Test: `backend/tests/intelligence/test_registry.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_registry.py`:

```python
from app.intelligence.findings import REGISTRY
from app.intelligence.finding import PERSONA_KINDS


def test_registry_has_a_callable_for_every_persona_kind():
    all_kinds = {k for kinds in PERSONA_KINDS.values() for k in kinds}
    assert set(REGISTRY) == all_kinds
    for kind, fn in REGISTRY.items():
        assert callable(fn), kind
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_registry.py -q`
Expected: FAIL with `ImportError: cannot import name 'REGISTRY'`.

- [ ] **Step 3: Build the registry**

Replace `backend/app/intelligence/findings/__init__.py` with:

```python
"""Registry mapping each judgment kind to its pure find() function."""
from app.intelligence.findings import (
    evidence_gap, compliance_overdue, renewal_approaching,
    coverage_gap_eo, renewal_at_risk, submission_stalled,
    reserve_light, fraud_unreviewed,
)

REGISTRY = {
    "evidence_gap": evidence_gap.find,
    "compliance_overdue": compliance_overdue.find,
    "renewal_approaching": renewal_approaching.find,
    "coverage_gap_eo": coverage_gap_eo.find,
    "renewal_at_risk": renewal_at_risk.find,
    "submission_stalled": submission_stalled.find,
    "reserve_light": reserve_light.find,
    "fraud_unreviewed": fraud_unreviewed.find,
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_registry.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/findings/__init__.py backend/tests/intelligence/test_registry.py
rtk git commit -m "feat(intelligence): findings registry"
```

---

## Task 8: Engine — resolve scope, run kinds, rank, persist

**Files:**
- Create: `backend/app/intelligence/engine.py`
- Test: `backend/tests/intelligence/test_engine.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_engine.py`:

```python
from datetime import datetime, timezone

from app.intelligence.engine import compute_exposure
from app.models import IncidentRecord, RiskFindingRecord

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _open_incident(vid="v1", iid="inc-1"):
    return IncidentRecord(id=iid, venue_id=vid, occurred_at="2026-06-01",
                          location="x", summary="Brawl", reported_by="s",
                          injury_observed=True, police_called=False, ems_called=False,
                          status="open")


def test_operator_gets_only_operator_findings_in_their_scope(session):
    session.add(_open_incident("v1", "inc-1"))
    session.add(_open_incident("OTHER", "inc-2"))
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    findings = compute_exposure(user, session, now=NOW)
    assert {f.subject.entity_id for f in findings} == {"inc-1"}
    assert all(f.persona == "venue_operator" for f in findings)


def test_findings_sorted_by_severity_desc(session):
    # injury -> high; non-injury -> medium
    session.add(_open_incident("v1", "inc-high"))
    session.add(IncidentRecord(id="inc-med", venue_id="v1", occurred_at="2026-06-01",
                               location="x", summary="minor", reported_by="s",
                               injury_observed=False, police_called=False,
                               ems_called=False, status="open"))
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    findings = compute_exposure(user, session, now=NOW)
    assert [f.severity for f in findings][0] == "high"
    assert findings[0].severity_rank >= findings[-1].severity_rank


def test_persists_findings_as_records(session):
    session.add(_open_incident("v1", "inc-1"))
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    compute_exposure(user, session, now=NOW)
    from sqlmodel import select
    rows = session.exec(select(RiskFindingRecord)).all()
    assert any(r.id == "evidence_gap:incident:inc-1" and r.status == "open" for r in rows)


def test_resolved_when_condition_clears(session):
    inc = _open_incident("v1", "inc-1")
    session.add(inc)
    session.commit()
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    compute_exposure(user, session, now=NOW)
    # close the incident so the finding no longer fires
    inc.status = "closed"
    session.add(inc)
    session.commit()
    compute_exposure(user, session, now=NOW)
    from app.models import RiskFindingRecord
    rec = session.get(RiskFindingRecord, "evidence_gap:incident:inc-1")
    assert rec.status == "resolved"
    assert rec.resolved_at is not None


def test_failing_module_does_not_abort_others(session, monkeypatch):
    session.add(_open_incident("v1", "inc-1"))
    session.commit()

    def boom(scope):
        raise RuntimeError("module exploded")

    import app.intelligence.engine as eng
    monkeypatch.setitem(eng.REGISTRY, "compliance_overdue", boom)
    user = {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"}
    findings = compute_exposure(user, session, now=NOW)  # must not raise
    assert any(f.kind == "evidence_gap" for f in findings)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_engine.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.intelligence.engine'`.

- [ ] **Step 3: Implement the engine**

Create `backend/app/intelligence/engine.py`:

```python
"""The Risk Intelligence engine: resolve persona scope, run the persona's
allowed judgment modules (isolating failures), rank by severity, persist
findings as predictions, and return them ranked.

Deterministic — no LLM, no retrieval. This is the trustworthy foundation the
copilot and the calibration loop are surfaces of."""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from sqlmodel import Session, select

from app.auth import accessible_venue_ids
from app.intelligence.finding import Finding, FindingScope, PERSONA_KINDS
from app.intelligence.findings import REGISTRY
from app.models import RiskFindingRecord
from app.time import now_utc

logger = logging.getLogger(__name__)


def compute_exposure(
    user: dict, session: Session, *, now: Optional[datetime] = None
) -> list[Finding]:
    """Compute, persist, and return the ranked findings for a persona."""
    now = now or now_utc()
    persona = user.get("role", "")
    kinds = PERSONA_KINDS.get(persona, [])
    venue_ids = accessible_venue_ids(user, session)  # None for broker/admin
    scope = FindingScope(
        persona=persona, user=user, venue_ids=venue_ids, session=session, now=now,
    )

    findings: list[Finding] = []
    for kind in kinds:
        fn = REGISTRY.get(kind)
        if fn is None:
            continue
        try:
            findings.extend(fn(scope))
        except Exception:  # one bad module must not blank the whole panel
            logger.exception("intelligence finding %s failed", kind)

    findings.sort(key=lambda f: (f.severity_rank, f.id), reverse=True)
    _persist(findings, persona, kinds, session, now)
    return findings


def _persist(
    findings: list[Finding], persona: str, kinds: list[str],
    session: Session, now: datetime,
) -> None:
    """Upsert current findings as open records; mark previously-open records of
    this persona's kinds that no longer fire as resolved (the outcome-capture
    seam — predictions persist for the calibration loop)."""
    current_ids = {f.id for f in findings}

    # Resolve stale ones (same persona kinds, previously open, now absent).
    stale = session.exec(
        select(RiskFindingRecord).where(
            RiskFindingRecord.persona == persona,
            RiskFindingRecord.kind.in_(kinds),
            RiskFindingRecord.status == "open",
        )
    ).all()
    for rec in stale:
        if rec.id not in current_ids:
            rec.status = "resolved"
            rec.resolved_at = now
            session.add(rec)

    for f in findings:
        rec = session.get(RiskFindingRecord, f.id)
        why = [c.model_dump() for c in f.why]
        if rec is None:
            rec = RiskFindingRecord(
                id=f.id, persona=f.persona, kind=f.kind,
                subject_type=f.subject.entity_type, subject_id=f.subject.entity_id,
                subject_label=f.subject.label, subject_href=f.subject.href,
                severity=f.severity, severity_rank=f.severity_rank,
                why=why, recommended_action=f.recommended_action.model_dump(),
                prediction=f.prediction.model_dump(), status="open",
                venue_id=f.venue_id, computed_at=now,
            )
        else:
            rec.severity = f.severity
            rec.severity_rank = f.severity_rank
            rec.subject_label = f.subject.label
            rec.subject_href = f.subject.href
            rec.why = why
            rec.recommended_action = f.recommended_action.model_dump()
            rec.prediction = f.prediction.model_dump()
            rec.status = "open"
            rec.resolved_at = None
            rec.computed_at = now
        session.add(rec)

    session.commit()


# re-export so tests can monkeypatch REGISTRY on the engine module
REGISTRY = REGISTRY
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_engine.py -q`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/intelligence/engine.py backend/tests/intelligence/test_engine.py
rtk git commit -m "feat(intelligence): engine — scope, run, rank, persist findings"
```

---

## Task 9: API — schemas + `GET /api/intelligence/exposure` + registration

**Files:**
- Create: `backend/app/schemas/intelligence.py`, `backend/app/api/v1/intelligence.py`
- Modify: `backend/app/main.py` (router registration block, ~line 463)
- Test: `backend/tests/intelligence/test_api.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_api.py`:

```python
import pytest
from fastapi.testclient import TestClient
from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.main import app
from app.database import get_session
from app.auth import create_token
from app.models import IncidentRecord


@pytest.fixture()
def client():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)

    def _override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _override
    with Session(engine) as s:
        s.add(IncidentRecord(id="inc-1", venue_id="v1", occurred_at="2026-06-01",
                             location="x", summary="Brawl", reported_by="s",
                             injury_observed=True, police_called=False,
                             ems_called=False, status="open"))
        s.commit()
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_operator_sees_their_exposure(client):
    token = create_token("u1", "op@v.com", "venue_operator", "v1")
    res = client.get("/api/intelligence/exposure", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    body = res.json()
    assert body["persona"] == "venue_operator"
    kinds = [f["kind"] for f in body["findings"]]
    assert "evidence_gap" in kinds
    f = body["findings"][0]
    assert f["subject"]["href"].startswith("/incidents/")
    assert f["why"]  # citations present


def test_requires_auth(client):
    res = client.get("/api/intelligence/exposure")
    assert res.status_code == 401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_api.py -q`
Expected: FAIL with 404 (route not registered) / import error.

- [ ] **Step 3: Implement schemas, router, and register**

Create `backend/app/schemas/intelligence.py`:

```python
from __future__ import annotations

from pydantic import BaseModel

from app.schemas.domain import Citation


class SubjectOut(BaseModel):
    entity_type: str
    entity_id: str
    label: str = ""
    href: str = ""


class RecommendedActionOut(BaseModel):
    label: str
    href: str = ""


class PredictionOut(BaseModel):
    claim: str
    falsifiable_by: str = ""
    horizon: str = ""


class FindingOut(BaseModel):
    id: str
    persona: str
    kind: str
    subject: SubjectOut
    severity: str
    severity_rank: int
    why: list[Citation]
    recommended_action: RecommendedActionOut
    prediction: PredictionOut
    venue_id: str | None = None


class ExposureResponse(BaseModel):
    persona: str
    findings: list[FindingOut]
```

Create `backend/app/api/v1/intelligence.py`:

```python
"""Risk Intelligence Layer API — the proactive exposure surface.

GET /api/intelligence/exposure returns the caller's persona-scoped, ranked
findings. Persona + data scope are enforced in code (engine + auth gates),
never in a prompt."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlmodel import Session

from app.auth import verify_token
from app.database import get_session
from app.intelligence.engine import compute_exposure
from app.schemas.intelligence import ExposureResponse, FindingOut

router = APIRouter()


@router.get("/intelligence/exposure", response_model=ExposureResponse)
def get_exposure(
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> ExposureResponse:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    user = verify_token(authorization.split(" ")[1])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    findings = compute_exposure(user, session)
    return ExposureResponse(
        persona=user.get("role", ""),
        findings=[FindingOut(**f.model_dump()) for f in findings],
    )
```

In `backend/app/main.py`, add the import alongside the other v1 router imports (find where `incidents` router is imported) and register it in the `include_router` block (after line 463, the `surplus_lines_router` registration):

```python
from app.api.v1.intelligence import router as intelligence_router
app.include_router(intelligence_router, prefix="/api", tags=["intelligence"])
```

(Match the existing import style in main.py — if routers are imported as `from app.api.v1 import intelligence`, mirror that. Place the `include_router` call next to the other `app.include_router(..., prefix="/api", ...)` lines.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/intelligence/test_api.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/schemas/intelligence.py backend/app/api/v1/intelligence.py backend/app/main.py backend/tests/intelligence/test_api.py
rtk git commit -m "feat(intelligence): GET /api/intelligence/exposure endpoint"
```

---

## Task 10: Eval — scorers, scenarios, runner, baseline gate

**Files:**
- Create: `backend/app/evals/intelligence_scorers.py`, `intelligence_scenarios.py`, `intelligence_runner.py`, `intelligence_baseline.json`
- Test: `backend/tests/intelligence/test_eval.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/intelligence/test_eval.py`:

```python
from app.evals.intelligence_runner import run_scenarios, build_snapshot
from app.evals.intelligence_scorers import false_alarm_rate, findings_recall


def test_findings_recall_and_false_alarm():
    expected = {"evidence_gap:incident:inc-1"}
    produced = {"evidence_gap:incident:inc-1", "evidence_gap:incident:inc-2"}
    assert findings_recall(expected, produced) == 1.0
    # one produced finding was not expected -> false alarm
    assert false_alarm_rate(expected, produced) == 0.5


def test_run_scenarios_meets_committed_baseline():
    results = run_scenarios()
    snapshot = build_snapshot(results)
    # every scenario should hit full recall and zero false alarms in fixtures
    assert snapshot["aggregate"]["pass_rate"] == 1.0
    names = {s["name"] for s in snapshot["scorer_averages"]}
    assert {"findings_recall", "false_alarm_rate", "severity_match"} <= names
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/intelligence/test_eval.py -q`
Expected: FAIL with `ModuleNotFoundError` for `app.evals.intelligence_runner`.

- [ ] **Step 3: Implement scorers, scenarios, runner**

Create `backend/app/evals/intelligence_scorers.py`:

```python
"""Deterministic scorers for the intelligence eval. No LLM-judge here — the
findings are deterministic, so deterministic scoring is reproducible and
bias-free. (LLM-as-judge is reserved for the copilot's subjective dimensions
in a later sub-project.)"""
from __future__ import annotations


def findings_recall(expected_ids: set[str], produced_ids: set[str]) -> float:
    """Fraction of expected findings that were produced."""
    if not expected_ids:
        return 1.0
    return len(expected_ids & produced_ids) / len(expected_ids)


def false_alarm_rate(expected_ids: set[str], produced_ids: set[str]) -> float:
    """Fraction of produced findings that were NOT expected. Lower is better;
    trust depends on this staying at/near zero."""
    if not produced_ids:
        return 0.0
    return len(produced_ids - expected_ids) / len(produced_ids)


def severity_match(expected: dict[str, str], produced: dict[str, str]) -> float:
    """Fraction of overlapping findings whose severity matches expectation."""
    shared = set(expected) & set(produced)
    if not shared:
        return 1.0
    correct = sum(1 for k in shared if expected[k] == produced[k])
    return correct / len(shared)
```

Create `backend/app/evals/intelligence_scenarios.py`:

```python
"""Gold scenarios for the intelligence eval. Each scenario seeds an in-memory
DB, runs compute_exposure for a persona, and declares the expected finding ids
and severities. These encode the cross-entity / defensibility questions from
the spec — the questions no dashboard answers."""
from __future__ import annotations

from datetime import datetime, timezone, date
from decimal import Decimal

from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.models import IncidentRecord, ComplianceSignal, Policy, CoverageLine

NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _operator_evidence_gap():
    s = _fresh_session()
    s.add(IncidentRecord(id="inc-1", venue_id="v1", occurred_at="2026-06-01",
                         location="x", summary="Brawl", reported_by="s",
                         injury_observed=True, police_called=True, ems_called=False,
                         status="open"))
    s.commit()
    return {
        "name": "operator_evidence_gap",
        "user": {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"},
        "session": s,
        "expected_ids": {"evidence_gap:incident:inc-1"},
        "expected_severity": {"evidence_gap:incident:inc-1": "high"},
    }


def _operator_clean_no_false_alarm():
    s = _fresh_session()
    # An incident WITH evidence + a resolved compliance item -> zero findings.
    from app.models import EvidenceFile
    s.add(IncidentRecord(id="inc-2", venue_id="v1", occurred_at="2026-06-01",
                         location="x", summary="ok", reported_by="s",
                         injury_observed=False, police_called=False, ems_called=False,
                         status="open"))
    s.add(EvidenceFile(id="ev-1", incident_id="inc-2", filename="c.mp4",
                       content_type="video/mp4", file_path="/x"))
    s.commit()
    return {
        "name": "operator_clean_no_false_alarm",
        "user": {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"},
        "session": s,
        "expected_ids": set(),
        "expected_severity": {},
    }


def _broker_coverage_gap():
    s = _fresh_session()
    s.add(CoverageLine(id="gl", name="General Liability", description="d",
                       is_required_by_default=True,
                       default_per_occurrence_limit=Decimal("1000000")))
    s.add(Policy(id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id="v1",
                 carrier_id="c1", status="active",
                 effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                 annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                 commission_rate=Decimal("0"), coverage_lines=[]))
    s.commit()
    return {
        "name": "broker_coverage_gap",
        "user": {"sub": "b1", "role": "broker", "tenant_id": None},
        "session": s,
        "expected_ids": {"coverage_gap_eo:policy:pol-1"},
        "expected_severity": {"coverage_gap_eo:policy:pol-1": "high"},
    }


SCENARIOS = [
    _operator_evidence_gap,
    _operator_clean_no_false_alarm,
    _broker_coverage_gap,
]
```

Create `backend/app/evals/intelligence_runner.py`:

```python
"""Run the intelligence gold scenarios, score them, build a baseline-shaped
snapshot, and (optionally) gate against the committed baseline.

Run:  cd backend && python -m app.evals.intelligence_runner --compare-baseline
Update baseline after a real improvement:
      cd backend && python -m app.evals.intelligence_runner --update-baseline
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from app.evals.baseline import compare_to_baseline, load_baseline, write_baseline
from app.evals.intelligence_scenarios import SCENARIOS, NOW
from app.evals.intelligence_scorers import (
    findings_recall, false_alarm_rate, severity_match,
)
from app.intelligence.engine import compute_exposure

STACK_SIGNATURE = "intelligence=deterministic-v1"
BASELINE_PATH = Path(__file__).resolve().parent / "intelligence_baseline.json"


def run_scenarios() -> list[dict]:
    results = []
    for make in SCENARIOS:
        sc = make()
        findings = compute_exposure(sc["user"], sc["session"], now=NOW)
        produced_ids = {f.id for f in findings}
        produced_sev = {f.id: f.severity for f in findings}
        results.append({
            "name": sc["name"],
            "findings_recall": findings_recall(sc["expected_ids"], produced_ids),
            "false_alarm_rate": false_alarm_rate(sc["expected_ids"], produced_ids),
            "severity_match": severity_match(sc["expected_severity"], produced_sev),
        })
        sc["session"].close()
    return results


def _scorer_pass(name: str, value: float) -> bool:
    # false_alarm_rate passes when LOW; the others pass when HIGH.
    if name == "false_alarm_rate":
        return value <= 1e-9
    return value >= 1.0 - 1e-9


def build_snapshot(results: list[dict]) -> dict:
    scorer_names = ["findings_recall", "false_alarm_rate", "severity_match"]
    scorer_averages = []
    all_pass = []
    for name in scorer_names:
        passes = [_scorer_pass(name, r[name]) for r in results]
        rate = sum(1 for p in passes if p) / len(passes) if passes else 1.0
        scorer_averages.append({"name": name, "pass_rate": rate})
        all_pass.extend(passes)
    aggregate = sum(1 for p in all_pass if p) / len(all_pass) if all_pass else 1.0
    return {
        "stack_signature": STACK_SIGNATURE,
        "aggregate": {"pass_rate": aggregate},
        "scorer_averages": scorer_averages,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare-baseline", action="store_true")
    parser.add_argument("--update-baseline", action="store_true")
    args = parser.parse_args(argv)

    snapshot = build_snapshot(run_scenarios())
    for line in (
        f"aggregate pass rate: {snapshot['aggregate']['pass_rate']:.0%}",
        *[f"  {s['name']}: {s['pass_rate']:.0%}" for s in snapshot["scorer_averages"]],
    ):
        print(line)

    if args.update_baseline:
        write_baseline(snapshot, BASELINE_PATH, signature=STACK_SIGNATURE)
        print(f"baseline updated at {BASELINE_PATH}")
        return 0

    if args.compare_baseline:
        baseline = (load_baseline(BASELINE_PATH) or {}).get(STACK_SIGNATURE)
        if baseline is None:
            print("FAIL no baseline for stack signature; run --update-baseline")
            return 1
        diff = compare_to_baseline(snapshot, baseline)
        for line in diff.summary_lines():
            print(line)
        return 1 if diff.regressed else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run test to verify it passes, then write the baseline**

Run: `cd backend && python -m pytest tests/intelligence/test_eval.py -q`
Expected: PASS (2 tests).

Then create the committed baseline:
Run: `cd backend && python -m app.evals.intelligence_runner --update-baseline`
Expected: prints `aggregate pass rate: 100%` and `baseline updated at .../intelligence_baseline.json`.

Verify the gate passes:
Run: `cd backend && python -m app.evals.intelligence_runner --compare-baseline`
Expected: exit 0, all lines `OK`.

- [ ] **Step 5: Commit**

```bash
rtk git add backend/app/evals/intelligence_scorers.py backend/app/evals/intelligence_scenarios.py backend/app/evals/intelligence_runner.py backend/app/evals/intelligence_baseline.json backend/tests/intelligence/test_eval.py
rtk git commit -m "feat(intelligence): eval scorers, gold scenarios, baseline gate"
```

---

## Task 11: Web — typed API client `fetchExposure()`

**Files:**
- Create: `frontend/src/lib/intelligence.ts`, `frontend/src/lib/intelligence.test.ts`

- [ ] **Step 1: Write the failing test**

`frontend/src/lib/intelligence.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchExposure } from "./intelligence";

afterEach(() => vi.restoreAllMocks());

describe("fetchExposure", () => {
  it("returns parsed findings on 200", async () => {
    const body = {
      persona: "venue_operator",
      findings: [{
        id: "evidence_gap:incident:inc-1", persona: "venue_operator", kind: "evidence_gap",
        subject: { entity_type: "incident", entity_id: "inc-1", label: "Brawl", href: "/incidents/inc-1" },
        severity: "high", severity_rank: 3, why: [],
        recommended_action: { label: "Attach evidence", href: "/incidents/inc-1" },
        prediction: { claim: "x", falsifiable_by: "", horizon: "" }, venue_id: "v1",
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const res = await fetchExposure();
    expect(res.persona).toBe("venue_operator");
    expect(res.findings[0].kind).toBe("evidence_gap");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(fetchExposure()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/intelligence.test.ts`
Expected: FAIL — `intelligence.ts` does not exist.

- [ ] **Step 3: Implement the client**

Create `frontend/src/lib/intelligence.ts`:

```ts
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export interface Citation {
  source_id: string;
  source_type: string;
  excerpt: string;
  doc_id?: string | null;
  node_id?: string | null;
  page_start?: number | null;
  page_end?: number | null;
  path?: string | null;
  clause_id?: string | null;
}

export interface Finding {
  id: string;
  persona: string;
  kind: string;
  subject: { entity_type: string; entity_id: string; label: string; href: string };
  severity: "critical" | "high" | "medium" | "low";
  severity_rank: number;
  why: Citation[];
  recommended_action: { label: string; href: string };
  prediction: { claim: string; falsifiable_by: string; horizon: string };
  venue_id: string | null;
}

export interface ExposureResponse {
  persona: string;
  findings: Finding[];
}

export class IntelligenceApiError extends Error {}

export async function fetchExposure(): Promise<ExposureResponse> {
  const res = await fetch(`${API_URL}/api/intelligence/exposure`, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    throw new IntelligenceApiError(`exposure fetch failed: ${res.status}`);
  }
  return (await res.json()) as ExposureResponse;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/intelligence.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add frontend/src/lib/intelligence.ts frontend/src/lib/intelligence.test.ts
rtk git commit -m "feat(intelligence): web typed client fetchExposure()"
```

---

## Task 12: Web — `ExposurePanel` component + wire into dashboard

**Files:**
- Create: `frontend/src/components/intelligence/ExposurePanel.tsx`
- Modify: `frontend/src/app/dashboard/page.tsx`

- [ ] **Step 1: Implement the panel**

Create `frontend/src/components/intelligence/ExposurePanel.tsx`:

```tsx
"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { fetchExposure, type Finding } from "@/lib/intelligence";
import { SEVERITY_COLOR } from "@/lib/risk";

/**
 * Proactive "Attention / Exposure" panel — the deterministic surface of the
 * Risk Intelligence Layer. Requires no question from the user: it tells them
 * what matters now, why (with click-through citations), and what to do next.
 */
export function ExposurePanel() {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    fetchExposure()
      .then((r) => active && setFindings(r.findings))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, []);

  if (error) return null; // degrade silently — never block the dashboard
  if (findings === null) return null; // loading: no skeleton needed for v1
  if (findings.length === 0) {
    return (
      <section aria-label="What needs attention" style={{ margin: "1rem 0" }}>
        <p style={{ color: "var(--text-tertiary)" }}>✓ Nothing needs your attention right now.</p>
      </section>
    );
  }

  return (
    <section aria-label="What needs attention" style={{ margin: "1rem 0" }}>
      <h2 style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "1rem" }}>
        <AlertTriangle size={18} aria-hidden /> What needs your attention
      </h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: "0.5rem" }}>
        {findings.map((f) => (
          <li
            key={f.id}
            style={{
              borderLeft: `3px solid ${SEVERITY_COLOR[f.severity] ?? "var(--text-tertiary)"}`,
              padding: "0.5rem 0.75rem",
              background: "var(--surface-2, transparent)",
            }}
          >
            <Link href={f.subject.href} style={{ fontWeight: 600 }}>
              {f.subject.label || f.subject.entity_id}
            </Link>
            <p style={{ margin: "0.25rem 0", color: "var(--text-secondary)" }}>
              {f.why[0]?.excerpt}
            </p>
            <Link href={f.recommended_action.href} style={{ color: "var(--accent-ink)" }}>
              {f.recommended_action.label} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Wire into the dashboard**

In `frontend/src/app/dashboard/page.tsx`, add the import near the other component imports (after line 16):

```tsx
import { ExposurePanel } from "@/components/intelligence/ExposurePanel";
```

Then render `<ExposurePanel />` directly below the page header / `StatStrip` and above the venue grid (find the main content return block and insert it as the first child of the dashboard content container). The panel fetches its own persona-scoped data, so no props are needed.

- [ ] **Step 3: Verify it builds**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new type errors from the added files.

Run: `cd frontend && npx vitest run src/lib/intelligence.test.ts`
Expected: still PASS.

- [ ] **Step 4: Commit**

```bash
rtk git add frontend/src/components/intelligence/ExposurePanel.tsx frontend/src/app/dashboard/page.tsx
rtk git commit -m "feat(intelligence): proactive ExposurePanel on the web dashboard"
```

---

## Task 13: Full-suite green + final commit

**Files:** none (verification)

- [ ] **Step 1: Run the full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: all tests pass (existing + new `tests/intelligence/`). If any pre-existing test fails, investigate before proceeding — the intelligence work should not touch their surfaces.

- [ ] **Step 2: Run the intelligence eval gate**

Run: `cd backend && python -m app.evals.intelligence_runner --compare-baseline`
Expected: exit 0, all `OK`.

- [ ] **Step 3: Run the frontend unit tests + typecheck**

Run: `cd frontend && npx vitest run src/lib/intelligence.test.ts && npx tsc --noEmit`
Expected: PASS, no new type errors.

- [ ] **Step 4: Grep e2e for any selector regressions (per project convention)**

Run: `cd frontend && rg -l "dashboard" e2e/ || true`
Review any matched Playwright specs that assert dashboard structure; the panel is additive, so they should still pass — adjust only if a spec asserts exact child ordering.

- [ ] **Step 5: Final commit (if any fixes were needed)**

```bash
rtk git add -A
rtk git commit -m "test(intelligence): full suite + eval gate green"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** `Finding` abstraction (Task 2), all 8 judgment kinds across operator/broker/carrier (Tasks 3-6), registry (Task 7), engine with persona scope + module isolation + ranking + persistence/outcome-capture (Task 8), `RiskFindingRecord` model (Task 1), `GET /api/intelligence/exposure` (Task 9), eval with deterministic scorers + false-alarm gate + committed baseline, no LLM-judge (Task 10), proactive web exposure panel with click-through citations (Tasks 11-12). Mobile parity is explicitly deferred to a follow-on plan (stated in header). Retrieval-router / copilot / LLM-judge are spec'd as later sub-projects and correctly absent here.
- **Placeholder scan:** none — every step has concrete code and exact commands.
- **Type consistency:** `find(scope)` signature uniform across all 8 modules; `REGISTRY` keys match `PERSONA_KINDS` (gated by Task 7's test); `Finding`/`Subject`/`RecommendedAction`/`Prediction` field names match between `finding.py`, `engine.py` persistence, and `schemas/intelligence.py`; `compute_exposure(user, session, *, now=)` signature consistent between engine, API, and eval runner; baseline snapshot shape (`aggregate.pass_rate`, `scorer_averages[{name,pass_rate}]`) matches `app.evals.baseline` exactly.
