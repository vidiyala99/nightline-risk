# Risk Intelligence Copilot (Sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an operator-only conversational copilot that answers grounded questions about exposure/risk/claims/compliance and can take two confirm-gated, audited actions — deterministic-first (keyless), eval-gated, surfaced at a dedicated `/copilot` page.

**Architecture:** A decoupled `app/copilot/` package mirroring `app/intelligence/`. A `ChatProvider` ABC has a `DeterministicChatProvider` (keyless CI/demo) and a key-gated `AnthropicChatProvider`. The provider only ever calls **tools** (pure typed functions over the persona-gated services) — never the DB — so every answer is grounded by construction. Act-tools are two-phase (propose → server-revalidated confirm) and execute through existing audited services (`create_proposal`, `upload_compliance_evidence`). A faithfulness guard + eval scorers (wired into `--compare-baseline` and `/evals`) run on the deterministic path.

**Tech Stack:** FastAPI + SQLModel + pytest (backend); Next.js 16 / React 19 / TypeScript + vitest (web). Reuses `app.auth.verify_token`/`require_venue_access`, `app.intelligence.compute_exposure`, `app.intelligence.accessible_venue_ids`, `app.schemas.domain.Citation`, `app.claim_proposals.create_proposal`, the compliance upload service, and `app.evals.baseline`.

**Spec:** `docs/superpowers/specs/2026-06-08-risk-intelligence-copilot-design.md`

---

## File Structure

**Backend (create):**
- `backend/app/copilot/__init__.py` — package marker.
- `backend/app/copilot/schemas.py` — `AnswerType`, `Citation` re-export, `ToolResult`, `ProposedAction`, `CopilotTurn`, `CopilotReply` (Pydantic).
- `backend/app/copilot/tools.py` — `CopilotScope`, the 4 read tools, the 2 act-tool validators+executors, and `TOOL_CATALOG`.
- `backend/app/copilot/faithfulness.py` — `assert_grounded(text, tool_results) -> GroundCheck`.
- `backend/app/copilot/provider.py` — `ChatProvider` ABC + `DeterministicChatProvider`.
- `backend/app/copilot/anthropic_provider.py` — key-gated `AnthropicChatProvider` + `get_chat_provider()`.
- `backend/app/copilot/engine.py` — `respond_to_message(user, session, message, confirm_action=None, attachment=None)`.
- `backend/app/api/v1/copilot.py` — `POST /api/copilot/message`.
- `backend/app/evals/copilot_scorers.py`, `copilot_scenarios.py`, `copilot_runner.py`, `copilot_baseline.json`.
- `backend/tests/copilot/__init__.py` + `test_*.py` per task.

**Backend (modify):**
- `backend/app/main.py` — register the copilot router.
- `backend/app/evals/runner.py` + `baseline.py` consumers — include copilot in the aggregate `--compare-baseline` (Task 11).

**Frontend (create):**
- `frontend/src/lib/copilot.ts` (+ `copilot.test.ts`) — typed client.
- `frontend/src/app/copilot/page.tsx` + `frontend/src/app/copilot/layout.tsx`.
- `frontend/src/components/copilot/CopilotPanel.tsx`.

**Frontend (modify):**
- `frontend/src/components/layout/AppShell.tsx` (or the operator nav source) — "Copilot" nav entry.
- `frontend/src/app/dashboard/page.tsx` — a launcher link.

---

## Task 1: Copilot schemas

**Files:**
- Create: `backend/app/copilot/__init__.py` (empty), `backend/tests/copilot/__init__.py` (empty), `backend/app/copilot/schemas.py`
- Test: `backend/tests/copilot/test_schemas.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_schemas.py
from app.copilot.schemas import (
    AnswerType, ToolResult, ProposedAction, CopilotReply,
)
from app.schemas.domain import Citation


def test_tool_result_carries_data_and_citations():
    tr = ToolResult(
        tool="get_risk_score",
        data={"score": 46, "tier": "C"},
        citations=[Citation(source_id="risk-elsewhere", source_type="risk_score", excerpt="46/100 tier C")],
    )
    assert tr.tool == "get_risk_score"
    assert tr.data["tier"] == "C"
    assert tr.citations[0].source_type == "risk_score"


def test_reply_defaults_are_safe():
    r = CopilotReply(answer_type=AnswerType.answer, text="ok")
    assert r.citations == []
    assert r.followups == []
    assert r.proposed_action is None


def test_proposed_action_roundtrips():
    pa = ProposedAction(
        kind="send_to_broker", target_id="inc-1", summary="Send the rear-bar incident",
        gating_passed=True,
    )
    assert ProposedAction(**pa.model_dump()).kind == "send_to_broker"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_schemas.py -q`
Expected: FAIL — `ModuleNotFoundError: app.copilot.schemas`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/copilot/schemas.py
from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field

from app.schemas.domain import Citation


class AnswerType(str, Enum):
    answer = "answer"
    clarify = "clarify"
    refuse = "refuse"
    propose_action = "propose_action"


class ToolResult(BaseModel):
    tool: str
    data: dict[str, Any] = Field(default_factory=dict)
    citations: list[Citation] = Field(default_factory=list)


class ProposedAction(BaseModel):
    kind: str                 # "send_to_broker" | "resolve_compliance"
    target_id: str            # incident_id | compliance item_id
    summary: str              # human-readable confirmation text
    gating_passed: bool       # hint only; server re-validates on confirm
    requires_attachment: bool = False


class CopilotTurn(BaseModel):
    message: str
    confirm_action: Optional[ProposedAction] = None


class CopilotReply(BaseModel):
    answer_type: AnswerType
    text: str
    citations: list[Citation] = Field(default_factory=list)
    proposed_action: Optional[ProposedAction] = None
    followups: list[str] = Field(default_factory=list)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_schemas.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/__init__.py backend/tests/copilot/__init__.py backend/app/copilot/schemas.py backend/tests/copilot/test_schemas.py
git commit -F- <<'EOF'
feat(copilot): typed schemas for turns, tool results, replies

