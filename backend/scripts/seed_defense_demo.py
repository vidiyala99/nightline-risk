"""Seed ONE complete defense-package demo so the PDF export is reachable in UI.

Builds the authentic chain — incident (A&B) -> hashed evidence + corroboration
-> UnderwritingPacket (real snapshot hash + citation via create_packet_snapshot)
-> carrier Claim with defense_package_id set (file_fnol) — so the broker Claim
detail shows "Defense package · Download PDF".

Idempotent: deterministic incident id; skips if the demo claim already exists.
Pass --refresh to delete and recreate the demo artifacts (useful after the
loss-date cap changed and the stale prod row needs to be re-seeded).
Run from backend/:
    python -m scripts.seed_defense_demo            # skip if present
    python -m scripts.seed_defense_demo --refresh  # delete + recreate
"""
from __future__ import annotations

import hashlib
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlmodel import Session, select

from app.database import engine
from app.models import (
    AuditEvent,
    CitationRecord,
    Claim,
    EvidenceAnalysis,
    EvidenceFile,
    IncidentRecord,
    Policy,
    SourceRecord,
    UnderwritingPacket,
)
from app.packet_core import create_packet_snapshot
from app.schemas import Citation, IncidentCreate
from app.services.claims import (
    close_claim,
    file_fnol,
    record_carrier_reserve,
    record_payment,
)
from app.time import now_utc

INCIDENT_ID = "inc-defense-demo"
PRIOR_INCIDENT_ID = "inc-defense-demo-prior"
PRIOR_CARRIER_CLAIM_NUMBER = "BW-2026-PRIOR"


def _pick_policy(session: Session) -> Policy | None:
    p = session.get(Policy, "pol-demo-1")
    if p:
        return p
    return (
        session.exec(select(Policy).where(Policy.status == "active")).first()
        or session.exec(select(Policy)).first()
    )


def _delete_demo_artifacts(session: Session) -> None:
    """Delete every row this script creates for INCIDENT_ID, children before
    parents so column-level FKs hold on Postgres. Leaves shared rows
    (RubricVersion) alone. Order:
      Claim → CitationRecord(s) → UnderwritingPacket(s) → SourceRecord(s)
      → AuditEvent(s) → EvidenceAnalysis → EvidenceFile → IncidentRecord
    """
    # 1. Claim references the packet (ON DELETE RESTRICT) — drop it first.
    for claim in session.exec(
        select(Claim).where(Claim.incident_id == INCIDENT_ID)
    ).all():
        session.delete(claim)
    session.flush()

    # 2. Packets for this incident, plus their citation records + source rows
    #    (create_packet_snapshot writes CitationRecord by packet_id and a
    #    SourceRecord per citation source_id).
    packets = session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == INCIDENT_ID)
    ).all()
    for packet in packets:
        citations = session.exec(
            select(CitationRecord).where(CitationRecord.packet_id == packet.id)
        ).all()
        source_ids = {c.source_id for c in citations}
        for citation in citations:
            session.delete(citation)
        session.flush()
        session.delete(packet)
        session.flush()
        for source_id in source_ids:
            source = session.get(SourceRecord, source_id)
            if source is not None:
                session.delete(source)
    session.flush()

    # 3. Audit events emitted by create_packet_snapshot reference the packet ids.
    for packet in packets:
        for event in session.exec(
            select(AuditEvent).where(
                AuditEvent.entity_type == "underwriting_packet",
                AuditEvent.entity_id == packet.id,
            )
        ).all():
            session.delete(event)
    session.flush()

    # 4. Evidence analyses (children of evidence files) then evidence files.
    for analysis in session.exec(
        select(EvidenceAnalysis).where(EvidenceAnalysis.incident_id == INCIDENT_ID)
    ).all():
        session.delete(analysis)
    session.flush()
    for ev in session.exec(
        select(EvidenceFile).where(EvidenceFile.incident_id == INCIDENT_ID)
    ).all():
        session.delete(ev)
    session.flush()

    # 5. The incident itself.
    incident = session.get(IncidentRecord, INCIDENT_ID)
    if incident is not None:
        session.delete(incident)
    session.flush()


def _delete_prior_loss(session: Session) -> None:
    """Delete the seeded prior closed liquor loss and its child rows."""
    from app.models import ClaimPayment, ReserveChange

    for claim in session.exec(
        select(Claim).where(Claim.incident_id == PRIOR_INCIDENT_ID)
    ).all():
        for payment in session.exec(
            select(ClaimPayment).where(ClaimPayment.claim_id == claim.id)
        ).all():
            session.delete(payment)
        for change in session.exec(
            select(ReserveChange).where(ReserveChange.claim_id == claim.id)
        ).all():
            session.delete(change)
        session.flush()
        session.delete(claim)
    session.flush()


