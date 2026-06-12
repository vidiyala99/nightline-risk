"""Gold scenarios for the intelligence eval. Each scenario seeds an in-memory
DB, runs compute_exposure for a persona, and declares the expected finding ids
and severities. These encode the cross-entity / defensibility questions from
the spec — the questions no dashboard answers."""
from __future__ import annotations

from datetime import datetime, timezone, date, timedelta
from decimal import Decimal

from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.models import (
    IncidentRecord, Policy, CoverageLine, ComplianceSignal, Submission,
    PolicyRequest, Claim, EvidenceAnalysis, SourceRecord,
)
from app.knowledge_sources import INGESTED_ORIGIN

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


def _broker_coverage_exclusion_review():
    """An A&B-heavy venue whose in-force policy *excludes* assault & battery —
    the canonical nightlife E&O gap. Must fire high and cite the clause."""
    s = _fresh_session()
    s.add(Policy(id="pol-ex", submission_id="s1", bound_quote_id="q1", venue_id="v1",
                 carrier_id="c1", status="active",
                 effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
                 annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                 commission_rate=Decimal("0"), coverage_lines=["gl"]))
    s.add(IncidentRecord(id="inc-ab1", venue_id="v1", occurred_at="2026-05-01",
                         location="x", summary="Brawl at the bar", reported_by="s",
                         injury_observed=True, police_called=True, ems_called=False,
                         status="open"))
    s.add(IncidentRecord(id="inc-ab2", venue_id="v1", occurred_at="2026-05-02",
                         location="x", summary="altercation by the door", reported_by="s",
                         injury_observed=False, police_called=False, ems_called=False,
                         status="open"))
    s.add(SourceRecord(id="ingested-ab", venue_id="v1", source_type="policy_exclusion",
                       origin_system=INGESTED_ORIGIN, external_ref="master.md",
                       excerpt="Claims arising from assault and battery are excluded.",
                       content_hash="ingested-ab",
                       source_metadata={"node_id": "node-ab", "doc_id": "policy-abc",
                                        "clause_id": "9.1", "path": "Exclusions > 9.1"}))
    s.commit()
    return {
        "name": "broker_coverage_exclusion_review",
        "user": {"sub": "b1", "role": "broker", "tenant_id": None},
        "session": s,
        "expected_ids": {"coverage_exclusion_review:policy:pol-ex"},
        "expected_severity": {"coverage_exclusion_review:policy:pol-ex": "high"},
    }


def _operator_compliance_overdue():
    s = _fresh_session()
    s.add(ComplianceSignal(id="cmp-1", venue_id="v1", title="Fire exit blocked",
                           description="d", provenance="underwriter_verified",
                           severity="medium", status="open",
                           created_at=NOW - timedelta(days=40)))
    s.commit()
    return {
        "name": "operator_compliance_overdue",
        "user": {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"},
        "session": s,
        "expected_ids": {"compliance_overdue:compliance:cmp-1"},
        "expected_severity": {"compliance_overdue:compliance:cmp-1": "high"},
    }


def _operator_renewal_approaching():
    s = _fresh_session()
    s.add(Policy(id="pol-ra", submission_id="s1", bound_quote_id="q1", venue_id="v1",
                 carrier_id="c1", status="active",
                 effective_date=date(2025, 6, 20), expiration_date=date(2026, 6, 20),
                 annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                 commission_rate=Decimal("0")))
    s.commit()
    return {
        "name": "operator_renewal_approaching",
        "user": {"sub": "u1", "role": "venue_operator", "tenant_id": "v1"},
        "session": s,
        "expected_ids": {"renewal_approaching:policy:pol-ra"},
        "expected_severity": {"renewal_approaching:policy:pol-ra": "high"},
    }


def _broker_renewal_at_risk():
    s = _fresh_session()
    s.add(Policy(id="pol-rar", submission_id="s2", bound_quote_id="q2", venue_id="v1",
                 carrier_id="c1", status="active",
                 effective_date=date(2025, 7, 1), expiration_date=date(2026, 7, 1),
                 annual_premium=Decimal("0"), commission_amount=Decimal("0"),
                 commission_rate=Decimal("0")))
    s.commit()
    return {
        "name": "broker_renewal_at_risk",
        "user": {"sub": "b1", "role": "broker", "tenant_id": None},
        "session": s,
        "expected_ids": {"renewal_at_risk:policy:pol-rar"},
        "expected_severity": {"renewal_at_risk:policy:pol-rar": "high"},
    }


def _broker_submission_stalled():
    s = _fresh_session()
    s.add(Submission(id="sub-ss", venue_id="v1", status="in_market",
                     effective_date=date(2026, 7, 1),
                     updated_at=NOW - timedelta(days=20)))
    s.commit()
    return {
        "name": "broker_submission_stalled",
        "user": {"sub": "b1", "role": "broker", "tenant_id": None},
        "session": s,
        "expected_ids": {"submission_stalled:submission:sub-ss"},
        "expected_severity": {"submission_stalled:submission:sub-ss": "medium"},
    }


def _carrier_reserve_light():
    s = _fresh_session()
    s.add(Claim(id="clm-rl", policy_id="pol-1", coverage_line="gl", status="open",
                date_of_loss=date(2026, 5, 1), current_reserve=Decimal("1000"),
                indemnity_paid_to_date=Decimal("900"),
                expense_paid_to_date=Decimal("300")))
    s.commit()
    return {
        "name": "carrier_reserve_light",
        "user": {"sub": "uw1", "role": "carrier", "tenant_id": None},
        "session": s,
        "expected_ids": {"reserve_light:claim:clm-rl"},
        "expected_severity": {"reserve_light:claim:clm-rl": "high"},
    }


def _carrier_fraud_unreviewed():
    s = _fresh_session()
    s.add(EvidenceAnalysis(id="ea-fr", evidence_id="ev-1", incident_id="inc-fr",
                           analysis_type="video", corroboration="CONTRADICTED",
                           status="complete"))
    s.commit()
    return {
        "name": "carrier_fraud_unreviewed",
        "user": {"sub": "uw1", "role": "carrier", "tenant_id": None},
        "session": s,
        "expected_ids": {"fraud_unreviewed:incident:inc-fr"},
        "expected_severity": {"fraud_unreviewed:incident:inc-fr": "high"},
    }


SCENARIOS = [
    _operator_evidence_gap,
    _operator_clean_no_false_alarm,
    _broker_coverage_gap,
    _broker_coverage_exclusion_review,
    _operator_compliance_overdue,
    _operator_renewal_approaching,
    _broker_renewal_at_risk,
    _broker_submission_stalled,
    _carrier_reserve_light,
    _carrier_fraud_unreviewed,
]