Spec §3,5,6. ToolResult carries citations so grounding travels with
every tool call; ProposedAction.gating_passed is a hint the server
re-validates.
EOF
```

---

## Task 2: Read tools + scope + catalog

**Files:**
- Create: `backend/app/copilot/tools.py`
- Test: `backend/tests/copilot/test_tools_read.py`
- Reference: `app/intelligence/engine.py:24` (`compute_exposure`, `accessible_venue_ids`); `app/api/v1/incidents.py:349` (`venue_incident_status_feed`); risk score via `GET /api/venues/{id}/risk-score`; claims via `GET /api/venues/{id}/claims`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_tools_read.py
from datetime import datetime, timezone
from sqlmodel import Session, SQLModel, create_engine

from app.copilot.tools import CopilotScope, TOOL_CATALOG, get_exposure, get_risk_score
from app.models import Venue, RiskScore  # RiskScore: adjust to the real risk persistence


def _scope(session) -> CopilotScope:
    return CopilotScope(
        user={"role": "venue_operator", "tenant_id": "v1"},
        venue_ids={"v1"},
        session=session,
        now=datetime(2026, 6, 8, tzinfo=timezone.utc),
    )


def make_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_catalog_exposes_the_four_read_tools():
    names = {t.name for t in TOOL_CATALOG if t.kind == "read"}
    assert names == {"get_exposure", "get_risk_score", "list_open_claims", "list_incidents"}


def test_get_exposure_returns_grounded_findings(monkeypatch):
    from app.copilot import tools
    from app.intelligence.finding import Finding, Subject, RecommendedAction, Prediction
    fake = [Finding(id="evidence_gap:inc-1", persona="venue_operator", kind="evidence_gap",
                    subject=Subject(entity_type="incident", entity_id="inc-1", label="rear bar", href="/incidents/inc-1"),
                    severity="high", recommended_action=RecommendedAction(label="Attach evidence", href="/incidents/inc-1"),
                    prediction=Prediction(claim="thin evidence weakens any claim"))]
    monkeypatch.setattr(tools, "compute_exposure", lambda user, session, now=None: fake)
    with make_session() as s:
        res = get_exposure(_scope(s), {})
    assert res.tool == "get_exposure"
    assert res.data["count"] == 1
    assert res.citations and res.citations[0].source_id == "evidence_gap:inc-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_tools_read.py -q`
Expected: FAIL — `ImportError: cannot import name 'CopilotScope'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/copilot/tools.py
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Optional

from sqlmodel import Session

from app.copilot.schemas import ToolResult
from app.intelligence.engine import compute_exposure
from app.schemas.domain import Citation


@dataclass
class CopilotScope:
    user: dict
    venue_ids: Optional[set[str]]   # operator: their venues; None = unrestricted
    session: Session
    now: datetime

    @property
    def primary_venue_id(self) -> Optional[str]:
        return self.user.get("tenant_id") or (next(iter(self.venue_ids)) if self.venue_ids else None)


@dataclass
class ToolDef:
    name: str
    kind: str  # "read" | "act"
    run: Callable[[CopilotScope, dict], ToolResult]


def get_exposure(scope: CopilotScope, args: dict) -> ToolResult:
    findings = compute_exposure(scope.user, scope.session, now=scope.now)
    return ToolResult(
        tool="get_exposure",
        data={
            "count": len(findings),
            "items": [
                {"id": f.id, "kind": f.kind, "severity": f.severity,
                 "label": f.subject.label or f.subject.entity_id,
                 "action": f.recommended_action.label, "href": f.subject.href}
                for f in findings
            ],
        },
        citations=[Citation(source_id=f.id, source_type=f.kind,
                            excerpt=(f.why[0].excerpt if f.why else f.recommended_action.label))
                   for f in findings],
    )


def get_risk_score(scope: CopilotScope, args: dict) -> ToolResult:
    # Reuse the venue risk-score computation behind GET /api/venues/{id}/risk-score.
    # Implementation: import the service function the route uses (e.g. app.scoring.compute_risk_score)
    # and format score + top factors. Citation = source_type "risk_score".
    from app.scoring import compute_risk_score  # adjust to the real symbol the route calls
    vid = scope.primary_venue_id
    rs = compute_risk_score(scope.session, vid)
    factors = sorted(rs["factors"].items(), key=lambda kv: kv[1].get("score", kv[1]) if isinstance(kv[1], dict) else kv[1])
    top = factors[0][0] if factors else ""
    return ToolResult(
        tool="get_risk_score",
        data={"score": rs["total_score"], "tier": rs["tier"], "top_factor": top},
        citations=[Citation(source_id=f"risk-{vid}", source_type="risk_score",
                            excerpt=f"{rs['total_score']}/100 tier {rs['tier']}; weakest: {top}")],
    )


def list_open_claims(scope: CopilotScope, args: dict) -> ToolResult:
    from app.services.claims import list_venue_claims  # adjust to the real venue-claims service
    vid = scope.primary_venue_id
    rows = [c for c in list_venue_claims(scope.session, vid)]
    return ToolResult(
        tool="list_open_claims",
        data={"count": len(rows),
              "items": [{"id": c.id, "status": c.status, "coverage": c.coverage_line} for c in rows]},
        citations=[Citation(source_id=c.id, source_type="claim",
                            excerpt=f"{c.coverage_line} · {c.status}") for c in rows],
    )


def list_incidents(scope: CopilotScope, args: dict) -> ToolResult:
    from app.api.v1.incidents import venue_incident_status_feed  # returns list[dict]
    vid = scope.primary_venue_id
    # Call the underlying feed query directly (not the route) to avoid auth header plumbing;
    # if the query lives inline in the route, extract it into a helper `incident_status_feed(session, venue_id)`.
    from app.services.incident_feed import incident_status_feed
    rows = incident_status_feed(scope.session, vid)
    return ToolResult(
        tool="list_incidents",
        data={"count": len(rows), "items": rows},
        citations=[Citation(source_id=r["incident_id"], source_type="incident",
                            excerpt=f"{r['summary'][:60]} · {r['status']}") for r in rows],
    )


TOOL_CATALOG: list[ToolDef] = [
    ToolDef("get_exposure", "read", get_exposure),
    ToolDef("get_risk_score", "read", get_risk_score),
    ToolDef("list_open_claims", "read", list_open_claims),
    ToolDef("list_incidents", "read", list_incidents),
    # act-tools appended in Task 3
]
```

> **Implementation note for the executing engineer:** the three reuse imports (`app.scoring.compute_risk_score`, `app.services.claims.list_venue_claims`, `app.services.incident_feed.incident_status_feed`) are the *intent*. Before writing them, grep the existing route handlers (`GET /api/venues/{id}/risk-score`, `/claims`, `/incident-status-feed`) for the real service symbol they call and import that; if the logic is inline in the route, extract a pure `(session, venue_id) -> ...` helper and call it from both the route and the tool (DRY — one source of truth). Add a focused unit test per tool against an in-memory seeded session.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_tools_read.py -q`
Expected: PASS (catalog + get_exposure tests). Add the per-tool seeded tests as the reuse symbols are wired.

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/tools.py backend/tests/copilot/test_tools_read.py
git commit -F- <<'EOF'
feat(copilot): read tools + scope + catalog

Spec §4. Four read tools wrap the persona-gated services; each returns
a ToolResult with citations so grounding is carried, never invented.
EOF
```