def _seed_prior_loss(session: Session, policy: Policy, coverage: str) -> Claim | None:
    """Seed ONE realistic CLOSED prior liquor loss so the venue's loss run has
    a non-zero incurred band to price against (the demo claim itself carries
    $0 reserve / $0 paid). Idempotent on PRIOR_INCIDENT_ID.

    Built via the authentic service chain: file_fnol (past date) →
    record_carrier_reserve → record_payment (indemnity) → close_claim.
    """
    existing = session.exec(
        select(Claim).where(Claim.incident_id == PRIOR_INCIDENT_ID)
    ).first()
    if existing is not None:
        return existing

    eff = policy.effective_date
    if isinstance(eff, str):
        eff = date.fromisoformat(eff)
    exp = policy.expiration_date
    if isinstance(exp, str):
        exp = date.fromisoformat(exp)
    # A past loss well inside the term: ~2 days after effective, never future.
    prior_loss_date = min(eff + timedelta(days=2), date.today() - timedelta(days=1))
    if prior_loss_date < eff:
        prior_loss_date = eff

    claim = file_fnol(
        session,
        policy_id=policy.id,
        coverage_line=coverage,
        date_of_loss=prior_loss_date,
        filed_by="seed_demo",
        incident_id=PRIOR_INCIDENT_ID,
        carrier_claim_number=PRIOR_CARRIER_CLAIM_NUMBER,
        adjuster_name="Dana Whitfield",
        adjuster_email="dana.whitfield@burnswilcox.example",
    )
    session.flush()
    record_carrier_reserve(
        session, claim.id,
        new_reserve=Decimal("7500.00"),
        change_reason="Initial reserve on reported liquor-liability loss",
        received_from="Burns & Wilcox",
        received_at=now_utc(),
        recorded_by="seed_demo",
    )
    record_payment(
        session, claim.id,
        amount=Decimal("6500.00"),
        payment_type="indemnity",
        paid_on=prior_loss_date + timedelta(days=30),
        description="Indemnity settlement — prior liquor-liability loss",
        recorded_by="seed_demo",
    )
    close_claim(
        session, claim.id,
        disposition="paid",
        final_indemnity=Decimal("6500.00"),
        closed_by="seed_demo",
    )
    session.flush()
    return claim


