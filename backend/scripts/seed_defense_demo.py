"""Seed ONE complete defense-package demo so the PDF export is reachable in UI.

Builds the authentic chain — incident (A&B) -> hashed evidence + corroboration
-> UnderwritingPacket (real snapshot hash + citation via create_packet_snapshot)
-> carrier Claim with defense_package_id set (file_fnol) — so the broker Claim
detail shows "Defense package · Download PDF".

Idempotent: deterministic incident id; skips if the demo claim already exists.
Run from backend/:
    python -m scripts.seed_defense_demo
"""
from __future__ import annotations

import hashlib
import sys
from datetime import date, datetime, timedelta

from sqlmodel import Session, select

from app.database import engine
from app.models import Claim, EvidenceAnalysis, EvidenceFile, IncidentRecord, Policy
from app.packet_core import create_packet_snapshot
from app.schemas import Citation, IncidentCreate
from app.services.claims import file_fnol

INCIDENT_ID = "inc-defense-demo"


def _pick_policy(session: Session) -> Policy | None:
    p = session.get(Policy, "pol-demo-1")
    if p:
        return p
    return (
        session.exec(select(Policy).where(Policy.status == "active")).first()
        or session.exec(select(Policy)).first()
    )


def seed(session: Session) -> tuple[str, str] | None:
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
    loss_date = eff + timedelta(days=30)
    occurred_at = f"{loss_date.isoformat()}T23:13:00"
    report_date = (loss_date + timedelta(days=1)).isoformat()

    existing = session.exec(
        select(Claim).where(Claim.incident_id == INCIDENT_ID)
    ).first()
    if existing and existing.defense_package_id:
        print(f"[seed] already seeded — packet={existing.defense_package_id} claim={existing.id}")
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
                content_hash=content_hash, captured_at="2026-05-02T23:14:00",
            ))
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
    session.commit()
    print(f"[seed] packet={packet.id} claim={claim.id} policy={policy.id} venue={venue_id} coverage={coverage}")
    return (packet.id, claim.id)


if __name__ == "__main__":
    with Session(engine) as s:
        sys.exit(0 if seed(s) is not None else 1)