---

## Task 3: Act-tools (two-phase: validate + execute)

**Files:**
- Modify: `backend/app/copilot/tools.py`
- Test: `backend/tests/copilot/test_tools_act.py`
- Reference: `app/claim_routing.py:29` (`route_status`), `recommendation_for_packet`; `app/claim_proposals.py:61` (`create_proposal`, idempotent); the compliance upload service behind `POST /api/venues/{id}/compliance/{item}/upload`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_tools_act.py
from app.copilot.tools import validate_send_to_broker, ActValidation


def test_send_to_broker_blocked_without_active_policy(seeded_borderline_incident_no_policy):
    scope, incident_id = seeded_borderline_incident_no_policy
    v: ActValidation = validate_send_to_broker(scope, incident_id)
    assert v.ok is False
    assert "policy" in v.reason.lower()


def test_send_to_broker_ok_when_borderline_and_insured(seeded_borderline_incident_insured):
    scope, incident_id = seeded_borderline_incident_insured
    v = validate_send_to_broker(scope, incident_id)
    assert v.ok is True
    assert v.proposed.kind == "send_to_broker"
```

(Provide the two fixtures in `tests/copilot/conftest.py`, mirroring `tests/test_claim_routing.py` seeding: a venue + packet at confidence 0.55; `_insured` variant additionally seeds an active `Policy`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_tools_act.py -q`
Expected: FAIL — `ImportError: validate_send_to_broker`.

- [ ] **Step 3: Write minimal implementation**

```python
# append to backend/app/copilot/tools.py
from dataclasses import dataclass as _dc

from app.copilot.schemas import ProposedAction
from app.models import UnderwritingPacket, ClaimProposal
from sqlmodel import select


@_dc
class ActValidation:
    ok: bool
    reason: str = ""
    proposed: Optional[ProposedAction] = None


def _primary_packet_for_incident(session: Session, incident_id: str) -> Optional[UnderwritingPacket]:
    return session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == incident_id)
    ).first()


def validate_send_to_broker(scope: CopilotScope, incident_id: str) -> ActValidation:
    from app.claim_routing import recommendation_for_packet, route_status
    pkt = _primary_packet_for_incident(scope.session, incident_id)
    if pkt is None:
        return ActValidation(False, "No insurance report exists for that incident yet.")
    existing = scope.session.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == pkt.id)
    ).first()
    if existing is not None:
        return ActValidation(False, "That incident has already been sent to your broker.")
    rec = recommendation_for_packet(scope.session, pkt)
    if not rec.has_active_policy:
        return ActValidation(False, "There's no active policy to file against — talk to your broker about coverage.")
    if route_status(rec) != "borderline":
        return ActValidation(False, "That incident isn't in the operator-decision band.")
    return ActValidation(True, proposed=ProposedAction(
        kind="send_to_broker", target_id=incident_id,
        summary=f"Send this incident to your broker (net {'+' if rec.net_expected_value_usd >= 0 else '-'}${abs(rec.net_expected_value_usd):,}).",
        gating_passed=True,
    ))


def execute_send_to_broker(scope: CopilotScope, incident_id: str) -> ToolResult:
    from app.claim_routing import recommendation_for_packet
    from app.claim_recommendation import recommendation_to_dict
    from app.claim_proposals import create_proposal
    v = validate_send_to_broker(scope, incident_id)
    if not v.ok:
        return ToolResult(tool="send_to_broker", data={"executed": False, "reason": v.reason})
    pkt = _primary_packet_for_incident(scope.session, incident_id)
    rec = recommendation_for_packet(scope.session, pkt)
    proposal = create_proposal(
        session=scope.session, packet_id=pkt.id,
        operator_id=scope.user.get("user_id", "operator"),
        override_recommendation=False, override_reason=None, override_freetext=None,
        recommendation_snapshot=recommendation_to_dict(rec),
    )
    return ToolResult(tool="send_to_broker",
                      data={"executed": True, "proposal_id": proposal.id, "state": proposal.state},
                      citations=[Citation(source_id=proposal.id, source_type="claim_proposal",
                                          excerpt="Sent to broker · awaiting decision")])
```

Add the compliance pair analogously:

```python
def validate_resolve_compliance(scope: CopilotScope, item_id: str) -> ActValidation:
    from app.main import _find_compliance_item, _resolve_venue
    vid = scope.primary_venue_id
    venue = _resolve_venue(vid, scope.session)
    item = _find_compliance_item(vid, venue, item_id, session=scope.session)
    if item is None:
        return ActValidation(False, "I can't find that compliance item.")
    if getattr(item, "status", "") == "resolved":
        return ActValidation(False, "That item is already resolved.")
    return ActValidation(True, proposed=ProposedAction(
        kind="resolve_compliance", target_id=item_id,
        summary=f"Resolve “{item.description}” by uploading the required evidence.",
        gating_passed=True, requires_attachment=True,
    ))


def execute_resolve_compliance(scope: CopilotScope, item_id: str, *, file) -> ToolResult:
    from app.services.compliance_upload import upload_compliance_evidence_sync  # extract the route body into a sync service
    v = validate_resolve_compliance(scope, item_id)
    if not v.ok:
        return ToolResult(tool="resolve_compliance", data={"executed": False, "reason": v.reason})
    if file is None:
        return ToolResult(tool="resolve_compliance", data={"executed": False, "reason": "Attach the evidence file to resolve this item."})
    result = upload_compliance_evidence_sync(scope.session, scope.primary_venue_id, item_id, file,
                                             uploaded_by=scope.user.get("user_id", "operator"))
    return ToolResult(tool="resolve_compliance", data={"executed": True, **result},
                      citations=[Citation(source_id=item_id, source_type="compliance",
                                          excerpt="Evidence uploaded · item resolved")])


TOOL_CATALOG += [
    ToolDef("send_to_broker", "act", lambda scope, args: execute_send_to_broker(scope, args["target_id"])),
    ToolDef("resolve_compliance", "act", lambda scope, args: execute_resolve_compliance(scope, args["target_id"], file=args.get("file"))),
]
```

> **Implementation note:** extract the compliance upload route body (`app/api/v1/compliance.py:43` `upload_compliance_evidence`) into a pure `upload_compliance_evidence_sync(session, venue_id, item_id, file, uploaded_by) -> dict` service and have the route call it (DRY). The act-tool calls the same service, so the resolve path is single-sourced and audited identically.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_tools_act.py -q`
Expected: PASS. Add an `execute_send_to_broker` test asserting a `ClaimProposal` row is created exactly once (idempotency reuse).

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/tools.py backend/tests/copilot/test_tools_act.py backend/tests/copilot/conftest.py
git commit -F- <<'EOF'
feat(copilot): confirm-gated act-tools (send-to-broker, resolve-compliance)

Spec §4. Two-phase: validate→ProposedAction, execute through the existing
audited services (create_proposal idempotent; compliance upload extracted
to a shared sync service). No-policy / already-routed / resolved cases blocked.
EOF
```

