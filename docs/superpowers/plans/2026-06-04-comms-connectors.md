# Communication & Workflow Connectors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ingest Slack/tickets/SMS messages, classify each (incident / compliance / noise) with an eval-gated classifier, and route to the evidence layer or a human review queue — reusing the existing ingestion spine.

**Architecture:** A `CommsConnector` subclasses the ingestion-spine `Connector` (`app/ingestion/base.py`): `extract()` pulls `CommsItem`s from a `CommsSource` (MCP-client seam; v1 simulated), `transform()` classifies them, and `load()` routes — auto-creating an `IncidentRecord` or `ComplianceSignal` when calibrated confidence clears a per-kind threshold, else creating a `CommsReviewItem` for human review. Re-uses `run_connector` for content-hash dedupe + `IngestionRun` audit. A web review queue lets operator/broker confirm/correct/dismiss.

**Tech Stack:** FastAPI + SQLModel (backend), pytest, Next.js/React (web). Spec: `docs/superpowers/specs/2026-06-04-comms-connectors-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `backend/app/ingestion/comms/__init__.py` | package marker |
| `backend/app/ingestion/comms/types.py` | `CommsItem`, `CommsClassification`, `CommsKind` |
| `backend/app/ingestion/comms/sources.py` | `CommsSource` ABC + simulated `SlackSource`/`TicketSource`/`TextSource` (MCP seam) |
| `backend/app/ingestion/comms/classifier.py` | `classify_comms_item()` (deterministic default; LLM-injectable) |
| `backend/app/ingestion/comms/gate.py` | per-kind thresholds + `decide()` (auto/review/drop) |
| `backend/app/ingestion/comms/router.py` | `route()` → IncidentRecord / ComplianceSignal / CommsReviewItem |
| `backend/app/ingestion/comms/connector.py` | `CommsConnector(Connector)` + `run_comms()` runner |
| `backend/app/evals/comms_classifier_eval.py` | fixtures + `score_classifier()` |
| `backend/app/models.py` | add `CommsReviewItem` table (modify) |
| `backend/app/api/v1/comms.py` | `POST /comms/ingest`, `GET /comms/review`, `POST /comms/review/{id}/resolve` |
| `backend/app/main.py` | register the comms router (modify) |
| `backend/tests/test_comms_connectors.py` | all backend tests |
| `frontend/src/app/comms-review/{layout,page}.tsx` | web review queue |
| `frontend/src/components/layout/AppShell.tsx` | add "Review queue" nav item (modify) |

---

## Task 1: Types + simulated sources

**Files:**
- Create: `backend/app/ingestion/comms/__init__.py` (empty)
- Create: `backend/app/ingestion/comms/types.py`
- Create: `backend/app/ingestion/comms/sources.py`
- Test: `backend/tests/test_comms_connectors.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_comms_connectors.py
from app.ingestion.comms.sources import SlackSource, TicketSource, TextSource
from app.ingestion.comms.types import CommsItem


def test_sources_emit_venue_scoped_items_deterministically():
    for Source, name in [(SlackSource, "slack"), (TicketSource, "tickets"), (TextSource, "sms")]:
        items = Source(["v1"]).list_items()
        assert items and all(isinstance(i, CommsItem) for i in items)
        assert all(i.venue_id == "v1" and i.source == name for i in items)
        # stable external_id within a window → re-listing is identical
        again = Source(["v1"]).list_items()
        assert [i.external_id for i in items] == [i.external_id for i in again]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_sources_emit_venue_scoped_items_deterministically -q`
Expected: FAIL (module `app.ingestion.comms.sources` not found).

- [ ] **Step 3: Write `types.py`**

```python
# backend/app/ingestion/comms/types.py
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

CommsKind = Literal["incident", "compliance", "noise"]


@dataclass
class CommsItem:
    """One raw message/ticket/text pulled from a source (pre-classification)."""
    source: str            # "slack" | "tickets" | "sms"
    venue_id: str
    external_id: str       # stable id from the source — the dedupe key
    text: str
    occurred_at: datetime
    author: str | None = None
    metadata: dict = field(default_factory=dict)


@dataclass
class CommsClassification:
    kind: CommsKind
    confidence: float
    fields: dict = field(default_factory=dict)
    rationale: str = ""
    model_version: str = "comms-clf-v1"