def seed(session: Session, *, refresh: bool = False) -> tuple[str, str] | None:
    policy = _pick_policy(session)
    if policy is None:
        print("[seed] no policy found — run scripts.seed_demo_placements first.")
        return None
    venue_id = policy.venue_id
    lines = list(policy.coverage_lines or [])
    coverage = "liquor" if "liquor" in lines else (lines[0] if lines else "gl")

    # Loss date must fall inside the policy term — derive it from the policy
    # rather than hardcoding, so this works against any seeded book.
    eff = policy.effective_date
    if isinstance(eff, str):
        eff = date.fromisoformat(eff)
    loss_date = min(eff + timedelta(days=30), date.today())
    occurred_at = f"{loss_date.isoformat()}T23:13:00"
    report_date = (loss_date + timedelta(days=1)).isoformat()

    if refresh:
        # Drop the stale demo artifacts so the recreated claim picks up the
        # capped (today-or-earlier) loss_date and an aligned packet timeline.
        _delete_demo_artifacts(session)
        _delete_prior_loss(session)
        session.commit()

    existing = session.exec(
        select(Claim).where(Claim.incident_id == INCIDENT_ID)
    ).first()
    if existing and existing.defense_package_id:
        print(f"[seed] already seeded — packet={existing.defense_package_id} claim={existing.id}")
        # Even on skip, ensure the prior loss exists so the advisory band is non-zero.
        _seed_prior_loss(session, policy, coverage)
        session.commit()
        return (existing.defense_package_id, existing.id)

    # 1. Incident — documented A&B with the structured fields the PDF surfaces.
    incident = session.get(IncidentRecord, INCIDENT_ID)
    if incident is None:
        incident = IncidentRecord(
            id=INCIDENT_ID,
            venue_id=venue_id,
            occurred_at=occurred_at,
            location="Rear Bar",
            summary=(
                "Two patrons began fighting near the rear bar during a sold-out DJ set. "
                "Security intervened within ~20 seconds; one patron sustained a facial "
                "laceration and was treated by EMS on scene."
            ),
            reported_by="Jordan Reyes (Shift Lead)",
            injury_observed=True,
            police_called=True,
            ems_called=True,
            incident_category="assault_battery",
            parties=[
                {"role": "aggressor", "description": "Male patron, ejected; refused further service earlier in the night"},
                {"role": "injured", "description": "Male patron, facial laceration, transported by EMS"},
            ],
            witnesses=[
                {"name": "Security — Marcus Bell", "statement": "Saw the first strike thrown by the ejected patron."},
                {"name": "Bartender — Lena Cho", "statement": "Had cut off the aggressor ~15 min prior."},
            ],
            security_response=[
                {"at": "23:13:20", "action": "Two guards separated the parties"},
                {"at": "23:15:00", "action": "EMS called; aggressor escorted out and ID recorded"},
            ],
            weapon_involved=False,
            refused_service_or_overserved="aggressor refused service ~15 min before the incident",
            injury_detail="Laceration above the left eyebrow; treated on scene, declined transport.",
            status="open",
        )
        session.add(incident)
        session.flush()

    # 2. Evidence with real content hashes + corroboration analysis.
    evidence = [
        ("cctv-rear-bar-2313.mp4", "video/mp4", "video", 5_242_880,
         "Rear-bar camera: aggressor throws the first strike at 23:13:14; guards separate parties by 23:13:34."),
        ("incident-report-signed.pdf", "application/pdf", "document", 264_192,
         "Manager-signed incident report, countersigned by the shift lead, dated 2026-05-03."),
    ]
    for filename, content_type, atype, size, desc in evidence:
        ev_id = f"ev-{INCIDENT_ID}-{filename.split('.')[0]}"
        if session.get(EvidenceFile, ev_id) is None:
            content_hash = hashlib.sha256(f"{ev_id}:{filename}:{size}".encode()).hexdigest()
            session.add(EvidenceFile(
                id=ev_id, incident_id=incident.id, filename=filename,
                content_type=content_type, file_path=f"/seed-evidence/{filename}",
                file_size=size, uploaded_by="Jordan Reyes (Shift Lead)",
                content_hash=content_hash, captured_at=f"{loss_date.isoformat()}T23:14:00",
            ))
            # Column-level FK (no Relationship): flush the parent EvidenceFile
            # before inserting its EvidenceAnalysis, or Postgres rejects the
            # child insert (passes on SQLite, fails on PG — known gotcha).
            session.flush()
            session.add(EvidenceAnalysis(
                id=f"an-{ev_id}", evidence_id=ev_id, incident_id=incident.id,
                analysis_type=atype, findings={"summary": desc},
                corroboration="CONSISTENT", confidence_delta=0.12,
                raw_description=desc, status="complete", analyzed_at=datetime.utcnow(),
            ))
    session.flush()

    # 3. UnderwritingPacket via the real builder (authentic snapshot hash + citation).
    incident_create = IncidentCreate(
        occurred_at=incident.occurred_at, location=incident.location,
        summary=incident.summary, reported_by=incident.reported_by,
        injury_observed=incident.injury_observed, police_called=incident.police_called,
        ems_called=incident.ems_called, incident_category=incident.incident_category,
        parties=incident.parties, witnesses=incident.witnesses,
        security_response=incident.security_response, weapon_involved=incident.weapon_involved,
        refused_service_or_overserved=incident.refused_service_or_overserved,
        injury_detail=incident.injury_detail,
    )
    citations = [Citation(
        source_id=f"increp-{INCIDENT_ID}",
        source_type="compliance",
        excerpt=("Manager-signed incident report: aggressor was refused further service ~15 minutes "
                 "before the altercation; security intervened within ~20 seconds."),
    )]
    packet = create_packet_snapshot(
        session=session, venue_id=venue_id, incident_id=incident.id,
        incident=incident_create,
        risk_signal={"type": "assault_battery", "severity": "high", "confidence": 0.85},
        action_plan=[
            {"step": "Preserve rear-bar CCTV (90-day hold)", "owner": "GM"},
            {"step": "File FNOL with carrier", "owner": "Broker"},
        ],
        claims_timeline=[
            {"at": occurred_at, "event": "Altercation at rear bar"},
            {"at": f"{loss_date.isoformat()}T23:15:00", "event": "Security separated parties; EMS called"},
            {"at": f"{report_date}T09:00:00", "event": "Incident report signed and filed"},
        ],
        underwriting_memo={"summary": (
            "Documented A&B with contemporaneous, hash-verified evidence and a clear security "
            "response — strong defense posture against a liquor-liability claim."
        )},
        citations=citations,
        rubric_version="demo-rubric-v1",
    )
    # create_packet_snapshot leaves packet-level corroboration unset (the live
    # flow fills it after a vision pass). Set it to match the consistent
    # evidence so the PDF's corroboration section reads as a real verdict.
    packet.corroboration_status = "CONSISTENT"
    packet.corroboration_flags = [
        "security_response_within_20s",
        "aggressor_refused_service_prior",
    ]
    session.add(packet)
    session.flush()

    # 4. Carrier Claim with the packet attached → unlocks the Download PDF button.
    claim = file_fnol(
        session,
        policy_id=policy.id,
        coverage_line=coverage,
        date_of_loss=loss_date,
        filed_by="seed_demo",
        incident_id=incident.id,
        defense_package_id=packet.id,
        carrier_claim_number="BW-2026-DEMO",
        adjuster_name="Dana Whitfield",
        adjuster_email="dana.whitfield@burnswilcox.example",
    )
    session.flush()

    # 5. A separate CLOSED prior liquor loss so the reserve advisory band on the
    #    live screen is non-zero (the demo claim carries $0 reserve / $0 paid).
    _seed_prior_loss(session, policy, coverage)

    session.commit()
    print(f"[seed] packet={packet.id} claim={claim.id} policy={policy.id} venue={venue_id} coverage={coverage}")
    return (packet.id, claim.id)


if __name__ == "__main__":
    refresh = "--refresh" in sys.argv
    with Session(engine) as s:
        sys.exit(0 if seed(s, refresh=refresh) is not None else 1)