---

## Task 4: Faithfulness guard

**Files:**
- Create: `backend/app/copilot/faithfulness.py`
- Test: `backend/tests/copilot/test_faithfulness.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_faithfulness.py
from app.copilot.faithfulness import assert_grounded
from app.copilot.schemas import ToolResult
from app.schemas.domain import Citation


def _tr():
    return [ToolResult(tool="get_risk_score", data={"score": 46, "tier": "C"},
                       citations=[Citation(source_id="risk-v1", source_type="risk_score", excerpt="46/100 tier C")])]


def test_grounded_text_passes():
    g = assert_grounded("Your risk is 46/100, tier C.", _tr())
    assert g.ok is True


def test_unsupported_number_is_flagged():
    g = assert_grounded("Your risk is 92/100 and you owe $5,000.", _tr())
    assert g.ok is False
    assert g.unsupported  # at least one ungrounded token
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_faithfulness.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/copilot/faithfulness.py
from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.copilot.schemas import ToolResult

_NUM = re.compile(r"\$?\d[\d,]*(?:\.\d+)?%?")


@dataclass
class GroundCheck:
    ok: bool
    unsupported: list[str] = field(default_factory=list)


def _supported_strings(tool_results: list[ToolResult]) -> str:
    parts: list[str] = []
    for tr in tool_results:
        parts.append(str(tr.data))
        parts.extend(c.excerpt for c in tr.citations)
    return " ".join(parts)


def assert_grounded(text: str, tool_results: list[ToolResult]) -> GroundCheck:
    """Every numeric/currency token in the reply must appear in some tool result.
    Deterministic, conservative: numbers are the high-risk hallucination surface for
    this domain (scores, money, counts)."""
    haystack = _supported_strings(tool_results)
    hay_nums = set(_NUM.findall(haystack.replace(",", "")))
    unsupported = [t for t in _NUM.findall(text.replace(",", "")) if t not in hay_nums]
    return GroundCheck(ok=not unsupported, unsupported=unsupported)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_faithfulness.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/faithfulness.py backend/tests/copilot/test_faithfulness.py
git commit -F- <<'EOF'
feat(copilot): faithfulness guard (numeric grounding)

Spec §5. One definition shared by serve + eval. Conservative: every
number/currency token in a reply must trace to a tool result.
EOF
```

---

## Task 5: ChatProvider ABC + DeterministicChatProvider

**Files:**
- Create: `backend/app/copilot/provider.py`
- Test: `backend/tests/copilot/test_deterministic_provider.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_deterministic_provider.py
from app.copilot.provider import DeterministicChatProvider
from app.copilot.schemas import AnswerType, ToolResult
from app.schemas.domain import Citation


class _FakeTools:
    def run(self, name, args):
        return ToolResult(tool=name, data={"score": 46, "tier": "C"},
                          citations=[Citation(source_id="risk-v1", source_type="risk_score", excerpt="46/100 tier C")])
    catalog_names = {"get_risk_score", "get_exposure", "list_open_claims", "list_incidents"}


def test_risk_question_routes_to_risk_tool_and_grounds():
    p = DeterministicChatProvider()
    reply = p.respond("why is my risk a C?", tools=_FakeTools())
    assert reply.answer_type == AnswerType.answer
    assert "46" in reply.text and "C" in reply.text
    assert reply.citations


def test_off_topic_refuses():
    p = DeterministicChatProvider()
    reply = p.respond("what's the weather tonight?", tools=_FakeTools())
    assert reply.answer_type == AnswerType.refuse
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_deterministic_provider.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/copilot/provider.py
from __future__ import annotations

from abc import ABC, abstractmethod

from app.copilot.schemas import AnswerType, CopilotReply

# Intent ladder: ordered (keyword-set -> tool). First match wins. Over-fit guards
# live in the tests (novel phrasings per intent). Mirrors app/providers/deterministic.py.
_INTENT_LADDER: list[tuple[set[str], str]] = [
    ({"risk", "score", "tier", "rating"}, "get_risk_score"),
    ({"claim", "claims", "filed", "reserve"}, "list_open_claims"),
    ({"incident", "incidents", "report", "reports", "status"}, "list_incidents"),
    ({"exposure", "attention", "overdue", "evidence", "compliance", "expose", "risky"}, "get_exposure"),
]

_REFUSAL = ("I can help with your venue's exposure, risk score, open claims, and compliance. "
            "Try: “what needs my attention?” or “why is my risk a C?”")


def _classify(message: str) -> str | None:
    words = set(message.lower().replace("?", " ").replace("'", " ").split())
    for keys, tool in _INTENT_LADDER:
        if words & keys:
            return tool
    return None


class ChatProvider(ABC):
    @abstractmethod
    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply: ...


class DeterministicChatProvider(ChatProvider):
    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply:
        tool = _classify(message)
        if tool is None:
            return CopilotReply(answer_type=AnswerType.refuse, text=_REFUSAL)
        result = tools.run(tool, {})
        text = _template(tool, result)
        return CopilotReply(answer_type=AnswerType.answer, text=text, citations=result.citations)


def _template(tool: str, r) -> str:
    d = r.data
    if tool == "get_risk_score":
        return f"Your venue's risk is {d['score']}/100, tier {d['tier']}. Weakest driver: {d.get('top_factor','—')}."
    if tool == "get_exposure":
        return (f"{d['count']} thing(s) need your attention." if d.get("count")
                else "Nothing needs your attention right now.")
    if tool == "list_open_claims":
        return f"You have {d['count']} open claim(s)."
    if tool == "list_incidents":
        return f"{d['count']} active report(s)."
    return "Done."
```

> Note: the action-proposing branch (when `_classify` returns an act intent like "file"/"send to broker") is added in Task 7's engine integration, where the scope is available to validate. The deterministic provider here covers the read intents; the engine wraps action intents.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_deterministic_provider.py -q`
Expected: PASS (2 passed). Add 2-3 novel-phrasing tests per intent as over-fit guards.

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/provider.py backend/tests/copilot/test_deterministic_provider.py
git commit -F- <<'EOF'
feat(copilot): ChatProvider ABC + deterministic intent-routing provider