```

- [ ] **Step 4: Write `sources.py`**

```python
# backend/app/ingestion/comms/sources.py
"""Communication/workflow sources behind a single MCP-client seam.

v1 ships SIMULATED, network-free sources (deterministic per day, mirroring
PosConnector). The real implementation is a thin MCP client behind the same
`list_items` interface — swapping sim->real changes only this file.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional

from app.ingestion.comms.types import CommsItem
from app.time import now_utc

# (text, expected_kind) — expected_kind doubles as the eval label set (Task 2).
SAMPLE_FEED: dict[str, list[tuple[str, str]]] = {
    "slack": [
        ("Two patrons throwing punches at the front door, security broke it up", "incident"),
        ("Can someone restock the bar napkins before doors", "noise"),
        ("Exit sign by stairwell B is out again", "compliance"),
    ],
    "tickets": [
        ("Guest slipped on a spilled drink near booth 4, EMS was called", "incident"),
        ("Fire extinguisher tag expired in the kitchen", "compliance"),
        ("Office wifi is down", "noise"),
    ],
    "sms": [
        ("Fight outside, cops on the way", "incident"),
        ("Running 10 min late for my shift", "noise"),
        ("First aid kit is empty", "compliance"),
    ],
}


class CommsSource(ABC):
    source: str

    @abstractmethod
    def list_items(self, *, since: Optional[datetime] = None) -> list[CommsItem]:
        """Return raw items (optionally newer than `since`)."""


class _SimulatedSource(CommsSource):
    def __init__(self, source: str, venue_ids: list[str], *, as_of: Optional[datetime] = None):
        self.source = source
        self.venue_ids = venue_ids
        self.as_of = as_of or now_utc()

    def list_items(self, *, since: Optional[datetime] = None) -> list[CommsItem]:
        items: list[CommsItem] = []
        day = self.as_of.date().isoformat()
        for vid in self.venue_ids:
            for idx, (text, _label) in enumerate(SAMPLE_FEED[self.source]):
                items.append(
                    CommsItem(
                        source=self.source,
                        venue_id=vid,
                        external_id=f"{self.source}-{vid}-{idx}-{day}",
                        text=text,
                        occurred_at=self.as_of,
                        author="floor-staff",
                    )
                )
        return items


class SlackSource(_SimulatedSource):
    def __init__(self, venue_ids: list[str], **kw): super().__init__("slack", venue_ids, **kw)


class TicketSource(_SimulatedSource):
    def __init__(self, venue_ids: list[str], **kw): super().__init__("tickets", venue_ids, **kw)


class TextSource(_SimulatedSource):
    def __init__(self, venue_ids: list[str], **kw): super().__init__("sms", venue_ids, **kw)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py -q`
Expected: PASS (1 passed).

- [ ] **Step 6: Commit**

```bash
git add backend/app/ingestion/comms/__init__.py backend/app/ingestion/comms/types.py backend/app/ingestion/comms/sources.py backend/tests/test_comms_connectors.py
git commit -F - <<'EOF'
feat(comms): simulated Slack/tickets/SMS sources behind an MCP seam
EOF
```

---

## Task 2: Classifier + gate + eval scorer

**Files:**
- Create: `backend/app/ingestion/comms/classifier.py`
- Create: `backend/app/ingestion/comms/gate.py`
- Create: `backend/app/evals/comms_classifier_eval.py`
- Test: `backend/tests/test_comms_connectors.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_comms_connectors.py
from datetime import datetime, timezone
from app.ingestion.comms.classifier import classify_comms_item
from app.ingestion.comms.gate import decide
from app.evals.comms_classifier_eval import score_classifier


def _item(text: str) -> CommsItem:
    return CommsItem(source="slack", venue_id="v1", external_id="x", text=text,
                     occurred_at=datetime(2026, 2, 2, tzinfo=timezone.utc))


def test_classifier_labels_known_texts():
    assert classify_comms_item(_item("a fight broke out, police called")).kind == "incident"
    assert classify_comms_item(_item("fire extinguisher tag expired")).kind == "compliance"
    assert classify_comms_item(_item("restock the napkins")).kind == "noise"


def test_gate_routes_by_confidence():
    from app.ingestion.comms.types import CommsClassification
    assert decide(CommsClassification(kind="incident", confidence=0.95)) == "auto"
    assert decide(CommsClassification(kind="incident", confidence=0.5)) == "review"
    assert decide(CommsClassification(kind="noise", confidence=0.9)) == "drop"
    assert decide(CommsClassification(kind="noise", confidence=0.4)) == "review"


def test_eval_scorer_meets_threshold():
    report = score_classifier()
    assert report["accuracy"] >= 0.9
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py -q`
Expected: FAIL (`app.ingestion.comms.classifier` not found).

- [ ] **Step 3: Write `classifier.py`**

```python
# backend/app/ingestion/comms/classifier.py
"""Classify a CommsItem into incident / compliance / noise.

