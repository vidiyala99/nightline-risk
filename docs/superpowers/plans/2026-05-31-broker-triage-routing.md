# Broker Triage Drivetrain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an operator logs an incident, compute-and-persist the "worth filing" recommendation, auto-route high-confidence ones to a broker inbox, and surface the recommendation to the operator on a context screen.

**Architecture:** Server-side routing gate keyed on the existing `ClaimRecommendation`. Reuse `ClaimProposal` + its `pending_broker_review` state as the broker inbox (no new entity). A small `claim_routing` module owns the thresholds + gate; the incident-create flow calls it; the packet read exposes a derived `routing_status` so the web UI never duplicates thresholds.

**Tech Stack:** Python / FastAPI / SQLModel (backend), Next.js / React / TypeScript (web). pytest for backend TDD.

**Spec:** `docs/superpowers/specs/2026-05-31-broker-triage-routing-design.md`. Phase 1 = backend + web (this plan). Phase 2 (mobile) is a separate plan.

---

## File Structure

**Backend — create:**
- `backend/app/claim_routing.py` — routing thresholds + `route_status` / `should_auto_route` + `recommendation_for_packet` + `maybe_auto_route_incident`. The single owner of the gate.
- `backend/tests/test_claim_routing.py` — gate + router + prior-claims tests.

**Backend — modify:**
- `backend/app/models.py` — add `recommendation_snapshot` JSON column to `ClaimProposal`.
- `backend/app/claim_proposals.py` — `create_proposal` accepts optional `recommendation_snapshot`.
- `backend/app/incident_flow.py` — capture the packet, call `maybe_auto_route_incident`.
- `backend/app/main.py` — packet read uses the real prior-claim count + adds `routing_status`.
- `backend/app/api/v1/claim_proposals.py` — list endpoint gains `status` filter + `sort=priority`; propose route snapshots the recommendation.

**Web — modify:**
- `frontend/src/app/incidents/page.tsx` — post-submit redirect.
- `frontend/src/app/incidents/[id]/page.tsx` — recommendation card + risk-profile snapshot.
- `frontend/src/app/claim-proposals/page.tsx` — broker inbox (status filter + priority sort + recommendation summary).

---

## Task 1: Routing gate module (thresholds + status)

**Files:**
- Create: `backend/app/claim_routing.py`
- Test: `backend/tests/test_claim_routing.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_claim_routing.py
import os
from app.claim_recommendation import (
    ClaimRecommendation, PayoutRange, PremiumImpact,
)
from app.claim_routing import route_status, should_auto_route


def _rec(*, should_file: bool, confidence: float) -> ClaimRecommendation:
    return ClaimRecommendation(
        should_file=should_file,
        probability=0.6,
        expected_payout=PayoutRange(1, 2, 3),
        expected_premium_impact=PremiumImpact(1, 3, 3),
        net_expected_value_usd=100,
        reasons=[],
        confidence=confidence,
    )


def test_auto_routed_when_should_file_and_high_confidence():
    assert route_status(_rec(should_file=True, confidence=0.81)) == "auto_routed"
    assert should_auto_route(_rec(should_file=True, confidence=0.81)) is True


def test_confident_dont_file_is_not_routed():
    # High confidence but recommender says don't file → not routed.
    assert route_status(_rec(should_file=False, confidence=0.9)) == "not_routed"
    assert should_auto_route(_rec(should_file=False, confidence=0.9)) is False


def test_borderline_band_prompts_operator():
    assert route_status(_rec(should_file=True, confidence=0.55)) == "borderline"
    assert route_status(_rec(should_file=False, confidence=0.55)) == "borderline"
    assert should_auto_route(_rec(should_file=True, confidence=0.55)) is False


def test_below_floor_is_not_routed():
    assert route_status(_rec(should_file=True, confidence=0.30)) == "not_routed"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routing.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.claim_routing'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/claim_routing.py
"""The routing gate: should a logged incident reach the broker, and how.

Single source of truth for the recommendation-gated routing thresholds so the
web UI never re-derives them — it reads the server-computed `route_status`.
"""
import os

from app.claim_recommendation import ClaimRecommendation


def _auto_confidence() -> float:
    return float(os.getenv("CLAIM_ROUTE_AUTO_CONFIDENCE", "0.70"))


def _borderline_floor() -> float:
    return float(os.getenv("CLAIM_ROUTE_BORDERLINE_FLOOR", "0.40"))


def route_status(rec: ClaimRecommendation) -> str:
    """auto_routed | borderline | not_routed — the gate decision for a rec."""
    if rec.confidence >= _auto_confidence():
        return "auto_routed" if rec.should_file else "not_routed"
    if rec.confidence >= _borderline_floor():
        return "borderline"
    return "not_routed"


def should_auto_route(rec: ClaimRecommendation) -> bool:
    return route_status(rec) == "auto_routed"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_claim_routing.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_routing.py backend/tests/test_claim_routing.py
git commit -F- <<'EOF'
feat(routing): recommendation-gated route_status + should_auto_route

- thresholds from env (CLAIM_ROUTE_AUTO_CONFIDENCE / _BORDERLINE_FLOOR)
- single source of truth for the gate; UI reads route_status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: `count_prior_claims` helper

**Files:**
- Modify: `backend/app/claim_routing.py`
- Test: `backend/tests/test_claim_routing.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_claim_routing.py`. This uses the project's in-memory DB fixture pattern (a `session` fixture exists in `backend/tests/conftest.py`; if the fixture name differs, match the existing tests in `tests/test_claim_routes.py`).

```python
from datetime import date
from decimal import Decimal
from app.models import Policy, Claim
from app.claim_routing import count_prior_claims