Spec §9. Keyless path: keyword ladder -> tool -> grounded template;
off-topic -> deterministic refusal. Over-fit guards in tests.
EOF
```

---

## Task 6: Key-gated AnthropicChatProvider + selector

**Files:**
- Create: `backend/app/copilot/anthropic_provider.py`
- Test: `backend/tests/copilot/test_provider_selector.py`
- Reference pattern: `app/providers/anthropic_provider.py` (`ProviderNotConfiguredError`, key gate).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_provider_selector.py
import pytest
from app.copilot.anthropic_provider import get_chat_provider, AnthropicChatProvider
from app.copilot.provider import DeterministicChatProvider


def test_selector_returns_deterministic_without_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert isinstance(get_chat_provider(), DeterministicChatProvider)


def test_selector_returns_anthropic_with_key(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert isinstance(get_chat_provider(), AnthropicChatProvider)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_provider_selector.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/copilot/anthropic_provider.py
from __future__ import annotations

import os

from app.copilot.provider import ChatProvider, DeterministicChatProvider
from app.copilot.schemas import AnswerType, CopilotReply


class AnthropicChatProvider(ChatProvider):
    """Key-gated. Same tool catalog; the model does NL + phrasing, emits a
    <<<META>>> tail (answer_type/citations/followups). The engine runs the
    faithfulness guard over .text. Only active when ANTHROPIC_API_KEY is set;
    never exercised in CI."""
    MODEL = "claude-haiku-4-5-20251001"

    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply:
        # v1: call the Messages API with the tool catalog as tool definitions, parse the
        # <<<META>>> tail. Until wired, fall back to deterministic so a key never breaks the
        # contract. (Full LLM wiring is a key-gated follow-up; the seam is what v1 ships.)
        return DeterministicChatProvider().respond(message, tools=tools, confirm_action=confirm_action)


def get_chat_provider() -> ChatProvider:
    if os.getenv("ANTHROPIC_API_KEY"):
        return AnthropicChatProvider()
    return DeterministicChatProvider()
```

> **Scope honesty:** v1 ships the *seam* + a real `AnthropicChatProvider` class, but its body delegates to deterministic until the Messages-API call is wired (a key-gated follow-up, untestable in CI). This keeps the keyless contract intact and the upgrade one method away. Record this as a fast-follow in the backlog.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_provider_selector.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/anthropic_provider.py backend/tests/copilot/test_provider_selector.py
git commit -F- <<'EOF'
feat(copilot): key-gated Anthropic provider + selector

Spec §3,9. One env var flips deterministic<->LLM. Body delegates to
deterministic until the Messages-API call is wired (key-gated follow-up).
EOF
```

---

## Task 7: Engine — respond + action round-trip

**Files:**
- Create: `backend/app/copilot/engine.py`
- Test: `backend/tests/copilot/test_engine.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_engine.py
from app.copilot.engine import respond_to_message
from app.copilot.schemas import AnswerType, ProposedAction


def test_read_question_grounds(seeded_operator_session):
    user, session = seeded_operator_session
    reply = respond_to_message(user, session, "what needs my attention?")
    assert reply.answer_type in (AnswerType.answer, AnswerType.refuse)


def test_action_intent_proposes_then_executes(seeded_borderline_incident_insured_user):
    user, session, incident_id = seeded_borderline_incident_insured_user
    # phase 1: propose
    reply = respond_to_message(user, session, f"send incident {incident_id} to my broker")
    assert reply.answer_type == AnswerType.propose_action
    assert reply.proposed_action.kind == "send_to_broker"
    # phase 2: confirm -> executes, re-validated server-side
    confirmed = respond_to_message(user, session, "", confirm_action=reply.proposed_action)
    assert confirmed.answer_type == AnswerType.answer
    assert "broker" in confirmed.text.lower()


def test_confirm_revalidates_and_blocks_stale_action(seeded_no_policy_incident_user):
    user, session, incident_id = seeded_no_policy_incident_user
    stale = ProposedAction(kind="send_to_broker", target_id=incident_id, summary="x", gating_passed=True)
    reply = respond_to_message(user, session, "", confirm_action=stale)
    assert reply.answer_type == AnswerType.refuse  # server re-validation catches no-policy
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_engine.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/copilot/engine.py
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional

from sqlmodel import Session

from app.copilot.anthropic_provider import get_chat_provider
from app.copilot.faithfulness import assert_grounded
from app.copilot.schemas import AnswerType, CopilotReply, ProposedAction
from app.copilot.tools import (
    CopilotScope, TOOL_CATALOG,
    validate_send_to_broker, execute_send_to_broker,
    validate_resolve_compliance, execute_resolve_compliance,
)
from app.intelligence.engine import accessible_venue_ids
from app.time import now_utc

_ACT_INTENT = re.compile(r"\b(send|file|submit).*(broker)\b|\bresolve\b.*\b(compliance|item)\b", re.I)
_ID = re.compile(r"\b(inc-[\w-]+)\b")


class _ToolBridge:
    def __init__(self, scope: CopilotScope):
        self._scope = scope
        self._by_name = {t.name: t for t in TOOL_CATALOG}
        self.catalog_names = {t.name for t in TOOL_CATALOG if t.kind == "read"}
        self.last_results = []

    def run(self, name, args):
        res = self._by_name[name].run(self._scope, args)
        self.last_results.append(res)
        return res


def _scope_for(user: dict, session: Session, now: datetime) -> CopilotScope:
    return CopilotScope(user=user, venue_ids=accessible_venue_ids(user, session), session=session, now=now)


def respond_to_message(user: dict, session: Session, message: str,
                       *, confirm_action: Optional[ProposedAction] = None,
                       attachment=None, now: Optional[datetime] = None) -> CopilotReply:
    now = now or now_utc()
    scope = _scope_for(user, session, now)

    # Phase 2: a confirmed action — RE-VALIDATE from scratch, then execute.
    if confirm_action is not None:
        return _execute_confirmed(scope, confirm_action, attachment)

    # Phase 1a: action intent -> validate -> propose (never execute on first turn).
    if _ACT_INTENT.search(message):
        return _propose_action(scope, message)

    # Phase 1b: read intent -> provider routes to a tool -> faithfulness-gated reply.
    bridge = _ToolBridge(scope)
    reply = get_chat_provider().respond(message, tools=bridge)
    if reply.answer_type == AnswerType.answer:
        g = assert_grounded(reply.text, bridge.last_results)
        if not g.ok:
            return CopilotReply(answer_type=AnswerType.clarify,
                                text="I can only speak to what your records show — let me pull the exact figures.",
                                citations=[c for r in bridge.last_results for c in r.citations])
    return reply