Default is a deterministic keyword classifier (testable, no LLM). Prod can inject
an LLM-backed `classifier` callable with the same signature — the routing and
eval-gating around it never change.
"""
from __future__ import annotations

from typing import Callable, Optional

from app.ingestion.comms.types import CommsClassification, CommsItem

_INCIDENT_KW = ["fight", "punch", "assault", "altercation", "weapon", "injured",
                "injury", "slip", "ems", "ambulance", "cops", "police", "blood"]
_AB_KW = ["fight", "punch", "assault", "altercation", "weapon"]
_COMPLIANCE_KW = ["exit sign", "extinguisher", "expired", "first aid", "cert",
                  "license", "permit", "inspection", "blocked", "fire"]


def _deterministic(item: CommsItem) -> CommsClassification:
    t = item.text.lower()
    inc = sum(k in t for k in _INCIDENT_KW)
    comp = sum(k in t for k in _COMPLIANCE_KW)
    if inc and inc >= comp:
        return CommsClassification(
            kind="incident",
            confidence=min(0.7 + 0.1 * inc, 0.99),
            fields={"category": "a_and_b" if any(k in t for k in _AB_KW) else "general"},
            rationale=f"matched {inc} incident cue(s)",
        )
    if comp:
        return CommsClassification(
            kind="compliance",
            confidence=min(0.7 + 0.1 * comp, 0.99),
            fields={"compliance_type": "facility"},
            rationale=f"matched {comp} compliance cue(s)",
        )
    return CommsClassification(kind="noise", confidence=0.8, rationale="no incident/compliance cues")


def classify_comms_item(
    item: CommsItem,
    *,
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> CommsClassification:
    return (classifier or _deterministic)(item)
```

- [ ] **Step 4: Write `gate.py`**

```python
# backend/app/ingestion/comms/gate.py
"""Eval-calibrated routing gate. Auto-create only when confidence clears the
per-kind threshold (tuned for >=0.90 precision on the eval set); else send to a
human. `noise` below its confidence threshold also goes to review so a possible
incident is never silently dropped."""
from __future__ import annotations

from typing import Literal

from app.ingestion.comms.types import CommsClassification

# Tune against app/evals/comms_classifier_eval.py.
AUTO_CREATE_THRESHOLD: dict[str, float] = {
    "incident": 0.90,
    "compliance": 0.85,
    "noise": 0.75,
}

Decision = Literal["auto", "review", "drop"]


def decide(c: CommsClassification) -> Decision:
    if c.kind == "noise":
        return "drop" if c.confidence >= AUTO_CREATE_THRESHOLD["noise"] else "review"
    return "auto" if c.confidence >= AUTO_CREATE_THRESHOLD[c.kind] else "review"
```

- [ ] **Step 5: Write `comms_classifier_eval.py`**

```python
# backend/app/evals/comms_classifier_eval.py
"""Rubric scorer for the comms classifier. Fixtures pair representative text with
its expected kind; the scorer reports accuracy + per-kind precision/recall so the
gate thresholds (app/ingestion/comms/gate.py) can be tuned to a precision target."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Optional

from app.ingestion.comms.classifier import classify_comms_item
from app.ingestion.comms.sources import SAMPLE_FEED
from app.ingestion.comms.types import CommsClassification, CommsItem

# Reuse the source samples as labels + a few harder cases.
FIXTURES: list[tuple[str, str]] = [
    (text, label) for feed in SAMPLE_FEED.values() for (text, label) in feed
] + [
    ("guard refused entry to an intoxicated patron", "noise"),
    ("someone got punched near the dance floor", "incident"),
    ("liquor license renewal due next month", "compliance"),
]


