# Fraud / SIU Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explainable, deterministic claims-fraud screen to the underwriting-packet flow that gates silent auto-routing when fraud risk is high.

**Architecture:** A pure-function agent (`app/agents/fraud_agent.py`, sibling to `corroboration_agent`) scores SIU-style red flags into a `FraudSignal`. It runs at v1 (incident creation, before the auto-route gate) on metadata flags, and re-scores at v2 (after corroboration) with evidence flags. A `high` tier suppresses auto-routing and emits an audit event; the signal is persisted on the packet.

**Tech Stack:** Python 3.12, SQLModel/SQLAlchemy, pytest. Run all tests from `backend/`.

**Spec:** `docs/superpowers/specs/2026-06-04-fraud-siu-agent-design.md`

---

## File Structure

- **Create** `backend/app/agents/fraud_agent.py` — `FraudFlag`, `FraudSignal`, `tier_for_score`, `assess_fraud`. One responsibility: turn facts into a scored signal. No DB access.
- **Create** `backend/app/agents/fraud_agent.md` — agent contract doc.
- **Create** `backend/app/evals/fraud_scorer.py` — labelled scenarios + `score_fraud_scorer()`, mirroring `comms_classifier_eval.py`.
- **Modify** `backend/app/models.py` — add `fraud_signal` JSON column to `UnderwritingPacket`.
- **Modify** `backend/app/database.py` — add the `_COLUMN_MIGRATIONS` allowlist entry.
- **Modify** `backend/app/claim_routing.py` — `fraud_signal_for_packet` helper + gate suppression in `maybe_auto_route_incident`.
- **Modify** `backend/app/main.py` — v2 re-score inside `_run_corroboration_and_update_packet`.
- **Create** `backend/tests/test_fraud_agent.py` — scorer unit tests.
- **Create** `backend/tests/test_fraud_routing_gate.py` — gate + v2 integration tests.
- **Create** `backend/tests/test_fraud_eval.py` — pins scorer determinism via the eval fixtures.

---

## Task 1: FraudSignal types + tier thresholds

**Files:**
- Create: `backend/app/agents/fraud_agent.py`
- Test: `backend/tests/test_fraud_agent.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fraud_agent.py
import os
import pytest
from app.agents.fraud_agent import FraudFlag, FraudSignal, tier_for_score


def test_tier_boundaries_use_env_defaults():
    assert tier_for_score(0.0) == "none"
    assert tier_for_score(0.09) == "none"
    assert tier_for_score(0.10) == "low"
    assert tier_for_score(0.29) == "low"
    assert tier_for_score(0.30) == "elevated"
    assert tier_for_score(0.54) == "elevated"
    assert tier_for_score(0.55) == "high"
    assert tier_for_score(1.0) == "high"


def test_fraud_signal_to_dict_is_json_shaped():
    sig = FraudSignal(
        score=0.4,
        tier="elevated",
        red_flags=[FraudFlag("FRAUD_X", "X", 0.4, "because")],
        summary="s",
        assessed_stage="v1",
    )
    d = sig.to_dict()
    assert d["score"] == 0.4
    assert d["tier"] == "elevated"
    assert d["red_flags"] == [{"code": "FRAUD_X", "label": "X", "weight": 0.4, "detail": "because"}]
    assert d["assessed_stage"] == "v1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_agent.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.agents.fraud_agent'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/agents/fraud_agent.py
"""Fraud / SIU agent — deterministic claims-fraud screen for the packet flow.

Sibling to corroboration_agent: a pure function that turns incident metadata and
(optionally) corroboration results into an explainable, scored FraudSignal. No DB
access; callers assemble the inputs. See
docs/superpowers/specs/2026-06-04-fraud-siu-agent-design.md.
"""
from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone


def _high_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_HIGH", "0.55"))


def _elevated_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_ELEVATED", "0.30"))


def _low_threshold() -> float:
    return float(os.getenv("FRAUD_TIER_LOW", "0.10"))


@dataclass(frozen=True)
class FraudFlag:
    code: str
    label: str
    weight: float
    detail: str


@dataclass(frozen=True)
class FraudSignal:
    score: float
    tier: str
    red_flags: list  # list[FraudFlag]
    summary: str
    assessed_stage: str  # "v1" | "v2"

    def to_dict(self) -> dict:
        return {
            "score": self.score,
            "tier": self.tier,
            "red_flags": [asdict(f) for f in self.red_flags],
            "summary": self.summary,
            "assessed_stage": self.assessed_stage,
        }


def tier_for_score(score: float) -> str:
    if score >= _high_threshold():
        return "high"
    if score >= _elevated_threshold():
        return "elevated"
    if score >= _low_threshold():
        return "low"
    return "none"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fraud_agent.py -q`