def _propose_action(scope: CopilotScope, message: str) -> CopilotReply:
    m = _ID.search(message)
    if "broker" in message.lower():
        if not m:
            return CopilotReply(answer_type=AnswerType.clarify, text="Which incident should I send? Tell me its id.")
        v = validate_send_to_broker(scope, m.group(1))
        if not v.ok:
            return CopilotReply(answer_type=AnswerType.refuse, text=v.reason)
        return CopilotReply(answer_type=AnswerType.propose_action, text=v.proposed.summary, proposed_action=v.proposed)
    # resolve compliance
    return CopilotReply(answer_type=AnswerType.clarify,
                        text="Tell me which compliance item to resolve and attach the evidence.")


def _execute_confirmed(scope: CopilotScope, action: ProposedAction, attachment) -> CopilotReply:
    if action.kind == "send_to_broker":
        v = validate_send_to_broker(scope, action.target_id)
        if not v.ok:
            return CopilotReply(answer_type=AnswerType.refuse, text=v.reason)
        res = execute_send_to_broker(scope, action.target_id)
        return CopilotReply(answer_type=AnswerType.answer,
                            text="Sent to your broker — it's now awaiting their decision.",
                            citations=res.citations)
    if action.kind == "resolve_compliance":
        res = execute_resolve_compliance(scope, action.target_id, file=attachment)
        if not res.data.get("executed"):
            return CopilotReply(answer_type=AnswerType.refuse, text=res.data.get("reason", "Couldn't resolve that."))
        return CopilotReply(answer_type=AnswerType.answer, text="Evidence uploaded — that compliance item is resolved.",
                            citations=res.citations)
    return CopilotReply(answer_type=AnswerType.refuse, text="I can't take that action.")
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_engine.py -q`
Expected: PASS. (Add the conftest fixtures referenced.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/copilot/engine.py backend/tests/copilot/test_engine.py backend/tests/copilot/conftest.py
git commit -F- <<'EOF'
feat(copilot): engine — intent routing, faithfulness gate, action round-trip

Spec §3,5,6. Read replies are faithfulness-checked; action intents propose
then execute only after a from-scratch server re-validation (stale/no-policy blocked).
EOF
```

---

## Task 8: API route

**Files:**
- Create: `backend/app/api/v1/copilot.py`
- Modify: `backend/app/main.py` (register router, mirroring the intelligence router include)
- Test: `backend/tests/copilot/test_route.py`
- Reference: `app/api/v1/intelligence.py` (auth pattern), `app/auth.require_venue_access`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_route.py
from fastapi.testclient import TestClient
from app.main import app
from app.auth import create_token


def _op():
    return {"Authorization": f"Bearer {create_token('user_op','op@x.com','venue_operator','elsewhere-brooklyn')}"}


def test_message_requires_auth():
    with TestClient(app) as c:
        assert c.post("/api/copilot/message", json={"message": "hi"}).status_code == 401


def test_operator_can_ask():
    with TestClient(app) as c:
        r = c.post("/api/copilot/message", json={"message": "what needs my attention?"}, headers=_op())
        assert r.status_code == 200
        assert r.json()["answer_type"] in ("answer", "refuse", "clarify")
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_route.py -q`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/api/v1/copilot.py
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlmodel import Session

from app.auth import verify_token
from app.copilot.engine import respond_to_message
from app.copilot.schemas import CopilotReply, CopilotTurn
from app.database import get_session

router = APIRouter()


@router.post("/copilot/message", response_model=CopilotReply)
def copilot_message(turn: CopilotTurn, authorization: str = Header(None),
                    session: Session = Depends(get_session)) -> CopilotReply:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    user = verify_token(authorization.split(" ")[1])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if user.get("role") != "venue_operator":
        raise HTTPException(status_code=403, detail="Copilot is an operator surface in v1.")
    return respond_to_message(user, session, turn.message, confirm_action=turn.confirm_action)
```

```python
# backend/app/main.py — beside the intelligence router include
from app.api.v1.copilot import router as copilot_router
app.include_router(copilot_router, prefix="/api", tags=["copilot"])
```

> The compliance-resolve confirm needs a multipart variant (file upload). Add a second route `POST /api/copilot/message/confirm` accepting `multipart/form-data` (`confirm_action` JSON field + `file`) that calls `respond_to_message(..., confirm_action=..., attachment=file)`. Keep the JSON route for read + send-to-broker; the multipart route only for the compliance action. Test both.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_route.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/copilot.py backend/app/main.py backend/tests/copilot/test_route.py
git commit -F- <<'EOF'
feat(copilot): POST /api/copilot/message (operator-gated)

Spec §6. Operator-only; JSON route for read + send-to-broker; multipart
confirm route for the compliance upload action.
EOF
```

---

## Task 9: Eval scorers

**Files:**
- Create: `backend/app/evals/copilot_scorers.py`
- Test: `backend/tests/copilot/test_scorers.py`
- Reference: `app/evals/intelligence_scorers.py`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_scorers.py
from app.copilot.schemas import AnswerType, CopilotReply, ProposedAction
from app.copilot.schemas import ToolResult
from app.schemas.domain import Citation
from app.evals.copilot_scorers import (
    intent_routing_accuracy, faithfulness_score, refusal_correctness, action_appropriateness,
)


def test_intent_routing_accuracy():
    assert intent_routing_accuracy(expected="get_risk_score", actual="get_risk_score") == 1.0
    assert intent_routing_accuracy(expected="get_risk_score", actual="get_exposure") == 0.0


def test_faithfulness_score_uses_guard():
    tr = [ToolResult(tool="get_risk_score", data={"score": 46}, citations=[])]
    assert faithfulness_score(CopilotReply(answer_type=AnswerType.answer, text="risk 46"), tr) == 1.0
    assert faithfulness_score(CopilotReply(answer_type=AnswerType.answer, text="risk 99"), tr) == 0.0


def test_refusal_correctness():
    assert refusal_correctness(should_refuse=True, reply=CopilotReply(answer_type=AnswerType.refuse, text="x")) == 1.0
    assert refusal_correctness(should_refuse=True, reply=CopilotReply(answer_type=AnswerType.answer, text="x")) == 0.0


def test_action_appropriateness():
    pa = ProposedAction(kind="send_to_broker", target_id="inc-1", summary="x", gating_passed=True)
    proposed = CopilotReply(answer_type=AnswerType.propose_action, text="x", proposed_action=pa)
    assert action_appropriateness(should_propose=True, reply=proposed) == 1.0
    assert action_appropriateness(should_propose=False, reply=proposed) == 0.0
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_scorers.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/evals/copilot_scorers.py
from __future__ import annotations

from app.copilot.faithfulness import assert_grounded
from app.copilot.schemas import AnswerType, CopilotReply, ToolResult


def intent_routing_accuracy(*, expected: str, actual: str | None) -> float:
    return 1.0 if actual == expected else 0.0


def faithfulness_score(reply: CopilotReply, tool_results: list[ToolResult]) -> float:
    return 1.0 if assert_grounded(reply.text, tool_results).ok else 0.0


def refusal_correctness(*, should_refuse: bool, reply: CopilotReply) -> float:
    refused = reply.answer_type == AnswerType.refuse
    return 1.0 if refused == should_refuse else 0.0


def action_appropriateness(*, should_propose: bool, reply: CopilotReply) -> float:
    proposed = reply.answer_type == AnswerType.propose_action and reply.proposed_action is not None
    return 1.0 if proposed == should_propose else 0.0
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_scorers.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/copilot_scorers.py backend/tests/copilot/test_scorers.py
git commit -F- <<'EOF'
feat(copilot/evals): scorers (intent/faithfulness/refusal/action)

Spec §8. faithfulness_score reuses the serve-path guard (one definition).
EOF
```