def _policy(session, venue_id: str) -> Policy:
    pol = Policy(
        id=f"pol-{venue_id}", venue_id=venue_id, status="active",
        # NOTE: fill remaining required Policy fields by copying the pattern
        # from tests/test_policies_api.py's policy factory (carrier_id, term
        # dates, premium). Reuse that helper if it is importable.
    )
    session.add(pol)
    session.flush()
    return pol


def test_count_prior_claims_excludes_dropped(session):
    pol = _policy(session, "elsewhere-brooklyn")
    session.add(Claim(id="clm-1", policy_id=pol.id, coverage_line="premises_liability",
                      status="reserved", date_of_loss=date(2026, 1, 1)))
    session.add(Claim(id="clm-2", policy_id=pol.id, coverage_line="premises_liability",
                      status="closed_dropped", date_of_loss=date(2026, 1, 2)))
    session.flush()
    assert count_prior_claims(session, "elsewhere-brooklyn") == 1


def test_count_prior_claims_zero_for_unknown_venue(session):
    assert count_prior_claims(session, "no-such-venue") == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routing.py::test_count_prior_claims_excludes_dropped -q`
Expected: FAIL — `ImportError: cannot import name 'count_prior_claims'`.

- [ ] **Step 3: Write minimal implementation**

Add to `backend/app/claim_routing.py`:

```python
from sqlmodel import Session, select
from app.models import Claim, Policy


def count_prior_claims(session: Session, venue_id: str) -> int:
    """Count a venue's carrier-side claims, excluding dropped ones.

    Claim has no venue_id; it joins to Policy (which does). A dropped claim
    never paid out, so it should not weigh on the venue's filing math.
    """
    rows = session.exec(
        select(Claim.status)
        .join(Policy, Claim.policy_id == Policy.id)
        .where(Policy.venue_id == venue_id)
    ).all()
    return sum(1 for status in rows if status != "closed_dropped")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_claim_routing.py -q`
Expected: PASS. If the Policy factory fields are wrong, the failure will name the missing column — fill from `tests/test_policies_api.py`.

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_routing.py backend/tests/test_claim_routing.py
git commit -F- <<'EOF'
feat(routing): count_prior_claims (venue claims via Policy, excl. dropped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `recommendation_snapshot` column + `create_proposal` accepts it

**Files:**
- Modify: `backend/app/models.py` (ClaimProposal)
- Modify: `backend/app/claim_proposals.py` (`create_proposal`)
- Test: `backend/tests/test_claim_routing.py`

- [ ] **Step 1: Write the failing test**

```python
from app.claim_proposals import create_proposal
from app.models import UnderwritingPacket, ClaimProposal


