from app.fastapi_compat import patch_starlette_router_for_fastapi

patch_starlette_router_for_fastapi()

from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlmodel import Session, select, text, func
import time

from app.incident_flow import create_brawl_incident_flow
from app.agents.vision_agent import analyze_image, analyze_video_keyframes
from app.agents.corroboration_agent import corroborate
from app.schemas import Incident, IncidentCreate, IncidentFlowResponse, LiveVenueState, StreamEvent
from app.seed_data import KNOWLEDGE_SOURCES, SEED_INCIDENTS, STREAM_EVENTS, VENUES
from app.database import create_db_and_tables, get_session
from app.live_state import live_state_manager
from app.models import AuditEvent, EvidenceAnalysis, EvidenceFile, IncidentRecord, ReviewDecision, SourceRecord, UnderwritingPacket, Venue, UserRecord
from app.packet_core import create_packet_snapshot, record_review_decision, record_packet_opened
from app.agents.runtime import execute_underwriting_packet_agents
from app.underwriting import get_premium_quote, get_risk_score


class ReviewDecisionCreate(BaseModel):
    reviewer_id: str
    decision: str
    override_reason: str | None = None
    notes: str | None = None

def _backfill_incident_packets(session: Session) -> None:
    """Generate underwriting packets for any incidents that don't have one yet."""
    all_incidents = session.exec(select(IncidentRecord)).all()
    packeted_ids = set(
        session.exec(select(UnderwritingPacket.incident_id)).all()
    )
    pending = [inc for inc in all_incidents if inc.id not in packeted_ids]
    if not pending:
        return
    print(f"[BACKFILL] Generating packets for {len(pending)} unprocessed incident(s)...")
    fallback_venue = list(VENUES.values())[0]
    for record in pending:
        try:
            venue = VENUES.get(record.venue_id, fallback_venue)
            payload = IncidentCreate(
                occurred_at=record.occurred_at.isoformat() if hasattr(record.occurred_at, "isoformat") else str(record.occurred_at),
                location=record.location,
                summary=record.summary,
                reported_by=record.reported_by,
                injury_observed=record.injury_observed or False,
                police_called=record.police_called or False,
                ems_called=record.ems_called or False,
            )
            result = execute_underwriting_packet_agents(
                venue_id=record.venue_id,
                venue=venue,
                incident=payload,
                knowledge_sources=KNOWLEDGE_SOURCES,
                stream_events=STREAM_EVENTS,
            )
            create_packet_snapshot(
                session=session,
                venue_id=record.venue_id,
                incident_id=record.id,
                incident=payload,
                risk_signal=result.risk_signal.model_dump(),
                action_plan=[a.model_dump() for a in result.action_plan],
                claims_timeline=[t.model_dump() for t in result.claims_timeline],
                underwriting_memo=result.underwriting_memo.model_dump(),
                citations=result.citations,
                rubric_version="demo-rubric-v1",
            )
            session.commit()
            print(f"[BACKFILL] Packet created for incident {record.id}")
        except Exception as exc:
            session.rollback()
            print(f"[BACKFILL] Skipped {record.id}: {exc}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()
    with next(get_session()) as session:
        # Migrations for columns added after initial deploy
        for migration in [
            "ALTER TABLE incidentrecord ADD COLUMN status TEXT NOT NULL DEFAULT 'open'",
            "ALTER TABLE venue ADD COLUMN venue_data TEXT",
        ]:
            try:
                session.exec(text(migration))
                session.commit()
            except Exception:
                pass  # Column already exists
        # Seed venues
        for venue_id, venue_data in VENUES.items():
            if not session.get(Venue, venue_id):
                session.add(Venue(id=venue_id, name=venue_data["name"]))
        session.commit()
        # Rehydrate USERS_DB from persisted user records
        from app.auth import USERS_DB, _user_record_to_dict, USER_COUNTER
        import app.auth as _auth
        db_users = session.exec(select(UserRecord)).all()
        max_counter = 3
        for u in db_users:
            if u.id not in USERS_DB:
                USERS_DB[u.id] = _user_record_to_dict(u)
                print(f"[REHYDRATE] Loaded user {u.id} from DB")
            try:
                num = int(u.id.split("_")[1])
                if num >= max_counter:
                    max_counter = num + 1
            except Exception:
                pass
        _auth.USER_COUNTER = max(max_counter, _auth.USER_COUNTER)

        # Rehydrate VENUES from any API-created venues stored in the DB
        import json as _json
        db_venues = session.exec(select(Venue)).all()
        for v in db_venues:
            if v.id not in VENUES and v.venue_data:
                try:
                    VENUES[v.id] = _json.loads(v.venue_data)
                    print(f"[REHYDRATE] Loaded venue {v.id} from DB")
                except Exception:
                    pass
        # Reseed incidents if DB has no seed incidents (fresh start or after reset)
        existing_count = session.exec(select(func.count(IncidentRecord.id))).one()
        if existing_count == 0:
            print(f"[SEED] Inserting {len(SEED_INCIDENTS)} seed incidents...")
            for raw in SEED_INCIDENTS:
                from uuid import uuid4
                from datetime import datetime
                occurred = raw["occurred_at"]
                if isinstance(occurred, str):
                    occurred = datetime.fromisoformat(occurred)
                session.add(IncidentRecord(
                    id=f"inc-{raw['venue_id']}-{uuid4().hex[:12]}",
                    venue_id=raw["venue_id"],
                    occurred_at=occurred,
                    location=raw["location"],
                    summary=raw["summary"],
                    reported_by=raw["reported_by"],
                    injury_observed=raw["injury_observed"],
                    police_called=raw["police_called"],
                    ems_called=raw["ems_called"],
                    status="open",
                ))
            session.commit()
            print("[SEED] Done.")
        # Backfill packets for any incidents that don't have one yet
        _backfill_incident_packets(session)
    yield

app = FastAPI(title="Third Space Risk OS", lifespan=lifespan)

from app.auth import router as auth_router
app.include_router(auth_router, prefix="/api/auth", tags=["auth"])

from app.api.v1.ingestion import router as ingestion_router
app.include_router(ingestion_router, prefix="/api/v1", tags=["ingestion"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://172.20.5.179:3000",
        "https://frontend-in2g6dgt3-vidiyala99s-projects.vercel.app",
        "https://frontend-mu-ebon-n3x8uw2rpx.vercel.app",
        "exp://localhost:8081",
        "exp://127.0.0.1:8081",
    ],
    allow_origin_regex=r"(https://.*\.vercel\.app|exp://192\.168\.\d+\.\d+:\d+)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _resolve_venue(venue_id: str, session: Session) -> dict:
    """Return venue data from in-memory dict or DB, caching the result. Raises 404 if not found."""
    if venue_id in VENUES:
        return VENUES[venue_id]
    import json as _json
    db_venue = session.get(Venue, venue_id)
    if not db_venue:
        raise HTTPException(status_code=404, detail="Venue not found")
    if db_venue.venue_data:
        try:
            venue_data = _json.loads(db_venue.venue_data)
            VENUES[venue_id] = venue_data
            return venue_data
        except Exception:
            pass
    # DB record exists but no venue_data (created before persistence fix) — use defaults
    venue_data = {
        "name": db_venue.name,
        "capacity": 300,
        "venue_type": "bar",
        "address": "",
        "current_carrier": "Surplus Lines",
        "renewal_date": "2027-01-01",
        "incident_count": 0,
        "compliance_items": 0,
        "security_level": "medium",
        "years_in_operation": 1,
        "prior_carrier": "Surplus Lines",
        "infrastructure": [],
    }
    VENUES[venue_id] = venue_data
    return venue_data


@app.get("/api/venues")
def list_venues(session: Session = Depends(get_session)) -> list[dict]:
    result = [{"id": venue_id, **venue} for venue_id, venue in VENUES.items()]
    # Include any DB-only venues not in the seed dict
    db_venues = session.exec(select(Venue)).all()
    seed_ids = set(VENUES.keys())
    for v in db_venues:
        if v.id not in seed_ids:
            result.append({"id": v.id, "name": v.name, **v.model_dump()})
    return result


@app.post("/api/venues", status_code=201)
def create_venue(payload: dict, session: Session = Depends(get_session)) -> dict:
    import re
    name = payload.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Venue name is required")
    venue_id = payload.get("id") or re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if venue_id in VENUES or session.get(Venue, venue_id):
        raise HTTPException(status_code=409, detail="A venue with this name already exists")
    venue_data = {
        "name": name,
        "capacity": int(payload.get("capacity", 300)),
        "venue_type": payload.get("venue_type", "bar"),
        "address": payload.get("address", ""),
        "current_carrier": "Surplus Lines",
        "renewal_date": payload.get("renewal_date", "2027-01-01"),
        "incident_count": 0,
        "compliance_items": 0,
        "security_level": "medium",
        "years_in_operation": int(payload.get("years_in_operation", 1)),
        "prior_carrier": "Surplus Lines",
        "infrastructure": [],
    }
    VENUES[venue_id] = venue_data
    import json as _json
    if not session.get(Venue, venue_id):
        session.add(Venue(id=venue_id, name=name, venue_data=_json.dumps(venue_data)))
    else:
        db_venue = session.get(Venue, venue_id)
        db_venue.venue_data = _json.dumps(venue_data)
        session.add(db_venue)
    session.commit()
    return {"id": venue_id, **venue_data}


@app.get("/api/venues/{venue_id}")
def get_venue(venue_id: str, session: Session = Depends(get_session)) -> dict:
    venue = _resolve_venue(venue_id, session)
    return {"id": venue_id, **venue}


@app.get("/api/venues/count")
def venue_count() -> dict:
    return {"count": len(VENUES)}


@app.patch("/api/venues/{venue_id}")
def update_venue(venue_id: str, payload: dict, session: Session = Depends(get_session)) -> dict:
    venue = _resolve_venue(venue_id, session)
    editable = ["name", "address", "capacity", "venue_type", "years_in_operation", "security_level"]
    for field in editable:
        if field in payload:
            value = payload[field]
            if field in ("capacity", "years_in_operation"):
                value = int(value)
            venue[field] = value
    VENUES[venue_id] = venue
    import json as _json
    db_venue = session.get(Venue, venue_id)
    if db_venue:
        db_venue.name = venue.get("name", db_venue.name)
        db_venue.venue_data = _json.dumps(venue)
        session.add(db_venue)
        session.commit()
    return {"id": venue_id, **venue}


@app.get("/api/portfolio")
def get_portfolio(session: Session = Depends(get_session)) -> list[dict]:
    """Single endpoint for broker portfolio view — all venues with scores + live state."""
    result = []
    for venue_id, venue_data in VENUES.items():
        risk = get_risk_score(venue_id, VENUES)
        live = live_state_manager.get_state(venue_id, venue_data["capacity"], venue_data)
        open_count = session.exec(
            select(func.count(IncidentRecord.id))
            .where(IncidentRecord.venue_id == venue_id)
            .where(IncidentRecord.status == "open")
        ).one()
        result.append({
            "id": venue_id,
            "name": venue_data["name"],
            "venue_type": venue_data.get("venue_type", ""),
            "address": venue_data.get("address", ""),
            "capacity": venue_data["capacity"],
            "current_capacity": live.current_capacity,
            "renewal_date": venue_data.get("renewal_date", ""),
            "current_carrier": venue_data.get("current_carrier", ""),
            "tier": risk["tier"],
            "total_score": risk["total_score"],
            "open_incidents": open_count,
            "compliance_actions": len(live.compliance_queue),
            "has_degraded_infra": any(item.is_degraded for item in live.infrastructure),
        })
    return result


@app.get("/api/venues/{venue_id}/incidents", response_model=list[Incident])
def list_incidents(
    venue_id: str,
    status: str | None = Query(default=None, description="Filter by status: open | under_review | closed"),
    session: Session = Depends(get_session),
) -> list[Incident]:
    _resolve_venue(venue_id, session)

    query = select(IncidentRecord).where(IncidentRecord.venue_id == venue_id)
    if status:
        query = query.where(IncidentRecord.status == status)
    query = query.order_by(IncidentRecord.created_at.desc())

    records = session.exec(query).all()
    return [
        Incident(
            id=record.id,
            venue_id=record.venue_id,
            occurred_at=record.occurred_at,
            location=record.location,
            summary=record.summary,
            reported_by=record.reported_by,
            injury_observed=record.injury_observed,
            police_called=record.police_called,
            ems_called=record.ems_called,
            status=record.status,
        )
        for record in records
    ]


EVIDENCE_DIR = Path(__file__).resolve().parent.parent / "evidence_uploads"
EVIDENCE_DIR.mkdir(exist_ok=True)


def _process_evidence_sync(evidence_id: str) -> None:
    """Phase 2: analyze uploaded evidence and update the underwriting packet."""
    with next(get_session()) as session:
        ev = session.get(EvidenceFile, evidence_id)
        if not ev:
            return
        incident = session.get(IncidentRecord, ev.incident_id)
        if not incident:
            return

        # Run vision analysis based on file type
        try:
            if ev.content_type.startswith("image/"):
                finding = analyze_image(
                    file_path=ev.file_path,
                    incident_summary=incident.summary,
                    incident_location=incident.location,
                    injury_observed=incident.injury_observed or False,
                    police_called=incident.police_called or False,
                )
                analysis_type = "image"
            elif ev.content_type.startswith("video/"):
                finding = analyze_video_keyframes(
                    file_path=ev.file_path,
                    incident_summary=incident.summary,
                    incident_location=incident.location,
                    injury_observed=incident.injury_observed or False,
                    police_called=incident.police_called or False,
                )
                analysis_type = "video"
            else:
                return  # PDFs and other docs — skip vision for now

            from datetime import datetime
            from uuid import uuid4
            analysis = EvidenceAnalysis(
                id=f"ea-{uuid4().hex[:12]}",
                evidence_id=evidence_id,
                incident_id=ev.incident_id,
                analysis_type=analysis_type,
                findings=finding.__dict__,
                corroboration=finding.corroboration,
                confidence_delta=finding.confidence_delta,
                raw_description=finding.raw_description,
                status="complete",
                analyzed_at=datetime.utcnow(),
            )
            session.add(analysis)
            session.commit()

            # Check if all evidence files for this incident have been analyzed
            all_files = session.exec(
                select(EvidenceFile).where(EvidenceFile.incident_id == ev.incident_id)
            ).all()
            all_analyses = session.exec(
                select(EvidenceAnalysis)
                .where(EvidenceAnalysis.incident_id == ev.incident_id)
                .where(EvidenceAnalysis.status == "complete")
            ).all()

            if len(all_analyses) >= len(all_files):
                _run_corroboration_and_update_packet(session, ev.incident_id, incident, all_analyses)

        except Exception as exc:
            print(f"[VISION] Failed to analyze {evidence_id}: {exc}")
            session.rollback()


def _run_corroboration_and_update_packet(session, incident_id: str, incident: IncidentRecord, analyses) -> None:
    """Run corroboration agent and regenerate packet with visual context."""
    from app.agents.vision_agent import VisionFinding
    findings = []
    for a in analyses:
        f = a.findings
        findings.append(VisionFinding(**f))

    result = corroborate(
        findings=findings,
        incident_summary=incident.summary,
        injury_observed=incident.injury_observed or False,
        police_called=incident.police_called or False,
        ems_called=incident.ems_called or False,
    )

    # Find the latest packet for this incident and update it
    packet = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
    ).first()

    if not packet:
        return

    # Update confidence in risk_signals
    current_confidence = packet.risk_signals.get("confidence", 0.78)
    new_confidence = min(round(current_confidence + result.confidence_adjustment, 2), 0.99)
    updated_risk_signals = {**packet.risk_signals, "confidence": new_confidence}

    # Add visual findings to memo
    visual_section = (
        f"\n\nVisual Evidence Analysis ({len(analyses)} file(s) processed): "
        f"{result.summary} "
        f"Corroboration status: {result.status}. "
        f"Flags: {'; '.join(result.flags)}."
    )
    updated_memo = {**packet.memo, "summary": packet.memo.get("summary", "") + visual_section}

    packet.risk_signals = updated_risk_signals
    packet.memo = updated_memo
    packet.status = "needs_review"
    session.add(packet)
    session.commit()
    print(f"[VISION] Packet {packet.id} updated — corroboration: {result.status}, new confidence: {new_confidence}")


@app.post("/api/incidents/{incident_id}/evidence", status_code=201)
async def upload_evidence(
    incident_id: str,
    file: UploadFile = File(...),
    uploaded_by: str = "operator",
    background_tasks: BackgroundTasks = None,
    session: Session = Depends(get_session),
) -> dict:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    from uuid import uuid4
    evidence_id = f"ev-{uuid4().hex[:12]}"
    safe_name = f"{evidence_id}_{file.filename}"
    dest = EVIDENCE_DIR / safe_name
    MAX_IMAGE_SIZE = 20 * 1024 * 1024   # 20MB
    MAX_VIDEO_SIZE = 200 * 1024 * 1024  # 200MB — for larger files use the link option

    contents = await file.read()
    max_size = MAX_VIDEO_SIZE if (file.content_type or "").startswith("video/") else MAX_IMAGE_SIZE
    if len(contents) > max_size:
        limit_mb = max_size // (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"File too large. Maximum size for this file type is {limit_mb}MB. For larger videos, use the S3 upload path.")
    dest.write_bytes(contents)
    evidence = EvidenceFile(
        id=evidence_id,
        incident_id=incident_id,
        filename=file.filename or "upload",
        content_type=file.content_type or "application/octet-stream",
        file_path=str(dest),
        file_size=len(contents),
        uploaded_by=uploaded_by,
    )
    session.add(evidence)
    session.commit()
    # Trigger async vision analysis
    if background_tasks and file.content_type and (
        file.content_type.startswith("image/") or file.content_type.startswith("video/")
    ):
        background_tasks.add_task(_process_evidence_sync, evidence_id)
    return {"id": evidence_id, "filename": evidence.filename, "content_type": evidence.content_type, "file_size": evidence.file_size, "uploaded_at": evidence.uploaded_at.isoformat()}


@app.get("/api/incidents/{incident_id}/evidence")
def list_evidence(incident_id: str, session: Session = Depends(get_session)) -> list[dict]:
    files = session.exec(
        select(EvidenceFile).where(EvidenceFile.incident_id == incident_id).order_by(EvidenceFile.uploaded_at)
    ).all()
    return [{"id": f.id, "filename": f.filename, "content_type": f.content_type, "file_size": f.file_size, "uploaded_by": f.uploaded_by, "uploaded_at": f.uploaded_at.isoformat()} for f in files]


@app.get("/api/incidents/{incident_id}/evidence-analysis")
def get_evidence_analysis(incident_id: str, session: Session = Depends(get_session)) -> dict:
    """Return aggregated vision analysis status for all evidence on an incident."""
    analyses = session.exec(
        select(EvidenceAnalysis).where(EvidenceAnalysis.incident_id == incident_id)
    ).all()
    all_files = session.exec(
        select(EvidenceFile).where(EvidenceFile.incident_id == incident_id)
    ).all()
    processable = [f for f in all_files if f.content_type.startswith(("image/", "video/"))]
    complete = [a for a in analyses if a.status == "complete"]
    return {
        "total_files": len(processable),
        "processed": len(complete),
        "status": "complete" if len(complete) >= len(processable) > 0 else "processing" if processable else "no_media",
        "analyses": [
            {
                "evidence_id": a.evidence_id,
                "analysis_type": a.analysis_type,
                "corroboration": a.corroboration,
                "confidence_delta": a.confidence_delta,
                "raw_description": a.raw_description,
                "findings": a.findings,
                "analyzed_at": a.analyzed_at.isoformat() if a.analyzed_at else None,
            }
            for a in complete
        ],
    }


@app.get("/api/evidence/{evidence_id}/file")
def serve_evidence(evidence_id: str, session: Session = Depends(get_session)):
    from fastapi.responses import FileResponse
    ev = session.get(EvidenceFile, evidence_id)
    if ev is None:
        raise HTTPException(status_code=404, detail="Evidence not found")
    path = Path(ev.file_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
    return FileResponse(str(path), media_type=ev.content_type, filename=ev.filename)


@app.get("/api/incidents", response_model=list[Incident])
def list_all_incidents(limit: int = 100, session: Session = Depends(get_session)) -> list[Incident]:
    """Return all incidents across all venues, newest first."""
    records = session.exec(
        select(IncidentRecord).order_by(IncidentRecord.occurred_at.desc()).limit(limit)
    ).all()
    return [Incident(
        id=r.id, venue_id=r.venue_id, occurred_at=r.occurred_at,
        location=r.location, summary=r.summary, reported_by=r.reported_by,
        injury_observed=r.injury_observed or False, police_called=r.police_called or False,
        ems_called=r.ems_called or False, status=r.status,
    ) for r in records]


@app.get("/api/incidents/{incident_id}", response_model=Incident)
def get_incident(incident_id: str, session: Session = Depends(get_session)) -> Incident:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return Incident(
        id=record.id,
        venue_id=record.venue_id,
        occurred_at=record.occurred_at,
        location=record.location,
        summary=record.summary,
        reported_by=record.reported_by,
        injury_observed=record.injury_observed,
        police_called=record.police_called,
        ems_called=record.ems_called,
        status=record.status,
    )


@app.patch("/api/incidents/{incident_id}/status", status_code=200)
def update_incident_status(
    incident_id: str,
    body: dict,
    session: Session = Depends(get_session),
) -> dict:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    new_status = body.get("status")
    if new_status not in ("open", "under_review", "closed"):
        raise HTTPException(status_code=400, detail="status must be open | under_review | closed")
    record.status = new_status
    session.add(record)
    session.commit()
    return {"id": incident_id, "status": record.status}


@app.post("/api/venues/{venue_id}/incidents", response_model=IncidentFlowResponse, status_code=201)
def create_incident(venue_id: str, payload: IncidentCreate, session: Session = Depends(get_session)) -> IncidentFlowResponse:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")
    return create_brawl_incident_flow(venue_id, payload, session)


@app.get("/api/incidents/{incident_id}/packets")
def list_incident_packets(incident_id: str, session: Session = Depends(get_session)) -> list[dict]:
    packets = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
    ).all()
    return [_packet_to_dict(packet) for packet in packets]


@app.get("/api/packets/{packet_id}")
def get_packet(
    packet_id: str,
    reviewer_id: str | None = None,
    session: Session = Depends(get_session),
) -> dict:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise HTTPException(status_code=404, detail="Packet not found")
    if reviewer_id:
        record_packet_opened(session=session, packet_id=packet_id, reviewer_id=reviewer_id)
    return _packet_to_dict(packet)


@app.get("/api/venues/{venue_id}/sources")
def list_venue_sources(venue_id: str, session: Session = Depends(get_session)) -> list[dict]:
    """Source registry — all evidence sources for a venue."""
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")
    sources = session.exec(
        select(SourceRecord)
        .where(SourceRecord.venue_id == venue_id)
        .order_by(SourceRecord.created_at.desc())
    ).all()
    return [
        {
            "id": s.id,
            "source_type": s.source_type,
            "excerpt": s.excerpt,
            "incident_id": s.incident_id,
            "content_hash": s.content_hash,
            "created_at": s.created_at.isoformat(),
        }
        for s in sources
    ]


@app.post("/api/packets/{packet_id}/review-decisions", status_code=201)
def create_review_decision(
    packet_id: str,
    payload: ReviewDecisionCreate,
    session: Session = Depends(get_session),
) -> dict:
    try:
        decision = record_review_decision(
            session=session,
            packet_id=packet_id,
            reviewer_id=payload.reviewer_id,
            decision=payload.decision,
            override_reason=payload.override_reason,
            notes=payload.notes,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return _review_decision_to_dict(decision)


@app.get("/api/packets")
def list_packets(limit: int = 20, session: Session = Depends(get_session)) -> list[dict]:
    """Return the most recent underwriting packets across all incidents."""
    packets = session.exec(
        select(UnderwritingPacket)
        .order_by(UnderwritingPacket.generated_at.desc())
        .limit(limit)
    ).all()
    return [_packet_to_dict(packet) for packet in packets]


@app.get("/api/packets/{packet_id}/audit-events")
def list_packet_audit_events(packet_id: str, session: Session = Depends(get_session)) -> list[dict]:
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise HTTPException(status_code=404, detail="Packet not found")
    events = session.exec(
        select(AuditEvent)
        .where(AuditEvent.entity_id == packet_id)
        .order_by(AuditEvent.created_at)
    ).all()
    return [_audit_event_to_dict(event) for event in events]


def simulate_event_queue(venue_id: str, events: list[StreamEvent]):
    time.sleep(0.5)
    live_state_manager.process_events(venue_id, events)
    print(f"[QUEUE WORKER] Processed {len(events)} events for venue {venue_id}")


@app.post("/api/venues/{venue_id}/events/stream", status_code=202)
def ingest_event_stream(venue_id: str, events: list[StreamEvent], background_tasks: BackgroundTasks):
    """High-volume ingestion — accepts immediately, processes asynchronously."""
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")
    background_tasks.add_task(simulate_event_queue, venue_id, events)
    return {"status": "accepted", "message": f"Queued {len(events)} events for asynchronous processing"}


@app.post("/api/venues/{venue_id}/events/inject")
def inject_event_sync(venue_id: str, events: list[StreamEvent]):
    """Demo endpoint — synchronously processes events so the UI can refresh immediately."""
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")
    live_state_manager.process_events(venue_id, events)
    live = live_state_manager.get_state(venue_id, VENUES[venue_id]["capacity"], VENUES[venue_id])
    return {
        "status": "processed",
        "events_count": len(events),
        "compliance_queue_length": len(live.compliance_queue),
    }


def _packet_to_dict(packet: UnderwritingPacket) -> dict:
    return {
        "id": packet.id,
        "venue_id": packet.venue_id,
        "incident_id": packet.incident_id,
        "rubric_version_id": packet.rubric_version_id,
        "status": packet.status,
        "risk_signals": packet.risk_signals,
        "action_plan": packet.action_plan,
        "claims_timeline": packet.claims_timeline,
        "memo": packet.memo,
        "citation_ids": packet.citation_ids,
        "validation": packet.validation,
        "snapshot_hash": packet.snapshot_hash,
        "generated_at": packet.generated_at.isoformat(),
    }


def _review_decision_to_dict(decision: ReviewDecision) -> dict:
    return {
        "id": decision.id,
        "packet_id": decision.packet_id,
        "reviewer_id": decision.reviewer_id,
        "decision": decision.decision,
        "override_reason": decision.override_reason,
        "notes": decision.notes,
        "decided_at": decision.decided_at.isoformat(),
    }


def _audit_event_to_dict(event: AuditEvent) -> dict:
    return {
        "id": event.id,
        "actor_id": event.actor_id,
        "actor_type": event.actor_type,
        "entity_type": event.entity_type,
        "entity_id": event.entity_id,
        "event_type": event.event_type,
        "metadata": event.event_metadata,
        "created_at": event.created_at.isoformat(),
    }


@app.get("/api/venues/{venue_id}/live", response_model=LiveVenueState)
def get_live_state(venue_id: str) -> LiveVenueState:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    return live_state_manager.get_state(venue_id, VENUES[venue_id]["capacity"], VENUES[venue_id])


@app.get("/api/venues/{venue_id}/risk-score")
def get_venue_risk_score(venue_id: str, session: Session = Depends(get_session)) -> dict:
    _resolve_venue(venue_id, session)
    return get_risk_score(venue_id, VENUES)


@app.get("/api/venues/{venue_id}/quote")
def get_venue_quote(venue_id: str, session: Session = Depends(get_session)) -> dict:
    _resolve_venue(venue_id, session)
    return get_premium_quote(venue_id, VENUES)


@app.post("/api/venues/{venue_id}/compliance/{item_id}/upload")
async def upload_compliance_evidence(venue_id: str, item_id: str, file: UploadFile = File(...)) -> dict:
    if venue_id not in VENUES:
        raise HTTPException(status_code=404, detail="Venue not found")

    live_state_manager.resolve_compliance_item(venue_id, item_id)
    return {
        "status": "accepted",
        "item_id": item_id,
        "filename": file.filename,
    }