---

## Task 10: Gold scenarios

**Files:**
- Create: `backend/app/evals/copilot_scenarios.py`
- Test: `backend/tests/copilot/test_scenarios_smoke.py`
- Reference: `app/evals/intelligence_scenarios.py` (DB-fixture factory shape + `NOW`).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_scenarios_smoke.py
from app.evals.copilot_scenarios import SCENARIOS


def test_scenarios_cover_every_axis():
    kinds = {s()["axis"] for s in SCENARIOS}
    assert {"read", "refuse", "action_ok", "action_blocked"} <= kinds
    assert len(SCENARIOS) >= 8
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_scenarios_smoke.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Build ≥8 scenario factories. Each returns a dict: `{name, axis, user, session, message, expected_tool?, should_refuse, should_propose, confirm_action?}`. Seed DB fixtures with the in-memory engine pattern from `intelligence_scenarios.py`. Cover: each read intent (risk/exposure/claims/incidents), an off-topic refusal, a `send_to_broker` on a borderline+insured incident (`action_ok`), a `send_to_broker` on a no-policy incident (`action_blocked`), and a `resolve_compliance` propose. Use a fixed `NOW` for determinism.

```python
# backend/app/evals/copilot_scenarios.py — shape (fill in seeds per axis)
from datetime import datetime, timezone
NOW = datetime(2026, 6, 8, tzinfo=timezone.utc)

def _risk_question():
    user, session = _seed_operator_with_score(tier="C", score=46)  # local seed helper
    return {"name": "risk-why", "axis": "read", "user": user, "session": session,
            "message": "why is my risk a C?", "expected_tool": "get_risk_score",
            "should_refuse": False, "should_propose": False}

# ... _exposure_question, _claims_question, _incidents_question (axis="read")
# ... _off_topic (axis="refuse", should_refuse=True)
# ... _send_ok (axis="action_ok", should_propose=True), _send_no_policy (axis="action_blocked", should_refuse=True)
# ... _resolve_compliance_propose (axis="action_ok", should_propose=True)

SCENARIOS = [_risk_question, _exposure_question, _claims_question, _incidents_question,
             _off_topic, _send_ok, _send_no_policy, _resolve_compliance_propose]
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_scenarios_smoke.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/copilot_scenarios.py backend/tests/copilot/test_scenarios_smoke.py
git commit -F- <<'EOF'
feat(copilot/evals): gold scenarios across read/refuse/action axes

Spec §8. DB-fixture factories with a fixed NOW; >=8 scenarios covering
all four read intents, refusal, and both action gating outcomes.
EOF
```

---

## Task 11: Runner + baseline + wire into the gate

**Files:**
- Create: `backend/app/evals/copilot_runner.py`, `backend/app/evals/copilot_baseline.json` (written by `--update-baseline`)
- Modify: the aggregate gate consumer so CI runs copilot too (mirror how `intelligence_runner` is invoked in `ci.yml`); `frontend/public/eval-baseline.json` / the `/evals` page data source to include the copilot block.
- Test: `backend/tests/copilot/test_runner.py`
- Reference: `app/evals/intelligence_runner.py` (verbatim structure: `run_scenarios` → `build_snapshot` → `main` with `--compare-baseline`/`--update-baseline`).

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/copilot/test_runner.py
from app.evals.copilot_runner import run_scenarios, build_snapshot


def test_runner_scores_every_scenario_and_builds_snapshot():
    results = run_scenarios()
    assert len(results) >= 8
    snap = build_snapshot(results)
    assert "aggregate" in snap and 0.0 <= snap["aggregate"]["pass_rate"] <= 1.0
    assert {s["name"] for s in snap["scorer_averages"]} == {
        "intent_routing_accuracy", "faithfulness", "refusal_correctness", "action_appropriateness"}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && python -m pytest tests/copilot/test_runner.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

Copy `intelligence_runner.py` structure. `run_scenarios()` iterates `SCENARIOS`, calls `respond_to_message(...)` (capturing the routed tool via a thin instrumented bridge for `intent_routing_accuracy`), and scores each with the Task 9 scorers. `STACK_SIGNATURE = "copilot=deterministic-v1"`, `BASELINE_PATH = .../copilot_baseline.json`. `main()` supports `--compare-baseline` (exit 1 on regression) and `--update-baseline`. Then run `python -m app.evals.copilot_runner --update-baseline` to write the committed baseline.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && python -m pytest tests/copilot/test_runner.py -q && python -m app.evals.copilot_runner --update-baseline && python -m app.evals.copilot_runner --compare-baseline`
Expected: tests PASS; runner prints pass rates; `--compare-baseline` exits 0.

- [ ] **Step 5: Add the CI gate line + /evals block, then commit**

Add the copilot runner to the `evals` job in `.github/workflows/ci.yml` (mirror the `intelligence_runner --compare-baseline` invocation). Extend the `/evals` scoreboard data to render the `copilot=deterministic-v1` block.

```bash
git add backend/app/evals/copilot_runner.py backend/app/evals/copilot_baseline.json backend/tests/copilot/test_runner.py .github/workflows/ci.yml frontend/src/app/evals/page.tsx frontend/public/eval-baseline.json
git commit -F- <<'EOF'
feat(copilot/evals): runner + baseline gate + /evals block