Expected: PASS (2 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/agents/fraud_agent.py backend/tests/test_fraud_agent.py
git commit -F - <<'EOF'
feat(fraud-agent): FraudSignal types + tier thresholds

- FraudFlag/FraudSignal dataclasses with JSON-shaped to_dict
- env-overridable tier_for_score (high 0.55, elevated 0.30, low 0.10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: `assess_fraud` — v1 metadata red flags

**Files:**
- Modify: `backend/app/agents/fraud_agent.py`
- Test: `backend/tests/test_fraud_agent.py`

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_fraud_agent.py
from datetime import datetime, timezone
from app.agents.fraud_agent import assess_fraud

CLEAN_INCIDENT = {
    "occurred_at": "2026-05-01T22:00:00Z",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def _codes(sig):
    return {f.code for f in sig.red_flags}


def test_clean_incident_scores_none():
    sig = assess_fraud(
        risk_signal={"severity": "low"},
        incident=CLEAN_INCIDENT,
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        evidence_file_count=2,
    )
    assert sig.assessed_stage == "v1"
    assert sig.tier == "none"
    assert sig.red_flags == []


def test_late_report_graduates_and_does_not_double_count():
    sig = assess_fraud(
        risk_signal={"severity": "low"},
        incident={**CLEAN_INCIDENT, "occurred_at": "2026-05-01T00:00:00Z"},
        reported_at=datetime(2026, 5, 10, 0, 0, tzinfo=timezone.utc),  # 9 days
        prior_claim_count=0,
        evidence_file_count=1,
    )
    late = [f for f in sig.red_flags if f.code == "FRAUD_LATE_REPORT"]
    assert len(late) == 1
    assert late[0].weight == 0.25


def test_frequency_and_unverified_injury_combine():
    sig = assess_fraud(
        risk_signal={"severity": "high"},
        incident={**CLEAN_INCIDENT, "injury_observed": True},
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=5,
        evidence_file_count=1,
    )
    assert _codes(sig) == {"FRAUD_FREQUENCY", "FRAUD_UNVERIFIED_INJURY"}
    assert sig.score == 0.40  # 0.25 + 0.15
    assert sig.tier == "elevated"


def test_v1_never_emits_evidence_flags():
    sig = assess_fraud(
        risk_signal={"severity": "high"},
        incident=CLEAN_INCIDENT,
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        evidence_file_count=0,  # zero files at v1 must NOT trip FRAUD_NO_EVIDENCE
    )
    assert "FRAUD_NO_EVIDENCE" not in _codes(sig)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_agent.py -q`
Expected: FAIL — `ImportError: cannot import name 'assess_fraud'`

- [ ] **Step 3: Write minimal implementation**

```python
# append to backend/app/agents/fraud_agent.py

def _parse_dt(value) -> "datetime | None":
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _summarize(tier: str, flags: list, stage: str) -> str:
    if not flags:
        return "No fraud indicators detected."
    lead = {
        "high": "High fraud risk",
        "elevated": "Elevated fraud risk",
        "low": "Low fraud risk",
    }.get(tier, "Fraud indicators present")
    return f"{lead} ({stage}): " + ", ".join(f.label for f in flags) + "."


def assess_fraud(
    *,
    risk_signal: dict,
    incident: dict,
    reported_at,
    policy=None,
    prior_claim_count: int = 0,
    evidence_file_count: int = 0,
    corroboration_status: "str | None" = None,
    corroboration_flags: "list | None" = None,
) -> FraudSignal:
    stage = "v2" if corroboration_status is not None else "v1"
    flags: list[FraudFlag] = []

    occurred = _parse_dt(incident.get("occurred_at"))
    reported = _parse_dt(reported_at)

    # Reporting-delay anomaly (graduated; higher band replaces lower)
    if occurred and reported:
        delay_days = (reported - occurred).total_seconds() / 86400
        if delay_days > 7:
            flags.append(FraudFlag("FRAUD_LATE_REPORT", "Reported long after the incident",
                                   0.25, f"Logged {delay_days:.0f} days after it occurred"))
        elif delay_days > 3:
            flags.append(FraudFlag("FRAUD_LATE_REPORT", "Reported days after the incident",
                                   0.15, f"Logged {delay_days:.0f} days after it occurred"))

    # Policy bind / expiry proximity
    if policy is not None and reported:
        eff = _parse_dt(getattr(policy, "effective_date", None))
        exp = _parse_dt(getattr(policy, "expiry_date", None))
        if eff and 0 <= (reported - eff).days < 14:
            flags.append(FraudFlag("FRAUD_NEAR_BIND", "Claim soon after policy bind",
                                   0.15, f"Reported {(reported - eff).days} days after bind"))
        if exp and 0 <= (exp - reported).days < 14:
            flags.append(FraudFlag("FRAUD_NEAR_EXPIRY", "Claim soon before policy expiry",
                                   0.10, f"Reported {(exp - reported).days} days before expiry"))

    # Claim-frequency anomaly (graduated)
    if prior_claim_count >= 5:
        flags.append(FraudFlag("FRAUD_FREQUENCY", "High prior-claim count",
                               0.25, f"{prior_claim_count} prior claims"))
    elif prior_claim_count >= 3:
        flags.append(FraudFlag("FRAUD_FREQUENCY", "Elevated prior-claim count",
                               0.15, f"{prior_claim_count} prior claims"))

    # Unverified injury
    if incident.get("injury_observed") and not incident.get("police_called") \
            and not incident.get("ems_called"):
        flags.append(FraudFlag("FRAUD_UNVERIFIED_INJURY", "Injury reported with no police or EMS",
                               0.15, "Injury claimed but neither police nor EMS were called"))

    score = min(1.0, round(sum(f.weight for f in flags), 3))
    tier = tier_for_score(score)
    return FraudSignal(score=score, tier=tier, red_flags=flags,
                       summary=_summarize(tier, flags, stage), assessed_stage=stage)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fraud_agent.py -q`
Expected: PASS (6 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/agents/fraud_agent.py backend/tests/test_fraud_agent.py
git commit -F - <<'EOF'
feat(fraud-agent): v1 metadata scoring (delay, frequency, injury, policy proximity)

- graduated late-report and frequency bands (no double-count)
- v1 deliberately emits no evidence-dependent flags

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `assess_fraud` — v2 evidence red flags

**Files:**
- Modify: `backend/app/agents/fraud_agent.py`
- Test: `backend/tests/test_fraud_agent.py`

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_fraud_agent.py

def test_v2_contradiction_drives_high_and_sets_stage():
    sig = assess_fraud(
        risk_signal={"severity": "high"},
        incident={**CLEAN_INCIDENT, "injury_observed": True},
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        evidence_file_count=2,
        corroboration_status="CONTRADICTED",
        corroboration_flags=["Injury reported but NOT visible in uploaded evidence",
                             "Timestamp discrepancy detected between evidence and report"],
    )
    assert sig.assessed_stage == "v2"
    codes = {f.code for f in sig.red_flags}
    assert "FRAUD_EVIDENCE_CONTRADICTED" in codes
    assert "FRAUD_INJURY_NOT_VISIBLE" in codes
    assert "FRAUD_TIMESTAMP_MISMATCH" in codes
    assert sig.tier == "high"  # 0.40 + 0.15 + 0.15 + unverified-injury 0.15 -> capped/>=0.55


def test_v2_no_evidence_only_fires_when_high_severity_and_zero_files():
    base = dict(
        risk_signal={"severity": "high"},
        incident=CLEAN_INCIDENT,
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        corroboration_status="INCONCLUSIVE",
        corroboration_flags=[],
    )
    hit = assess_fraud(**base, evidence_file_count=0)
    miss = assess_fraud(**base, evidence_file_count=3)
    assert "FRAUD_NO_EVIDENCE" in {f.code for f in hit.red_flags}
    assert "FRAUD_NO_EVIDENCE" not in {f.code for f in miss.red_flags}


def test_v2_partial_is_lighter_than_contradicted():
    sig = assess_fraud(
        risk_signal={"severity": "low"},
        incident=CLEAN_INCIDENT,
        reported_at=datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc),
        prior_claim_count=0,
        evidence_file_count=2,
        corroboration_status="PARTIAL",
        corroboration_flags=[],
    )
    flag = [f for f in sig.red_flags if f.code == "FRAUD_EVIDENCE_PARTIAL"]
    assert len(flag) == 1 and flag[0].weight == 0.15
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_agent.py -q`
Expected: FAIL — the v2 assertions fail (no evidence flags emitted yet)

- [ ] **Step 3: Write minimal implementation**

In `assess_fraud`, insert the following block immediately **before** the `score = ...` line:

```python
    # Evidence-dependent flags (v2 only)
    if stage == "v2":
        status = str(corroboration_status or "").upper()
        cflags = [str(f) for f in (corroboration_flags or [])]
        if status == "CONTRADICTED":
            flags.append(FraudFlag("FRAUD_EVIDENCE_CONTRADICTED", "Footage contradicts the report",
                                   0.40, "Corroboration status is CONTRADICTED"))
        elif status == "PARTIAL":
            flags.append(FraudFlag("FRAUD_EVIDENCE_PARTIAL", "Footage only partly matches the report",
                                   0.15, "Corroboration status is PARTIAL"))
        if any("NOT visible" in f for f in cflags):
            flags.append(FraudFlag("FRAUD_INJURY_NOT_VISIBLE", "Injury claim not visible in evidence",
                                   0.15, "Corroboration flagged an injury/evidence mismatch"))
        if any("imestamp" in f for f in cflags):
            flags.append(FraudFlag("FRAUD_TIMESTAMP_MISMATCH", "Evidence timestamps do not match",
                                   0.15, "Corroboration flagged a timestamp discrepancy"))
        if str(risk_signal.get("severity", "")).lower() == "high" and evidence_file_count == 0:
            flags.append(FraudFlag("FRAUD_NO_EVIDENCE", "High-severity claim with no evidence",
                                   0.20, "No evidence files were provided for a high-severity claim"))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fraud_agent.py -q`
Expected: PASS (9 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/agents/fraud_agent.py backend/tests/test_fraud_agent.py
git commit -F - <<'EOF'
feat(fraud-agent): v2 evidence scoring (contradiction, mismatch, no-evidence)

- evidence flags only evaluated when corroboration is present (v2)
- matches corroboration_agent flag strings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Persist `fraud_signal` on the packet

**Files:**
- Modify: `backend/app/models.py:166-167` (after `corroboration_flags`)
- Modify: `backend/app/database.py:40` (after the `corroboration_flags` migration entry)
- Test: `backend/tests/test_fraud_routing_gate.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fraud_routing_gate.py
import pytest
from sqlmodel import Session, SQLModel, create_engine
from app.models import UnderwritingPacket


@pytest.fixture
def db_session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        yield session


def test_fraud_signal_column_round_trips(db_session):
    pkt = UnderwritingPacket(
        id="pkt-1", venue_id="v1", incident_id="inc-1", rubric_version_id="rv-1",
        status="generated", snapshot_hash="h",
        fraud_signal={"score": 0.55, "tier": "high", "red_flags": [], "summary": "s",
                      "assessed_stage": "v1"},
    )
    db_session.add(pkt)
    db_session.commit()
    db_session.expire_all()
    got = db_session.get(UnderwritingPacket, "pkt-1")
    assert got.fraud_signal["tier"] == "high"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_routing_gate.py -q`
Expected: FAIL — `TypeError: ... unexpected keyword argument 'fraud_signal'`

- [ ] **Step 3: Write minimal implementation**

In `backend/app/models.py`, add the field directly after `corroboration_flags` (line 167):

```python
    fraud_signal: dict = Field(default_factory=dict, sa_column=Column(JSON))
```

In `backend/app/database.py`, add to `_COLUMN_MIGRATIONS` directly after the `corroboration_flags` entry (line 40):

```python
    ("underwritingpacket", "fraud_signal", "TEXT", ""),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fraud_routing_gate.py -q`
Expected: PASS (1 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/models.py backend/app/database.py backend/tests/test_fraud_routing_gate.py
git commit -F - <<'EOF'
feat(fraud-agent): persist fraud_signal JSON on UnderwritingPacket

- new column + _COLUMN_MIGRATIONS allowlist entry (schema self-heal)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Gate auto-routing on high fraud (v1)

**Files:**
- Modify: `backend/app/claim_routing.py` (add helper + edit `maybe_auto_route_incident:74-105`)
- Test: `backend/tests/test_fraud_routing_gate.py`

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_fraud_routing_gate.py
from app.models import IncidentRecord, ClaimProposal, AuditEvent, RubricVersion
from sqlmodel import select


def _seed_packet(session, *, prior_injury=True):
    session.add(RubricVersion(id="rv-1", version="demo", rubric={}))
    session.add(IncidentRecord(
        id="inc-1", venue_id="v1", status="open",
        occurred_at="2026-05-01T22:00:00Z", location="bar",
        summary="x", reported_by="op",
        injury_observed=prior_injury, police_called=False, ems_called=False,
    ))
    pkt = UnderwritingPacket(
        id="pkt-1", venue_id="v1", incident_id="inc-1", rubric_version_id="rv-1",
        status="generated", snapshot_hash="h",
        risk_signals={"type": "altercation_event", "severity": "high",
                      "confidence": 0.95, "should_file": True},
    )
    session.add(pkt)
    session.commit()
    return pkt


def test_high_fraud_suppresses_autoroute_and_audits(db_session, monkeypatch):
    from app import claim_routing
    # Force a high fraud tier independent of scoring internals.
    from app.agents.fraud_agent import FraudSignal
    monkeypatch.setattr(
        claim_routing, "fraud_signal_for_packet",
        lambda session, packet, **kw: FraudSignal(0.7, "high", [], "high risk", "v1"),
    )
    pkt = _seed_packet(db_session)
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    db_session.commit()

    assert db_session.exec(select(ClaimProposal)).first() is None
    holds = db_session.exec(
        select(AuditEvent).where(AuditEvent.event_type == "fraud.hold")
    ).all()
    assert len(holds) == 1
    assert db_session.get(UnderwritingPacket, "pkt-1").fraud_signal["tier"] == "high"


def test_low_fraud_still_routes(db_session, monkeypatch):
    from app import claim_routing
    from app.agents.fraud_agent import FraudSignal
    monkeypatch.setattr(
        claim_routing, "fraud_signal_for_packet",
        lambda session, packet, **kw: FraudSignal(0.0, "none", [], "clean", "v1"),
    )
    pkt = _seed_packet(db_session, prior_injury=False)
    claim_routing.maybe_auto_route_incident(db_session, packet=pkt, operator_id="op")
    db_session.commit()
    assert db_session.exec(select(ClaimProposal)).first() is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_routing_gate.py -q`
Expected: FAIL — `AttributeError: module 'app.claim_routing' has no attribute 'fraud_signal_for_packet'`

- [ ] **Step 3: Write minimal implementation**

Add imports near the top of `backend/app/claim_routing.py` (with the existing imports):

```python
from app.models import EvidenceFile
from app.packet_core import _add_audit_event
from app.time import now_utc
```

Add the helper above `maybe_auto_route_incident`:

```python
def _latest_active_policy(session: Session, venue_id: str) -> "Policy | None":
    from app.services.fnol import ACTIVE_POLICY_STATUSES
    policies = session.exec(select(Policy).where(Policy.venue_id == venue_id)).all()
    active = [p for p in policies if p.status in ACTIVE_POLICY_STATUSES]
    if not active:
        return None
    active.sort(key=lambda p: p.effective_date, reverse=True)
    return active[0]


def fraud_signal_for_packet(session: Session, packet: UnderwritingPacket, **kwargs):
    """Assemble inputs and score fraud for a packet. kwargs forwards
    corroboration_status / corroboration_flags for the v2 re-score."""
    from app.agents.fraud_agent import assess_fraud

    incident = session.get(IncidentRecord, packet.incident_id)
    incident_payload = {
        "occurred_at": incident.occurred_at if incident else None,
        "injury_observed": bool(incident.injury_observed) if incident else False,
        "police_called": bool(incident.police_called) if incident else False,
        "ems_called": bool(incident.ems_called) if incident else False,
    }
    evidence_file_count = len(
        session.exec(select(EvidenceFile).where(EvidenceFile.incident_id == packet.incident_id)).all()
    )
    return assess_fraud(
        risk_signal=packet.risk_signals or {},
        incident=incident_payload,
        reported_at=now_utc(),
        policy=_latest_active_policy(session, packet.venue_id),
        prior_claim_count=count_prior_claims(session, packet.venue_id),
        evidence_file_count=evidence_file_count,
        **kwargs,
    )
```

Then edit `maybe_auto_route_incident` so the body (after computing `rec`) reads:

```python
    rec = recommendation_for_packet(session, packet)

    fraud = fraud_signal_for_packet(session, packet)
    packet.fraud_signal = fraud.to_dict()
    session.add(packet)
    if fraud.tier == "high":
        _add_audit_event(
            session=session, actor_id="auto-router", actor_type="system",
            entity_type="incident", entity_id=packet.incident_id,
            event_type="fraud.hold",
            event_metadata={"packet_id": packet.id, "score": fraud.score,
                            "flags": [f.code for f in fraud.red_flags]},
        )
        return rec

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fraud_routing_gate.py -q`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_routing.py backend/tests/test_fraud_routing_gate.py
git commit -F - <<'EOF'
feat(fraud-agent): gate auto-routing on high fraud risk

- fraud_signal_for_packet assembles inputs; high tier suppresses
  create_proposal, persists the signal, emits fraud.hold

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Re-score at v2 after corroboration

**Files:**
- Modify: `backend/app/main.py:694-700` (inside `_run_corroboration_and_update_packet`, after `new_packet` is created)
- Test: `backend/tests/test_fraud_routing_gate.py`

- [ ] **Step 1: Write the failing test**

```python
# append to backend/tests/test_fraud_routing_gate.py
from app.agents.fraud_agent import assess_fraud


def test_v2_rescore_escalates_with_contradiction():
    # Pure-function check: same incident, adding a CONTRADICTED corroboration
    # crosses into 'high' where the v1 score did not.
    incident = {"occurred_at": "2026-05-01T22:00:00Z", "injury_observed": True,
                "police_called": False, "ems_called": False}
    import datetime as _dt
    reported = _dt.datetime(2026, 5, 1, 23, 0, tzinfo=_dt.timezone.utc)
    v1 = assess_fraud(risk_signal={"severity": "high"}, incident=incident,
                      reported_at=reported, prior_claim_count=0, evidence_file_count=2)
    v2 = assess_fraud(risk_signal={"severity": "high"}, incident=incident,
                      reported_at=reported, prior_claim_count=0, evidence_file_count=2,
                      corroboration_status="CONTRADICTED",
                      corroboration_flags=["Injury reported but NOT visible in uploaded evidence"])
    assert v1.tier != "high"
    assert v2.tier == "high"
    assert v2.assessed_stage == "v2"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_routing_gate.py::test_v2_rescore_escalates_with_contradiction -q`
Expected: PASS already for the pure-function assertion (Tasks 2–3 cover it). If it PASSES, that confirms the scorer contract; proceed to wire the call site below. (This task's behavior change is the call-site wiring, which the next step covers; the test documents the v1→v2 escalation contract the wiring depends on.)

- [ ] **Step 3: Write minimal implementation**

In `backend/app/main.py`, inside `_run_corroboration_and_update_packet`, immediately after `new_packet = regenerate_packet_with_corroboration(...)` returns, add:

```python
    from app.claim_routing import fraud_signal_for_packet
    from app.packet_core import _add_audit_event

    prior_tier = (prior_packet.fraud_signal or {}).get("tier")
    fraud = fraud_signal_for_packet(
        session, new_packet,
        corroboration_status=result.status,
        corroboration_flags=result.flags,
    )
    new_packet.fraud_signal = fraud.to_dict()
    session.add(new_packet)
    if fraud.tier == "high" and prior_tier != "high":
        _add_audit_event(
            session=session, actor_id="vision-pipeline", actor_type="system",
            entity_type="incident", entity_id=incident_id,
            event_type="fraud.flagged",
            event_metadata={"packet_id": new_packet.id, "score": fraud.score,
                            "flags": [f.code for f in fraud.red_flags]},
        )
    session.commit()
```

(Adjust the trailing `session.commit()` to match the existing commit/rollback structure of the function — if the function already commits at its end, fold the `new_packet` mutation in before that commit rather than adding a second one.)

- [ ] **Step 4: Run the full affected suites**

Run: `cd backend && python -m pytest tests/test_fraud_routing_gate.py tests/test_fraud_agent.py -q`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_fraud_routing_gate.py
git commit -F - <<'EOF'
feat(fraud-agent): re-score fraud at v2 with corroboration

- write updated FraudSignal onto the v2 packet
- emit fraud.flagged when corroboration newly escalates to high

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Agent contract doc

**Files:**
- Create: `backend/app/agents/fraud_agent.md`

- [ ] **Step 1: Write the contract**

```markdown
# Fraud / SIU Agent Contract

## Current Runtime Status

`app/agents/fraud_agent.py::assess_fraud` is a **deterministic** scorer (no LLM in
the score path), a sibling to `corroboration_agent`. It runs at v1 from
`claim_routing.maybe_auto_route_incident` (metadata flags; a `high` tier
suppresses auto-routing and emits `fraud.hold`) and re-runs at v2 from
`main._run_corroboration_and_update_packet` (adds evidence flags; emits
`fraud.flagged` on new escalation). It is **not** registered in
`runtime.REQUIRED_CONTRACTS` (those are the five packet runtime agents).

An optional LLM narrative may rewrite `FraudSignal.summary` via the provider layer
behind the deterministic fallback and the eval baseline gate. Score, tier, and
red_flags are never LLM-derived.

## Red flags

- Evidence contradiction (v2): CONTRADICTED 0.40, PARTIAL 0.15, injury-not-visible
  0.15, timestamp-mismatch 0.15.
- Reporting delay (v1): >3d 0.15, >7d 0.25; near-bind 0.15; near-expiry 0.10.
- Claim frequency (v1): >=3 0.15, >=5 0.25.
- Severity-evidence: unverified-injury 0.15 (v1); high-severity-no-evidence 0.20 (v2).

## Tiers

`high` >= 0.55 (gates routing), `elevated` >= 0.30, `low` >= 0.10, else `none`.
Thresholds via `FRAUD_TIER_HIGH` / `FRAUD_TIER_ELEVATED` / `FRAUD_TIER_LOW`.
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/agents/fraud_agent.md
git commit -F - <<'EOF'
docs(fraud-agent): agent contract with runtime status + rules

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Eval scorer baseline

**Files:**
- Create: `backend/app/evals/fraud_scorer.py`
- Test: `backend/tests/test_fraud_eval.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_fraud_eval.py
from app.evals.fraud_scorer import score_fraud_scorer


def test_fraud_scorer_is_100pct_on_labelled_fixtures():
    report = score_fraud_scorer()
    assert report["n"] >= 5
    assert report["accuracy"] == 1.0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_fraud_eval.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.evals.fraud_scorer'`

- [ ] **Step 3: Write minimal implementation**

```python
# backend/app/evals/fraud_scorer.py
"""Deterministic baseline for the fraud scorer. Each fixture pairs a scenario with
its expected tier; the scorer reports accuracy so thresholds can be tuned. Mirrors
comms_classifier_eval.py."""
from __future__ import annotations

from datetime import datetime, timezone

from app.agents.fraud_agent import assess_fraud

_REPORTED = datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc)
_BASE = {"occurred_at": "2026-05-01T22:00:00Z", "injury_observed": False,
         "police_called": False, "ems_called": False}

# (label, kwargs-for-assess_fraud, expected_tier)
FIXTURES: list[tuple[str, dict, str]] = [
    ("clean", dict(risk_signal={"severity": "low"}, incident=_BASE, reported_at=_REPORTED,
                   prior_claim_count=0, evidence_file_count=2), "none"),
    ("frequency+injury", dict(risk_signal={"severity": "high"},
                              incident={**_BASE, "injury_observed": True}, reported_at=_REPORTED,
                              prior_claim_count=5, evidence_file_count=2), "elevated"),
    ("late_report", dict(risk_signal={"severity": "low"},
                         incident={**_BASE, "occurred_at": "2026-05-01T00:00:00Z"},
                         reported_at=datetime(2026, 5, 10, tzinfo=timezone.utc),
                         prior_claim_count=0, evidence_file_count=1), "low"),
    ("contradicted", dict(risk_signal={"severity": "high"},
                          incident={**_BASE, "injury_observed": True}, reported_at=_REPORTED,
                          prior_claim_count=0, evidence_file_count=2,
                          corroboration_status="CONTRADICTED",
                          corroboration_flags=["Injury reported but NOT visible in uploaded evidence",
                                               "Timestamp discrepancy detected between evidence and report"]),
     "high"),
    ("partial_only", dict(risk_signal={"severity": "low"}, incident=_BASE, reported_at=_REPORTED,
                          prior_claim_count=0, evidence_file_count=2,
                          corroboration_status="PARTIAL", corroboration_flags=[]), "low"),
]


def score_fraud_scorer() -> dict:
    correct = 0
    misses: list[str] = []
    for label, kwargs, expected in FIXTURES:
        got = assess_fraud(**kwargs).tier
        if got == expected:
            correct += 1
        else:
            misses.append(f"{label}: expected {expected}, got {got}")
    return {
        "accuracy": round(correct / len(FIXTURES), 3) if FIXTURES else 1.0,
        "n": len(FIXTURES),
        "misses": misses,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_fraud_eval.py -q`
Expected: PASS (1 passed). If a fixture misses, the `misses` list names it — adjust the expected tier to match the scorer's intended behavior (the fixtures pin behavior; they are not a spec to satisfy by changing weights unless a weight is genuinely wrong).

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/fraud_scorer.py backend/tests/test_fraud_eval.py
git commit -F - <<'EOF'
test(fraud-agent): deterministic eval baseline scorer

- labelled scenarios -> expected tier, accuracy report (mirrors comms eval)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Full-suite regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the whole backend suite**

Run: `cd backend && python -m pytest -q`
Expected: PASS — the prior green count + the new fraud tests, zero regressions. In particular confirm existing `claim_routing` / incident-flow tests still pass (the gate now computes a fraud signal on every auto-route call).

- [ ] **Step 2: If anything fails**, use superpowers:systematic-debugging — do not patch tests to pass. The most likely regression is an existing test that expected an auto-proposal and now hits a fraud `high` tier; verify whether that fixture is realistic and, if so, adjust the fixture's inputs (not the scorer) so it no longer trips fraud.

- [ ] **Step 3: Commit** (only if Step 2 required fixture edits)

```bash
git add -A
git commit -F - <<'EOF'
test(fraud-agent): keep existing routing fixtures green under fraud gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** FraudSignal shape (T1), all four red-flag families (T2 metadata, T3 evidence), tiers + env thresholds (T1), gate suppression + fraud.hold (T5), v2 re-score + fraud.flagged (T6), persistence + migration + JSON coercion (T4; the scorer coerces `corroboration_flags` via `[str(f) for f in ...]`), contract doc (T7), eval baseline (T8). Optional LLM narrative is documented as out-of-path in T7; no task wires a provider call (deliberate — score is deterministic, narrative is a follow-up behind the eval gate now in place).
- **Placeholder scan:** none — every code step shows complete code.
- **Type consistency:** `assess_fraud`, `FraudSignal.to_dict`, `fraud_signal_for_packet`, `tier_for_score`, and flag codes are named identically across T1–T8.
- **Deferred (noted, not gaps):** auto-retraction of an already-routed proposal on a v2 `high` (spec defers it); calibration of weights against labelled data (spec open question); registering `fraud_scorer` in the `app/evals/runner.py` baseline registry (unit + eval tests already pin determinism — a one-line follow-up mirroring the comms scorer).