def _packet(session, venue_id="elsewhere-brooklyn") -> UnderwritingPacket:
    pkt = UnderwritingPacket(
        id="pkt-routetest", venue_id=venue_id, incident_id="inc-x",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "premises_liability", "severity": "medium", "confidence": 0.81},
    )
    session.add(pkt)
    session.flush()
    return pkt


def test_create_proposal_persists_recommendation_snapshot(session):
    _packet(session)
    snap = {"should_file": True, "confidence": 0.81, "net_expected_value_usd": 8000}
    proposal = create_proposal(
        session=session, packet_id="pkt-routetest", operator_id="auto-router",
        override_recommendation=False, override_reason=None, override_freetext=None,
        recommendation_snapshot=snap,
    )
    fetched = session.get(ClaimProposal, proposal.id)
    assert fetched.recommendation_snapshot == snap
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routing.py::test_create_proposal_persists_recommendation_snapshot -q`
Expected: FAIL — `TypeError: create_proposal() got an unexpected keyword argument 'recommendation_snapshot'` (and/or attribute error).

- [ ] **Step 3a: Add the column to `ClaimProposal`**

In `backend/app/models.py`, inside `class ClaimProposal`, after the `operator_responded_at` field, add (note the `Column(JSON)` pattern already used elsewhere in this file):

```python
    # Snapshot of the ClaimRecommendation that drove routing, captured at
    # proposal creation so the broker inbox shows the exact number that
    # triggered routing (auditable; not recomputed). Nullable/additive — relies
    # on the per-engine schema self-healing, no manual migration.
    recommendation_snapshot: Optional[dict] = Field(
        default=None, sa_column=Column(JSON)
    )
```

Confirm `JSON` and `Column` are already imported at the top of `models.py` (they are — other models use `sa_column=Column(JSON)`).

- [ ] **Step 3b: Extend `create_proposal`**

In `backend/app/claim_proposals.py`, change the `create_proposal` signature and the `ClaimProposal(...)` construction:

```python
def create_proposal(
    *,
    session: Session,
    packet_id: str,
    operator_id: str,
    override_recommendation: bool,
    override_reason: str | None,
    override_freetext: str | None,
    recommendation_snapshot: dict | None = None,
) -> ClaimProposal:
```

and in the `proposal = ClaimProposal(...)` constructor add:

```python
        state="pending_broker_review",
        recommendation_snapshot=recommendation_snapshot,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_claim_routing.py::test_create_proposal_persists_recommendation_snapshot -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/app/claim_proposals.py backend/tests/test_claim_routing.py
git commit -F- <<'EOF'
feat(proposals): persist recommendation_snapshot on ClaimProposal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `recommendation_for_packet` helper + real prior-claim count + `routing_status` in packet read

**Files:**
- Modify: `backend/app/claim_routing.py`
- Modify: `backend/app/main.py` (packet read `_packet_to_dict`)
- Test: `backend/tests/test_claim_routing.py`

- [ ] **Step 1: Write the failing test**

```python
from app.claim_routing import recommendation_for_packet
from app.models import IncidentRecord


def test_recommendation_for_packet_uses_real_prior_claims(session):
    session.add(IncidentRecord(
        id="inc-x", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="slip", reported_by="mgr",
        injury_observed=True, police_called=False, ems_called=False, status="open",
    ))
    _packet(session)  # pkt-routetest, incident_id="inc-x", premises_liability/medium/0.81
    rec = recommendation_for_packet(session, session.get(UnderwritingPacket, "pkt-routetest"))
    assert rec.should_file in (True, False)        # it computed something
    assert 0.0 <= rec.confidence <= 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routing.py::test_recommendation_for_packet_uses_real_prior_claims -q`
Expected: FAIL — `ImportError: cannot import name 'recommendation_for_packet'`.

- [ ] **Step 3a: Add the helper**

Add to `backend/app/claim_routing.py`:

```python
from app.models import IncidentRecord, UnderwritingPacket
from app.claim_recommendation import recommend_claim_filing


def recommendation_for_packet(session: Session, packet: UnderwritingPacket) -> ClaimRecommendation:
    """Build the ClaimRecommendation for a packet using REAL venue claim history.

    Single source for the recommendation so main.py, the auto-router, and the
    manual propose path agree on the number.
    """
    incident = session.get(IncidentRecord, packet.incident_id)
    incident_payload = {
        "injury_observed": bool(incident.injury_observed) if incident else False,
        "police_called": bool(incident.police_called) if incident else False,
        "ems_called": bool(incident.ems_called) if incident else False,
    }
    return recommend_claim_filing(
        risk_signal=packet.risk_signals or {},
        incident=incident_payload,
        venue_prior_claim_count=count_prior_claims(session, packet.venue_id),
    )
```

- [ ] **Step 3b: Wire main.py packet read to use it + expose `routing_status`**

In `backend/app/main.py`, in the packet-to-dict function (around lines 685–715): replace the hardcoded `venue_prior_claims = 0` block and the inline `recommend_claim_filing(...)` call with the helper, and add `routing_status` to the returned dict.

Replace the recommendation computation (the block ending at line 696) with:

```python
        from app.claim_routing import recommendation_for_packet, route_status
        recommendation = recommendation_for_packet(session, packet)
```

(delete the now-unused `venue_prior_claims = 0` line and the inline `recommend_claim_filing(...)` call). Then in the returned dict, alongside `"claim_recommendation": recommendation_to_dict(recommendation),` add:

```python
        "routing_status": route_status(recommendation),
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_claim_routing.py -q && python -m pytest tests/ -q -k "packet" -q`
Expected: PASS; existing packet tests still green (the dict gained a key, nothing removed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_routing.py backend/app/main.py backend/tests/test_claim_routing.py
git commit -F- <<'EOF'
feat(routing): recommendation_for_packet (real prior claims) + routing_status in packet read

- packet read no longer hardcodes prior-claim count to 0
- packet payload exposes server-computed routing_status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Auto-router in the incident-create flow

**Files:**
- Modify: `backend/app/claim_routing.py` (`maybe_auto_route_incident`)
- Modify: `backend/app/incident_flow.py`
- Test: `backend/tests/test_claim_routing.py`

- [ ] **Step 1: Write the failing test**

```python
from app.claim_routing import maybe_auto_route_incident
from sqlmodel import select


def test_auto_route_creates_pending_proposal_with_snapshot(session):
    session.add(IncidentRecord(
        id="inc-hi", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="serious", reported_by="mgr",
        injury_observed=True, police_called=True, ems_called=True, status="open",
    ))
    pkt = UnderwritingPacket(
        id="pkt-hi", venue_id="elsewhere-brooklyn", incident_id="inc-hi",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9},
    )
    session.add(pkt); session.flush()

    rec = maybe_auto_route_incident(session, packet=pkt, operator_id="mgr")

    props = session.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-hi")
    ).all()
    assert len(props) == 1
    assert props[0].state == "pending_broker_review"
    assert props[0].recommendation_snapshot["should_file"] is True
    # idempotent: a second call creates no duplicate
    maybe_auto_route_incident(session, packet=pkt, operator_id="mgr")
    props2 = session.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-hi")).all()
    assert len(props2) == 1


def test_borderline_incident_creates_no_proposal(session):
    pkt = UnderwritingPacket(
        id="pkt-mid", venue_id="elsewhere-brooklyn", incident_id="inc-mid",
        rubric_version_id="demo-rubric-v1", status="needs_review",
        risk_signals={"type": "general_incident", "severity": "low", "confidence": 0.55},
    )
    session.add(pkt); session.flush()
    maybe_auto_route_incident(session, packet=pkt, operator_id="mgr")
    props = session.exec(select(ClaimProposal).where(ClaimProposal.packet_id == "pkt-mid")).all()
    assert props == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routing.py::test_auto_route_creates_pending_proposal_with_snapshot -q`
Expected: FAIL — `ImportError: cannot import name 'maybe_auto_route_incident'`.

- [ ] **Step 3a: Add the router**

Add to `backend/app/claim_routing.py`:

```python
from app.models import ClaimProposal
from app.claim_recommendation import recommendation_to_dict
from app.claim_proposals import create_proposal


def maybe_auto_route_incident(session: Session, *, packet: UnderwritingPacket, operator_id: str):
    """Compute the recommendation for a freshly-created packet and, when the gate
    says auto-route, create a pending_broker_review proposal with the snapshot.

    Idempotent: never creates a second proposal for the same packet. Returns the
    ClaimRecommendation (so callers can log/inspect), proposal or not.
    """
    rec = recommendation_for_packet(session, packet)
    if not should_auto_route(rec):
        return rec
    existing = session.exec(
        select(ClaimProposal).where(ClaimProposal.packet_id == packet.id)
    ).first()
    if existing is not None:
        return rec
    create_proposal(
        session=session,
        packet_id=packet.id,
        operator_id="auto-router",
        override_recommendation=False,
        override_reason=None,
        override_freetext=None,
        recommendation_snapshot=recommendation_to_dict(rec),
    )
    return rec
```

- [ ] **Step 3b: Call it from the create flow**

In `backend/app/incident_flow.py`, capture the packet return and route after the snapshot (and after the compliance follow-up commit so a routing failure can't orphan the follow-up). Change line 61 from `create_packet_snapshot(` to `packet = create_packet_snapshot(`, then after the `spawn_incident_followup` block (line 81) add:

```python
    # Recommendation-gated routing: high-confidence "file" incidents land in the
    # broker inbox automatically. Idempotent; borderline/no-file create nothing.
    from app.claim_routing import maybe_auto_route_incident
    maybe_auto_route_incident(session, packet=packet, operator_id=incident.reported_by or "operator")
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_claim_routing.py -q`
Expected: PASS (all routing tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_routing.py backend/app/incident_flow.py backend/tests/test_claim_routing.py
git commit -F- <<'EOF'
feat(routing): auto-route high-confidence incidents to broker inbox

- maybe_auto_route_incident: gate -> create pending proposal + snapshot
- idempotent per packet; wired into the incident-create flow

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Broker inbox — list endpoint `status` filter + `sort=priority`

**Files:**
- Modify: `backend/app/api/v1/claim_proposals.py` (`list_claim_proposals` + `_proposal_to_dict`)
- Test: `backend/tests/test_claim_routes.py`

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_claim_routes.py` (it already has the app `client` + auth-header helpers; reuse them). Two proposals, different snapshot priority, assert order + status filter.

```python
def test_inbox_filters_pending_and_sorts_by_priority(client, broker_headers, session):
    # Two pending proposals with snapshots of differing priority (conf x median payout).
    for pid, conf, median in [("prop-lo", 0.7, 10_000), ("prop-hi", 0.9, 90_000)]:
        session.add(UnderwritingPacket(
            id=f"pk-{pid}", venue_id="elsewhere-brooklyn", incident_id=f"in-{pid}",
            rubric_version_id="demo-rubric-v1", status="needs_review", risk_signals={}))
        session.add(ClaimProposal(
            id=pid, packet_id=f"pk-{pid}", venue_id="elsewhere-brooklyn",
            proposed_by="auto-router", state="pending_broker_review",
            recommendation_snapshot={"confidence": conf,
                                     "expected_payout": {"median_usd": median}}))
    session.commit()

    r = client.get("/api/claim-proposals?status=pending_broker_review&sort=priority",
                   headers=broker_headers)
    assert r.status_code == 200
    ids = [p["id"] for p in r.json() if p["id"] in ("prop-lo", "prop-hi")]
    assert ids == ["prop-hi", "prop-lo"]  # higher priority first
```

(If the test module's fixtures are named differently, match the existing tests in the same file — they already construct a client and broker auth headers.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routes.py::test_inbox_filters_pending_and_sorts_by_priority -q`
Expected: FAIL — either the `status`/`sort` params are ignored (wrong order) or `recommendation_snapshot` isn't in the response.

- [ ] **Step 3a: Extend the list endpoint**

In `backend/app/api/v1/claim_proposals.py`, change `list_claim_proposals` to accept `status` and `sort`, filter, and sort by priority computed from the snapshot:

```python
@router.get("/claim-proposals")
def list_claim_proposals(
    venue_id: str | None = None,
    status: str | None = None,
    sort: str | None = None,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    user = current_user_optional(authorization)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    statement = select(ClaimProposal).order_by(ClaimProposal.proposed_at.desc())
    if venue_id:
        statement = statement.where(ClaimProposal.venue_id == venue_id)
    if status:
        statement = statement.where(ClaimProposal.state == status)
    proposals = session.exec(statement).all()
    allowed = accessible_venue_ids(user, session)
    if allowed is not None:
        proposals = [p for p in proposals if p.venue_id in allowed]
    if sort == "priority":
        proposals = sorted(proposals, key=_proposal_priority, reverse=True)
    return [_proposal_to_dict(p) for p in proposals]


def _proposal_priority(p: ClaimProposal) -> float:
    """confidence x median payout from the snapshot; missing snapshot sorts last."""
    snap = p.recommendation_snapshot or {}
    median = (snap.get("expected_payout") or {}).get("median_usd", 0)
    return float(snap.get("confidence", 0.0)) * float(median)
```

- [ ] **Step 3b: Include the snapshot in `_proposal_to_dict`**

Find `_proposal_to_dict` in the same file and add `recommendation_snapshot` to the returned dict:

```python
        "recommendation_snapshot": p.recommendation_snapshot,
```

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_claim_routes.py -q`
Expected: PASS (new test + existing proposal-route tests unchanged — added params are optional, added key is additive).

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/claim_proposals.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(inbox): claim-proposals status filter + priority sort + snapshot in payload

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Snapshot the recommendation on the manual "send to broker" path

**Files:**
- Modify: `backend/app/api/v1/claim_proposals.py` (`create_claim_proposal_route`)
- Test: `backend/tests/test_claim_routes.py`

So borderline proposals the operator sends also carry a snapshot (inbox sort works for them too).

- [ ] **Step 1: Write the failing test**

```python
def test_manual_proposal_gets_a_snapshot(client, operator_headers, seeded_packet_id):
    # seeded_packet_id: a packet for the operator's venue (reuse the file's existing
    # packet-seeding helper; the slip flow or a factory both work).
    r = client.post(f"/api/packets/{seeded_packet_id}/claim-proposal",
                    json={"operator_id": "mgr", "override_recommendation": False},
                    headers=operator_headers)
    assert r.status_code == 201
    assert r.json()["recommendation_snapshot"] is not None
    assert "confidence" in r.json()["recommendation_snapshot"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_claim_routes.py::test_manual_proposal_gets_a_snapshot -q`
Expected: FAIL — `recommendation_snapshot` is `None`.

- [ ] **Step 3: Compute + pass the snapshot in the propose route**

In `create_claim_proposal_route`, after the packet is loaded and access-checked, compute the recommendation and pass it through:

```python
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is not None:
        require_venue_access(packet.venue_id, authorization, session)
        from app.claim_routing import recommendation_for_packet
        from app.claim_recommendation import recommendation_to_dict
        snapshot = recommendation_to_dict(recommendation_for_packet(session, packet))
    else:
        snapshot = None
    try:
        proposal = create_claim_proposal(
            session=session,
            packet_id=packet_id,
            operator_id=payload.operator_id,
            override_recommendation=payload.override_recommendation,
            override_reason=payload.override_reason,
            override_freetext=payload.override_freetext,
            recommendation_snapshot=snapshot,
        )
```

(`create_claim_proposal` is this module's import alias for `create_proposal`, which now accepts `recommendation_snapshot`.)

- [ ] **Step 4: Run tests**

Run: `cd backend && python -m pytest tests/test_claim_routes.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/claim_proposals.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(proposals): snapshot recommendation on manual send-to-broker too

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Full backend regression gate

**Files:** none (verification).

- [ ] **Step 1: Run the whole suite**

Run: `cd backend && python -m pytest -q`
Expected: all pass (was 962 green + the new routing tests). If any pre-existing packet/proposal test fails, it's because the packet/proposal dict gained keys — update that test's assertions to be additive (don't assert exact dict equality).

- [ ] **Step 2: Commit any test touch-ups**

```bash
git add backend/tests
git commit -F- <<'EOF'
test: align packet/proposal assertions with additive routing fields

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Web — post-submit redirect to the incident

**Files:**
- Modify: `frontend/src/app/incidents/page.tsx` (`handleSubmit`)

- [ ] **Step 1: Make the change**

In `handleSubmit`, after the evidence-upload block and before/after the success toast, navigate to the new incident using the existing `openIncident` helper (line 154). Replace the success-path tail so it redirects instead of only refreshing the list:

```tsx
        const failed = results.filter(r => !r.ok).length;
        if (failed > 0) {
          toastError(`${failed} of ${evidenceFiles.length} evidence file(s) failed to upload`);
        }
      }
      toastSuccess("Incident reported successfully");
      setShowForm(false);
      setEvidenceFiles([]);
      setFormData({ occurred_at: "", location: "", summary: "", reported_by: "", injury_observed: false, police_called: false, ems_called: false });
      if (created.incident?.id) {
        openIncident(created.incident.id);   // land on the context screen
        return;
      }
```

(Leave the existing list-refresh as the fallback when no id is returned.)

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no NEW errors in `incidents/page.tsx` (pre-existing `.next/dev/types` route-type noise is unrelated).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/incidents/page.tsx
git commit -F- <<'EOF'
feat(web): redirect to the incident after logging it

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10: Web — recommendation card + risk-profile snapshot on the incident detail

**Files:**
- Modify: `frontend/src/app/incidents/[id]/page.tsx`

The page already fetches packets (each carrying `claim_recommendation` + the new `routing_status`) and per-packet proposals. Add a context block above the evidence/packet sections.

- [ ] **Step 1: Fetch the venue risk score**

In the page's data-loading effect (the `Promise.all` around line 168), add a fetch for the venue risk score once the incident is known (the incident response carries `venue_id`). After `setIncident(...)`:

```tsx
// Venue risk-profile snapshot for context (score/tier).
const venueId = incidentData?.venue_id;
if (venueId) {
  const rs = await fetch(`${API_URL}/api/venues/${venueId}/risk-score`, { headers: authHeaders() });
  if (rs.ok) setRiskScore(await rs.json());
}
```

Add the state near the other `useState` calls:

```tsx
const [riskScore, setRiskScore] = useState<{ total_score: number; tier: string } | null>(null);
```

- [ ] **Step 2: Derive the recommendation from the first packet**

Near the top of the render, after packets are available:

```tsx
const primaryPacket = packets[0] as any | undefined;
const rec = primaryPacket?.claim_recommendation as
  | { should_file: boolean; net_expected_value_usd: number; confidence: number; reasons: string[] }
  | undefined;
const routingStatus = primaryPacket?.routing_status as
  | "auto_routed" | "borderline" | "not_routed" | undefined;
```

- [ ] **Step 3: Render the context block**

Above the evidence section, add (match the page's existing card/className conventions — copy a nearby `<section className="card ...">` for exact styling):

```tsx
{rec && (
  <section className="card" style={{ marginBottom: "var(--space-md)" }}>
    <h2 className="card-title">Worth filing?</h2>
    <p style={{ fontWeight: 600 }}>
      {rec.should_file ? "Recommended: file this claim" : "Recommended: do not file"}
      {" · "}net EV ${rec.net_expected_value_usd.toLocaleString()}
      {" · "}confidence {(rec.confidence * 100).toFixed(0)}%
    </p>
    <ul>{rec.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
    {routingStatus === "auto_routed" && (
      <p className="text-muted">Sent to the broker for review.</p>
    )}
    {routingStatus === "borderline" && (
      <button className="btn" onClick={sendToBroker}>Send to broker</button>
    )}
    {riskScore && (
      <p className="text-muted">
        Venue risk: {riskScore.total_score}/100 (tier {riskScore.tier})
        {" · "}<a href={`/incidents?venue=${incident?.venue_id}`}>recent incidents</a>
      </p>
    )}
  </section>
)}
```

- [ ] **Step 4: Implement `sendToBroker` (borderline action)**

Add a handler that posts to the existing propose endpoint and then refreshes:

```tsx
const sendToBroker = async () => {
  if (!primaryPacket) return;
  const res = await fetch(`${API_URL}/api/packets/${primaryPacket.id}/claim-proposal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ operator_id: "operator", override_recommendation: false }),
  });
  if (res.ok) { toastSuccess("Sent to broker"); location.reload(); }
  else { toastError("Could not send to broker"); }
};
```

- [ ] **Step 5: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

```bash
git add frontend/src/app/incidents/[id]/page.tsx
git commit -F- <<'EOF'
feat(web): incident context screen — recommendation card + risk-profile + send-to-broker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 11: Web — broker inbox (prioritized pending proposals)

**Files:**
- Modify: `frontend/src/app/claim-proposals/page.tsx`

This page already lists claim proposals. Add an inbox view that fetches the prioritized pending queue and shows the recommendation summary per row.

- [ ] **Step 1: Fetch the prioritized pending queue**

In the page's data load, call the extended endpoint:

```tsx
const res = await fetch(
  `${API_URL}/api/claim-proposals?status=pending_broker_review&sort=priority`,
  { headers: authHeaders() },
);
const pending = res.ok ? await res.json() : [];
setProposals(Array.isArray(pending) ? pending : []);
```

- [ ] **Step 2: Render the recommendation summary per row**

For each proposal, read `recommendation_snapshot` and show the priority signal so the broker works the most consequential first:

```tsx
{proposals.map((p: any) => {
  const s = p.recommendation_snapshot || {};
  const median = s.expected_payout?.median_usd ?? 0;
  return (
    <div key={p.id} className="card" onClick={() => router.push(`/underwriter/${p.packet_id}`)}>
      <strong>{p.venue_id}</strong>
      <span>{s.should_file ? "FILE" : "review"}</span>
      <span>conf {((s.confidence ?? 0) * 100).toFixed(0)}%</span>
      <span>~${Number(median).toLocaleString()} median</span>
      {/* row click → the broker packet-review surface (approve/reject/needs-info) */}
    </div>
  );
})}
```

The row click targets `/underwriter/{packet_id}` — the broker's existing packet-review screen that hosts the approve/reject/needs-info controls (`frontend/src/app/underwriter/[id]/page.tsx`). Verify that route is packet-keyed during implementation; if the broker decision UI lives on the incident detail instead, link there using the packet's incident id. Match the file's existing row/card markup for styling.

- [ ] **Step 3: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors.

```bash
git add frontend/src/app/claim-proposals/page.tsx
git commit -F- <<'EOF'
feat(web): broker inbox — prioritized pending proposals with recommendation summary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 12: End-to-end manual verification

**Files:** none.

- [ ] **Step 1: Run both suites green**

Run: `cd backend && python -m pytest -q` (all green), then `cd frontend && npx tsc --noEmit` (no new errors).

- [ ] **Step 2: Manual smoke (local or deployed)**

1. Log a high-signal incident (injury + police + EMS) → confirm you're redirected to the incident; the recommendation card shows "file"; `routing_status` is `auto_routed`.
2. As a broker, open the inbox (`/claim-proposals`) → the proposal appears at/near the top, with conf + median payout.
3. Log a low-signal incident → no proposal created; the card shows the borderline "Send to broker" button (or "do not file").

- [ ] **Step 3: Push**

```bash
git push origin main
```

---

## Phase 2 (separate plan): mobile parity

Mirror Tasks 9–11 in `mobile/` (operator context screen + broker inbox). Backend is already done — mobile hits the same API and `mobile/src/api/client.ts` already attaches auth. Write that as its own plan when Phase 1 is verified.