Spec §8. Wired into --compare-baseline (CI exits 1 on drop) and the public
eval scoreboard. Runs the deterministic provider — reproducible, keyless.
EOF
```

---

## Task 12: Frontend typed client

**Files:**
- Create: `frontend/src/lib/copilot.ts`, `frontend/src/lib/copilot.test.ts`
- Reference: `frontend/src/lib/intelligence.ts` (fetch + `authHeaders()` pattern, `Citation` type).

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/lib/copilot.test.ts
import { describe, it, expect, vi } from "vitest";
import { sendCopilotMessage } from "./copilot";

describe("sendCopilotMessage", () => {
  it("posts to /api/copilot/message and returns the reply", async () => {
    const reply = { answer_type: "answer", text: "ok", citations: [], followups: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => reply }));
    const r = await sendCopilotMessage({ message: "hi" });
    expect(r.text).toBe("ok");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/lib/copilot.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// frontend/src/lib/copilot.ts
import { authHeaders } from "@/lib/authFetch";
import type { Citation } from "@/lib/intelligence";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

export type AnswerType = "answer" | "clarify" | "refuse" | "propose_action";
export interface ProposedAction { kind: string; target_id: string; summary: string; gating_passed: boolean; requires_attachment?: boolean; }
export interface CopilotReply { answer_type: AnswerType; text: string; citations: Citation[]; proposed_action?: ProposedAction | null; followups: string[]; }
export interface CopilotTurn { message: string; confirm_action?: ProposedAction; }

export async function sendCopilotMessage(turn: CopilotTurn): Promise<CopilotReply> {
  const res = await fetch(`${API_URL}/api/copilot/message`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(turn),
  });
  if (!res.ok) throw new Error(`copilot failed: ${res.status}`);
  return (await res.json()) as CopilotReply;
}

export async function confirmCompliance(action: ProposedAction, file: File): Promise<CopilotReply> {
  const fd = new FormData();
  fd.append("confirm_action", JSON.stringify(action));
  fd.append("file", file);
  const res = await fetch(`${API_URL}/api/copilot/message/confirm`, { method: "POST", headers: authHeaders(), body: fd });
  if (!res.ok) throw new Error(`copilot confirm failed: ${res.status}`);
  return (await res.json()) as CopilotReply;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run src/lib/copilot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/copilot.ts frontend/src/lib/copilot.test.ts
git commit -F- <<'EOF'
feat(copilot/web): typed client (message + multipart confirm)
EOF
```

---

## Task 13: CopilotPanel + /copilot page

**Files:**
- Create: `frontend/src/components/copilot/CopilotPanel.tsx`, `frontend/src/app/copilot/page.tsx`, `frontend/src/app/copilot/layout.tsx`
- Reference: `frontend/src/components/intelligence/ExposurePanel.tsx` (citations, house styles), `frontend/src/app/dashboard/layout.tsx` (per-page AppShell layout convention — see memory `project_appshell_per_page_layout`).

- [ ] **Step 1: Write the component (state + render)**

`CopilotPanel.tsx`: a client component holding `messages: {role, reply?|text}[]`, an input, send handler calling `sendCopilotMessage`. Render: message list; for an assistant reply, render `text` + citation chips (each a `Link` to the cited entity via a `kind→href` map) + `followups` as quick-ask buttons; when `answer_type === "propose_action"`, render **Confirm / Dismiss** (Confirm re-POSTs with `confirm_action`; if `proposed_action.requires_attachment`, show a file input and call `confirmCompliance`). House styles (`lc-card`, tokens). Accessibility: input labelled, buttons ≥44px, `aria-live="polite"` on the latest reply.

`/copilot/layout.tsx`: re-export/compose the same AppShell layout the dashboard uses (so the page isn't bare — per the per-page-layout gotcha).

`/copilot/page.tsx`: operator-gate (redirect non-operators to `/dashboard`, mirroring `claim-status/page.tsx:88`), render `<CopilotPanel />`.

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Design-lint**

Run: `node scripts/design-lint.mjs`
Expected: 0 errors / 0 warnings (use tokens; no raw hex; lime only as `--accent-ink` for text).

- [ ] **Step 4: Manual render check**

Launch the app; sign in as the operator demo user; open `/copilot`; ask "what needs my attention?" and confirm a grounded reply + working citation chips; trigger the send-to-broker propose→confirm.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/copilot/CopilotPanel.tsx frontend/src/app/copilot/page.tsx frontend/src/app/copilot/layout.tsx
git commit -F- <<'EOF'
feat(copilot/web): /copilot page + chat panel

Spec §7. Grounded replies with click-through citations; confirm/dismiss for
proposed actions; file-attach for the compliance action. Operator-gated, web-only.
EOF
```

---

## Task 14: Nav entry + dashboard launcher

**Files:**
- Modify: `frontend/src/components/layout/AppShell.tsx` (operator nav group — add "Copilot"), `frontend/src/app/dashboard/page.tsx` (a launcher link near the ExposurePanel).
- Reference: existing operator nav items (Venue/Incidents/Claims/Compliance).

- [ ] **Step 1: Add the nav item + launcher**

Add a "Copilot" operator nav entry (icon from `lucide-react`, e.g. `MessageCircle`/`Sparkles`) routing to `/copilot`, gated to the operator persona exactly like the other operator items. On the dashboard, add a small "Ask the copilot →" link adjacent to the "What needs your attention" panel.

- [ ] **Step 2: Type-check + design-lint + grep e2e**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json && node ../scripts/design-lint.mjs` and `grep -rn "Copilot" frontend/e2e || true` (per the e2e-on-UI-change habit).
Expected: clean; no e2e selectors broken.

- [ ] **Step 3: Manual check**

Operator sees "Copilot" in nav + the dashboard launcher; both route to `/copilot`. Broker/carrier do not see it.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/layout/AppShell.tsx frontend/src/app/dashboard/page.tsx
git commit -F- <<'EOF'
feat(copilot/web): operator nav entry + dashboard launcher
EOF
```

---

## Final verification

- [ ] `cd backend && python -m pytest tests/copilot -q` — all copilot tests green.
- [ ] `cd backend && python -m app.evals.copilot_runner --compare-baseline` — exits 0.
- [ ] `cd backend && python -m pytest -q` — full suite green (no regressions).
- [ ] `cd frontend && npx tsc --noEmit && npx vitest run` — clean.
- [ ] `node scripts/design-lint.mjs` — 0/0.
- [ ] Manual: operator `/copilot` answers a read question (grounded + citations), proposes + confirms send-to-broker, and resolves a compliance item via attachment; off-topic question refuses.

---

## Backlog fast-follows (record after build)

- Wire the real Anthropic Messages-API call inside `AnthropicChatProvider.respond` (key-gated; `<<<META>>>` parse) — the seam exists; this is the LLM upgrade.
- Mobile parity: a React Native copilot screen against the same `/api/copilot/message`.
- Broker + carrier personas: register their findings + act-tools in the catalog (seam unchanged).
- Multi-turn context + streaming when a real need appears.