def score_classifier(
    classifier: Optional[Callable[[CommsItem], CommsClassification]] = None,
) -> dict:
    kinds = ["incident", "compliance", "noise"]
    tp = {k: 0 for k in kinds}
    fp = {k: 0 for k in kinds}
    fn = {k: 0 for k in kinds}
    correct = 0
    for text, expected in FIXTURES:
        item = CommsItem(source="eval", venue_id="v", external_id="e", text=text,
                         occurred_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
        pred = classify_comms_item(item, classifier=classifier).kind
        if pred == expected:
            correct += 1
            tp[expected] += 1
        else:
            fp[pred] += 1
            fn[expected] += 1
    def _ratio(n, d): return round(n / d, 3) if d else 1.0
    return {
        "accuracy": round(correct / len(FIXTURES), 3),
        "per_kind": {
            k: {"precision": _ratio(tp[k], tp[k] + fp[k]), "recall": _ratio(tp[k], tp[k] + fn[k])}
            for k in kinds
        },
        "n": len(FIXTURES),
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py -q`
Expected: PASS (all comms tests). If `accuracy < 0.9`, adjust keyword lists in `classifier.py` until the fixture set passes — do NOT lower the assertion.

- [ ] **Step 7: Commit**

```bash
git add backend/app/ingestion/comms/classifier.py backend/app/ingestion/comms/gate.py backend/app/evals/comms_classifier_eval.py backend/tests/test_comms_connectors.py
git commit -F - <<'EOF'
feat(comms): eval-gated classifier + calibration gate
EOF
```

---

## Task 3: `CommsReviewItem` model

**Files:**
- Modify: `backend/app/models.py` (add class near other tables)
- Test: `backend/tests/test_comms_connectors.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_comms_connectors.py
from sqlmodel import Session, SQLModel, create_engine


def _mem_session() -> Session:
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    return Session(eng)


def test_comms_review_item_roundtrips():
    from app.models import CommsReviewItem
    s = _mem_session()
    row = CommsReviewItem(id="cr-1", venue_id="v1", source="slack", external_id="x1",
                          raw_text="ambiguous thing", proposed_kind="incident",
                          confidence=0.5, fields={"category": "general"})
    s.add(row); s.commit()
    got = s.get(CommsReviewItem, "cr-1")
    assert got.status == "pending" and got.proposed_kind == "incident"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_comms_review_item_roundtrips -q`
Expected: FAIL (`cannot import name 'CommsReviewItem'`).

- [ ] **Step 3: Add the model to `backend/app/models.py`** (place after `StaffMember`/incident-related tables; `now_utc`, `Column`, `JSON` are already imported)

```python
class CommsReviewItem(SQLModel, table=True):
    """A comms item the classifier was not confident enough to auto-route, or
    that errored — parked for a human to confirm/correct/dismiss. Fresh table
    (created by create_all, no migration line needed)."""
    id: str = Field(primary_key=True)
    venue_id: str = Field(foreign_key="venue.id", index=True)
    source: str
    external_id: str = Field(index=True)
    raw_text: str
    author: Optional[str] = Field(default=None)
    occurred_at: datetime = Field(default_factory=now_utc)
    proposed_kind: str
    confidence: float
    rationale: Optional[str] = Field(default=None)
    fields: dict = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = Field(default="pending")   # pending | confirmed | corrected | dismissed
    resolved_by: Optional[str] = Field(default=None)
    resolved_kind: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=now_utc)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_comms_review_item_roundtrips -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/tests/test_comms_connectors.py
git commit -F - <<'EOF'
feat(comms): CommsReviewItem table for low-confidence classifications
EOF
```

---

## Task 4: Router (incident / compliance / noise / review)

**Files:**
- Create: `backend/app/ingestion/comms/router.py`
- Test: `backend/tests/test_comms_connectors.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_comms_connectors.py
from app.models import CommsReviewItem, ComplianceSignal, IncidentRecord


def test_router_creates_records_per_kind():
    from app.ingestion.comms.router import route
    from app.ingestion.comms.types import CommsClassification

    s = _mem_session()
    base = dict(source="slack", venue_id="v1", occurred_at=datetime(2026, 2, 2, tzinfo=timezone.utc))

    # high-confidence incident -> IncidentRecord
    r1 = route(s, CommsItem(external_id="i1", text="fight at door", **base),
               CommsClassification(kind="incident", confidence=0.95, fields={"category": "a_and_b"}))
    assert r1["action"] == "incident"
    assert s.get(IncidentRecord, r1["incident_id"]).reported_by_staff_id is None

    # high-confidence compliance -> ComplianceSignal
    r2 = route(s, CommsItem(external_id="c1", text="extinguisher expired", **base),
               CommsClassification(kind="compliance", confidence=0.9))
    assert r2["action"] == "compliance" and s.get(ComplianceSignal, r2["signal_id"]) is not None

    # noise -> dropped
    r3 = route(s, CommsItem(external_id="n1", text="napkins", **base),
               CommsClassification(kind="noise", confidence=0.9))
    assert r3["action"] == "noise"

    # low-confidence -> review item
    r4 = route(s, CommsItem(external_id="r1", text="someone seemed hurt maybe", **base),
               CommsClassification(kind="incident", confidence=0.5))
    assert r4["action"] == "review" and s.get(CommsReviewItem, r4["review_id"]).status == "pending"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_router_creates_records_per_kind -q`
Expected: FAIL (`app.ingestion.comms.router` not found).

- [ ] **Step 3: Write `router.py`**

```python
# backend/app/ingestion/comms/router.py
"""Turn a (CommsItem, CommsClassification) into the right record, per the gate.
Services don't commit — the runner/API owns the transaction."""
from __future__ import annotations

from uuid import uuid4

from sqlmodel import Session

from app.ingestion.comms.gate import decide
from app.ingestion.comms.types import CommsClassification, CommsItem
from app.models import CommsReviewItem, ComplianceSignal, IncidentRecord
from app.packet_core import _add_audit_event
from app.time import now_utc


def _create_incident(session: Session, item: CommsItem, c: CommsClassification) -> IncidentRecord:
    inc = IncidentRecord(
        # deterministic id embeds the source external_id so re-ingesting the same
        # message can't create a duplicate incident (see connector dedupe).
        id=f"inc-comms-{item.source}-{item.external_id}",
        venue_id=item.venue_id,
        occurred_at=item.occurred_at.isoformat(),
        location=f"Reported via {item.source}",
        summary=item.text.strip() or "(no details)",
        reported_by=item.author or item.source,
        injury_observed=False, police_called=False, ems_called=False,
        status="open",
        incident_category=c.fields.get("category"),
    )
    session.add(inc)
    session.flush()
    return inc


def _create_compliance(session: Session, item: CommsItem, c: CommsClassification) -> ComplianceSignal:
    sig_id = f"COMMS_{item.source}_{item.external_id}"
    existing = session.get(ComplianceSignal, sig_id)
    if existing is not None:
        return existing
    row = ComplianceSignal(
        id=sig_id, venue_id=item.venue_id,
        title=f"{item.source.upper()}_FLAG",
        description=item.text.strip() or "(no details)",
        provenance=f"comms_{item.source}", severity="medium", status="open",
    )
    session.add(row)
    _add_audit_event(
        session=session, actor_id="comms_connector", actor_type="system",
        entity_type="compliance_signal", entity_id=sig_id,
        event_type="compliance_signal.open",
        event_metadata={"venue_id": item.venue_id, "reason": "comms_ingest", "source": item.source},
    )
    return row


def _create_review(session: Session, item: CommsItem, c: CommsClassification) -> CommsReviewItem:
    rv = CommsReviewItem(
        id=f"cr-{uuid4().hex[:12]}",
        venue_id=item.venue_id, source=item.source, external_id=item.external_id,
        raw_text=item.text, author=item.author, occurred_at=item.occurred_at,
        proposed_kind=c.kind, confidence=c.confidence, rationale=c.rationale,
        fields=dict(c.fields), status="pending",
    )
    session.add(rv)
    session.flush()
    return rv


def route(session: Session, item: CommsItem, classification: CommsClassification) -> dict:
    decision = decide(classification)
    if decision == "drop":
        return {"action": "noise"}
    if decision == "review":
        rv = _create_review(session, item, classification)
        return {"action": "review", "review_id": rv.id}
    if classification.kind == "incident":
        inc = _create_incident(session, item, classification)
        return {"action": "incident", "incident_id": inc.id}
    sig = _create_compliance(session, item, classification)
    return {"action": "compliance", "signal_id": sig.id}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_router_creates_records_per_kind -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/ingestion/comms/router.py backend/tests/test_comms_connectors.py
git commit -F - <<'EOF'
feat(comms): route classifications to incident / compliance / review
EOF
```

---

## Task 5: `CommsConnector` + runner

**Files:**
- Create: `backend/app/ingestion/comms/connector.py`
- Test: `backend/tests/test_comms_connectors.py` (append)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_comms_connectors.py
def test_run_comms_processes_and_dedupes():
    from app.ingestion.comms.connector import run_comms
    s = _mem_session()
    # seed the FK venue so incident/compliance inserts satisfy it on strict dialects
    from app.models import Venue
    s.add(Venue(id="v1", name="v1")); s.commit()

    summary = run_comms("slack", s, venue_ids=["v1"])
    assert summary["extracted"] == 3                  # 3 sample slack items
    assert summary["incident"] + summary["compliance"] + summary["noise"] + summary["review"] == 3
    assert summary["incident"] >= 1 and summary["compliance"] >= 1

    # re-run same window -> created records (incident, compliance) are deduped;
    # noise leaves no row so it harmlessly re-evaluates. No new records created.
    again = run_comms("slack", s, venue_ids=["v1"])
    assert again["incident"] == 0 and again["compliance"] == 0
    assert again["skipped"] >= 2   # the incident + compliance items
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_run_comms_processes_and_dedupes -q`
Expected: FAIL (`app.ingestion.comms.connector` not found).

- [ ] **Step 3: Write `connector.py`**

```python
# backend/app/ingestion/comms/connector.py
"""Run a comms source through classify -> gate -> route, idempotent on re-run and
with a per-run summary. Standalone runner (not run_connector) because the output
is evidence-layer records, not metrics — but it mirrors the spine's shape:
extract -> transform -> dedupe -> load. A classifier error never aborts the run
or drops an item — it falls safe to the review queue (spec §9)."""
from __future__ import annotations

from uuid import uuid4

from sqlmodel import Session, select

from app.ingestion.comms.classifier import classify_comms_item
from app.ingestion.comms.router import _create_review, route
from app.ingestion.comms.sources import SlackSource, TicketSource, TextSource
from app.ingestion.comms.types import CommsClassification, CommsItem
from app.models import CommsReviewItem, ComplianceSignal, IncidentRecord, IngestionRun
from app.time import now_utc

_SOURCES = {"slack": SlackSource, "tickets": TicketSource, "sms": TextSource}


def _already_ingested(session: Session, item: CommsItem) -> bool:
    """An item already produced a record if any of its deterministic targets
    exist. (noise produces no row, so it harmlessly re-evaluates on re-run —
    that creates nothing, so records never duplicate.)"""
    if session.get(IncidentRecord, f"inc-comms-{item.source}-{item.external_id}"):
        return True
    if session.get(ComplianceSignal, f"COMMS_{item.source}_{item.external_id}"):
        return True
    review = session.exec(
        select(CommsReviewItem)
        .where(CommsReviewItem.source == item.source)
        .where(CommsReviewItem.external_id == item.external_id)
    ).first()
    return review is not None


def run_comms(source: str, session: Session, *, venue_ids: list[str], as_of=None) -> dict:
    if source == "all":
        agg: dict = {"source": "all"}
        for s in _SOURCES:
            for k, v in run_comms(s, session, venue_ids=venue_ids, as_of=as_of).items():
                if isinstance(v, int):
                    agg[k] = agg.get(k, 0) + v
        return agg
    src = _SOURCES[source](venue_ids, as_of=as_of) if as_of else _SOURCES[source](venue_ids)
    counts = {"source": source, "extracted": 0, "incident": 0, "compliance": 0,
              "noise": 0, "review": 0, "skipped": 0}
    for item in src.list_items():
        counts["extracted"] += 1
        if _already_ingested(session, item):
            counts["skipped"] += 1
            continue
        try:
            classification = classify_comms_item(item)
            result = route(session, item, classification)
        except Exception:
            # Fail safe to a human — never abort the run or silently drop.
            _create_review(session, item, CommsClassification(
                kind="incident", confidence=0.0, rationale="classifier error"))
            result = {"action": "review"}
        counts[result["action"]] += 1
    # Log an IngestionRun so the comms run shows in the existing /ingestion view
    # (loaded = auto-created records; rejected = noise).
    session.add(IngestionRun(
        id=f"comms-{uuid4().hex[:12]}", source_system=f"{source}_comms",
        status="success", extracted=counts["extracted"],
        loaded=counts["incident"] + counts["compliance"],
        rejected=counts["noise"], skipped=counts["skipped"], finished_at=now_utc(),
    ))
    session.commit()
    return counts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py -q`
Expected: PASS (all comms tests, including the updated router test — re-run it too).

- [ ] **Step 5: Commit**

```bash
git add backend/app/ingestion/comms/connector.py backend/tests/test_comms_connectors.py
git commit -F - <<'EOF'
feat(comms): CommsConnector runner with deterministic-id dedupe
EOF
```

---

## Task 6: API — ingest, review list, resolve

**Files:**
- Create: `backend/app/api/v1/comms.py`
- Modify: `backend/app/main.py` (register router)
- Test: `backend/tests/test_comms_connectors.py` (append; uses `TestClient` like `tests/test_staff.py`)

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_comms_connectors.py
import pytest
from fastapi.testclient import TestClient
from app.auth import create_token
from app.database import get_session
from app.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _broker_h():
    return {"Authorization": f"Bearer {create_token('u-brk-comms', 'b@x.com', 'broker', None)}"}


def test_comms_ingest_and_review_resolve(client):
    # ingest a slack batch for a seeded venue (elsewhere-brooklyn exists in demo seed)
    r = client.post("/api/comms/ingest", json={"source": "slack"}, headers=_broker_h())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["extracted"] >= 1

    # review queue is readable
    rv = client.get("/api/comms/review", headers=_broker_h())
    assert rv.status_code == 200
    items = rv.json()
    assert isinstance(items, list)

    # resolving a review item (if any) with dismiss creates nothing
    if items:
        rid = items[0]["id"]
        res = client.post(f"/api/comms/review/{rid}/resolve",
                          json={"decision": "dismiss"}, headers=_broker_h())
        assert res.status_code == 200 and res.json()["status"] == "dismissed"


def test_comms_ingest_requires_auth(client):
    assert client.post("/api/comms/ingest", json={"source": "slack"}).status_code == 401
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py::test_comms_ingest_requires_auth -q`
Expected: FAIL (404 — route not registered).

- [ ] **Step 3: Write `backend/app/api/v1/comms.py`**

```python
# backend/app/api/v1/comms.py
"""Comms-connector HTTP surface: trigger ingestion, read the review queue, and
resolve (confirm/correct/dismiss) low-confidence items. Broker-wide; operators
are scoped to their own venue."""
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.auth import can_access_venue, current_user_optional, require_broker
from app.database import get_session
from app.ingestion.comms.connector import run_comms
from app.ingestion.comms.router import _create_compliance, _create_incident
from app.ingestion.comms.types import CommsClassification, CommsItem
from app.models import CommsReviewItem, Venue
from app.packet_core import _add_audit_event

router = APIRouter()


class IngestBody(BaseModel):
    source: str = "all"          # slack | tickets | sms | all


class ResolveBody(BaseModel):
    decision: str                 # confirm | correct | dismiss
    kind: str | None = None       # required for "correct": incident | compliance | noise


def _all_venue_ids(session: Session) -> list[str]:
    return [v.id for v in session.exec(select(Venue)).all()]


@router.post("/comms/ingest")
def comms_ingest(
    body: IngestBody,
    session: Session = Depends(get_session),
    user: dict = Depends(require_broker),
):
    return run_comms(body.source, session, venue_ids=_all_venue_ids(session))


@router.get("/comms/review")
def comms_review(
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    user = current_user_optional(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    q = select(CommsReviewItem).where(CommsReviewItem.status == "pending")
    rows = session.exec(q).all()
    if user.get("role") not in ("broker", "admin"):
        rows = [r for r in rows if can_access_venue(user, r.venue_id, session)]
    return [
        {"id": r.id, "venue_id": r.venue_id, "source": r.source, "raw_text": r.raw_text,
         "proposed_kind": r.proposed_kind, "confidence": r.confidence, "rationale": r.rationale}
        for r in rows
    ]


@router.post("/comms/review/{review_id}/resolve")
def comms_resolve(
    review_id: str,
    body: ResolveBody,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    user = current_user_optional(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    row = session.get(CommsReviewItem, review_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Review item not found")
    if not can_access_venue(user, row.venue_id, session):
        raise HTTPException(status_code=403, detail="No access to this venue")

    kind = row.proposed_kind if body.decision == "confirm" else body.kind
    if body.decision == "correct" and kind not in ("incident", "compliance", "noise"):
        raise HTTPException(status_code=400, detail={"error": "comms_error", "message": "correct needs a valid kind"})

    item = CommsItem(source=row.source, venue_id=row.venue_id, external_id=row.external_id,
                     text=row.raw_text, occurred_at=row.occurred_at, author=row.author)
    classification = CommsClassification(kind=kind or "noise", confidence=1.0, fields=row.fields)

    created = None
    if body.decision != "dismiss" and kind == "incident":
        created = _create_incident(session, item, classification).id
    elif body.decision != "dismiss" and kind == "compliance":
        created = _create_compliance(session, item, classification).id

    row.status = "dismissed" if body.decision == "dismiss" else ("confirmed" if body.decision == "confirm" else "corrected")
    row.resolved_by = user.get("sub")
    row.resolved_kind = kind
    session.add(row)
    _add_audit_event(
        session=session, actor_id=user.get("sub") or "unknown", actor_type="user",
        entity_type="comms_review", entity_id=row.id,
        event_type=f"comms_review.{body.decision}",
        event_metadata={"venue_id": row.venue_id, "resolved_kind": kind, "created": created},
    )
    session.commit()
    return {"status": row.status, "resolved_kind": kind, "created": created}
```

- [ ] **Step 4: Register the router in `backend/app/main.py`** (after the staff router include, ~line 456)

```python
from app.api.v1.comms import router as comms_router  # noqa: E402
app.include_router(comms_router, prefix="/api", tags=["comms"])
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_comms_connectors.py -q`
Expected: PASS (all comms tests).

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/comms.py backend/app/main.py backend/tests/test_comms_connectors.py
git commit -F - <<'EOF'
feat(comms): ingest + review-queue API (resolve confirm/correct/dismiss)
EOF
```

---

## Task 7: Web review queue

**Files:**
- Create: `frontend/src/app/comms-review/layout.tsx`
- Create: `frontend/src/app/comms-review/page.tsx`
- Modify: `frontend/src/components/layout/AppShell.tsx` (add a broker/operator nav item)

- [ ] **Step 1: Create `layout.tsx`** (mirror `frontend/src/app/incidents/layout.tsx`)

```tsx
import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";

export default function CommsReviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
    </AppShell>
  );
}
```

- [ ] **Step 2: Create `page.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";
import { toastSuccess, toastError } from "@/lib/toast";
import { Inbox, Check, X, AlertTriangle } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ReviewItem {
  id: string; venue_id: string; source: string; raw_text: string;
  proposed_kind: string; confidence: number; rationale: string | null;
}

export default function CommsReviewPage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/"); }, [isLoaded, isSignedIn, router]);

  const load = () => {
    fetch(`${API_URL}/api/comms/review`, { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const resolve = async (id: string, decision: string, kind?: string) => {
    try {
      const res = await fetch(`${API_URL}/api/comms/review/${id}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ decision, kind }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      toastSuccess("Resolved");
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e: any) { toastError(e?.message || "Failed to resolve"); }
  };

  if (!isSignedIn || loading) return <div className="page-loading"><div className="loading-spinner" /></div>;

  return (
    <div className="lc-shell min-h-screen theme-venue" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">REVIEW QUEUE<span className="lc-eyebrow__sep" />COMMS</span>
          <h1 className="lc-display">Triage <em>signals</em></h1>
          <p className="lc-sub">Low-confidence classifications from Slack, tickets, and texts — confirm, correct, or dismiss.</p>
        </div>
      </section>

      <div className="incidents-list stagger-children">
        {items.length > 0 ? items.map((it) => (
          <div key={it.id} className="incident-card" style={{ cursor: "default" }}>
            <div className="incident-icon"><Inbox size={20} aria-hidden /></div>
            <div className="incident-info">
              <div className="incident-header-row">
                <h4>{it.raw_text.slice(0, 80)}</h4>
                <span className="badge badge-warning">
                  {it.proposed_kind} · {Math.round(it.confidence * 100)}%
                </span>
              </div>
              <p className="incident-desc">{it.raw_text}</p>
              <div className="incident-meta">
                <span>{it.source}</span>{it.rationale && <span>{it.rationale}</span>}
              </div>
              <div className="flex gap-xs" style={{ marginTop: "var(--space-sm)", flexWrap: "wrap" }}>
                <button className="btn btn-sm btn-primary" onClick={() => resolve(it.id, "confirm")}>
                  <Check size={14} /> Confirm {it.proposed_kind}
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => resolve(it.id, "correct", "incident")}>
                  <AlertTriangle size={14} /> It's an incident
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => resolve(it.id, "correct", "compliance")}>
                  Compliance
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => resolve(it.id, "dismiss")}>
                  <X size={14} /> Dismiss
                </button>
              </div>
            </div>
          </div>
        )) : (
          <div className="page-empty"><Inbox size={48} /><h3>Queue clear</h3><p>No comms signals waiting for review.</p></div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add a nav item in `AppShell.tsx`**

In the broker `groups` "Claims pipeline" group, add after Work Queue:
```tsx
          { href: "/comms-review", label: "Review Queue", icon: Inbox },
```
And in the operator "My venue" group, add after Compliance:
```tsx
          { href: "/comms-review", label: "Review Queue", icon: Inbox },
```
(`Inbox` is already imported in AppShell.)

- [ ] **Step 4: Verify build**

Run: `cd frontend && npx next build`
Expected: "Compiled successfully", `/comms-review` listed in the route table.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/comms-review frontend/src/components/layout/AppShell.tsx
git commit -F - <<'EOF'
feat(comms): web review queue for low-confidence comms classifications
EOF
```

---

## Task 8: Full-suite verification

- [ ] **Step 1: Run the full backend suite on a clean DB**

```bash
cd backend && rm -f database.db* && python -m pytest -q
```
Expected: all pass (existing count + the new comms tests), 0 failures. If `test_evidence_tenant_isolation` or similar fails on row counts, ensure the comms tests use unique/seeded venue ids and past-dated `occurred_at` (do not use far-future dates).

- [ ] **Step 2: Commit any fixups**

```bash
git add -A && git commit -F - <<'EOF'
test(comms): isolation fixups for shared-DB suite
EOF
```

---

## Notes for the implementer
- **TDD per task.** Red → green → commit. Never weaken an assertion to pass; fix the code.
- **Conventions:** `now_utc` for timestamps; `_add_audit_event` on state changes; services don't commit (the runner/API does); JSON columns read coerced.
- **Dedupe is the subtle part** (Task 5 Step 3a) — comms incidents use a deterministic id so re-runs don't duplicate.
- **Out of scope** (do not build): mobile review queue, real MCP source wiring, rubric auto-retrain. Stop at Task 8.
