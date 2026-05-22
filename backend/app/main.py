from app.fastapi_compat import patch_starlette_router_for_fastapi

patch_starlette_router_for_fastapi()

from contextlib import asynccontextmanager  # noqa: E402
from pathlib import Path  # noqa: E402
from fastapi import FastAPI, HTTPException, Depends, BackgroundTasks, UploadFile, File, Query, Header  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from sqlmodel import Session, select, func  # noqa: E402
import time  # noqa: E402

from app.auth import router as auth_router, require_broker, require_non_broker, current_user_optional, can_read_venue_floor, require_venue_access  # noqa: E402
from app.lifecycles import INCIDENT_TRANSITIONS, InvalidTransitionError, assert_valid_transition  # noqa: E402
from app.packet_core import _add_audit_event  # noqa: E402
from app.schemas.errors import error_response  # noqa: E402
from app.api.v1.ingestion import router as ingestion_router  # noqa: E402
from app.claim_proposals import (  # noqa: E402
    ClaimProposalValidationError,
    compute_override_stats,
    create_proposal as create_claim_proposal,
    record_broker_decision as record_claim_broker_decision,
    stats_to_dict as override_stats_to_dict,
)
from app.claim_recommendation import recommend_claim_filing, recommendation_to_dict  # noqa: E402
from app.incident_flow import create_brawl_incident_flow  # noqa: E402
from app.agents.vision_agent import analyze_image, analyze_video_keyframes  # noqa: E402
from app.agents.corroboration_agent import corroborate  # noqa: E402
from app.knowledge_sources import INGESTED_ORIGIN, load_knowledge_sources_for_venue  # noqa: E402
from app.policy_document import build_policy_tree  # noqa: E402
from app.rag import SemanticKnowledgeBase  # noqa: E402
from app.policy_parser import chunk_policy_text  # noqa: F401, E402  # legacy fallback referenced by build_policy_tree's regex path
from app.schemas import Incident, IncidentCreate, IncidentFlowResponse, LiveVenueState, StreamEvent  # noqa: E402
from app.seed_data import SEED_INCIDENTS, STREAM_EVENTS, VENUES  # noqa: E402
from app.database import create_db_and_tables, get_session, engine  # noqa: F401, E402  # `engine` re-exported for tests that monkeypatch app.main.engine
from app.live_state import live_state_manager  # noqa: E402
from app.models import AuditEvent, ClaimProposal, ComplianceEvidence, EvidenceAnalysis, EvidenceFile, IncidentRecord, PolicyDocument, ReviewDecision, SourceRecord, UnderwritingPacket, Venue, UserRecord  # noqa: E402
from app.packet_core import (  # noqa: E402
    create_packet_snapshot,
    record_review_decision,
    record_packet_opened,
    regenerate_packet_with_corroboration,
)
from app.agents.runtime import execute_underwriting_packet_agents  # noqa: E402
from app.underwriting import get_premium_quote, get_risk_score  # noqa: E402


class ReviewDecisionCreate(BaseModel):
    reviewer_id: str
    decision: str
    override_reason: str | None = None
    notes: str | None = None


class ClaimProposalCreate(BaseModel):
    operator_id: str
    override_recommendation: bool = False
    override_reason: str | None = None
    override_freetext: str | None = None


class BrokerDecisionCreate(BaseModel):
    broker_id: str
    decision: str
    notes: str | None = None

_BACKFILL_MAX_PER_STARTUP = 25
_BACKFILL_MAX_CONSECUTIVE_FAILURES = 5


def _backfill_incident_packets(session: Session) -> None:
    """Generate underwriting packets for any incidents that don't have one yet.

    Bounded: at most _BACKFILL_MAX_PER_STARTUP packets per process boot, and aborts
    after _BACKFILL_MAX_CONSECUTIVE_FAILURES errors in a row to avoid a wedged
    LLM/network burning the entire startup.
    """
    import logging
    log = logging.getLogger("backfill")

    all_incidents = session.exec(select(IncidentRecord)).all()
    packeted_ids = set(session.exec(select(UnderwritingPacket.incident_id)).all())
    pending = [inc for inc in all_incidents if inc.id not in packeted_ids]
    if not pending:
        return

    total_pending = len(pending)
    if total_pending > _BACKFILL_MAX_PER_STARTUP:
        log.warning(
            "Backfill capped: %d incident(s) pending, processing first %d this startup.",
            total_pending, _BACKFILL_MAX_PER_STARTUP,
        )
        pending = pending[:_BACKFILL_MAX_PER_STARTUP]

    log.info("Backfill starting: %d incident(s).", len(pending))
    fallback_venue = list(VENUES.values())[0]
    succeeded = 0
    failed_ids: list[tuple[str, str]] = []
    consecutive_failures = 0

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
                knowledge_sources=load_knowledge_sources_for_venue(session, record.venue_id),
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
            succeeded += 1
            consecutive_failures = 0
        except Exception as exc:
            session.rollback()
            consecutive_failures += 1
            failed_ids.append((record.id, f"{exc.__class__.__name__}: {exc}"))
            log.warning("Backfill skipped %s: %s: %s", record.id, exc.__class__.__name__, exc)
            if consecutive_failures >= _BACKFILL_MAX_CONSECUTIVE_FAILURES:
                log.error(
                    "Backfill aborting after %d consecutive failures — likely an "
                    "upstream issue (LLM, DB). Remaining %d incident(s) deferred to next boot.",
                    consecutive_failures, len(pending) - (succeeded + len(failed_ids)),
                )
                break

    log.info(
        "Backfill complete: %d succeeded, %d failed%s. %d still pending after this run.",
        succeeded, len(failed_ids),
        "" if not failed_ids else f" ({', '.join(i for i, _ in failed_ids[:5])}{'…' if len(failed_ids) > 5 else ''})",
        total_pending - succeeded,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_db_and_tables()

    # Column-level ALTER migrations now live in app.database.create_db_and_tables
    # so they run on every session bootstrap, not only the FastAPI lifespan path.

    import json as _json
    from app.auth import DEMO_USERS, create_password_hash
    import app.auth as _auth

    with next(get_session()) as session:
        # Seed venues with full data
        for venue_id, venue_data in VENUES.items():
            existing = session.get(Venue, venue_id)
            if not existing:
                session.add(Venue(id=venue_id, name=venue_data["name"], venue_data=_json.dumps(venue_data)))
            elif not existing.venue_data:
                existing.venue_data = _json.dumps(venue_data)
                session.add(existing)
        session.commit()

        # Seed broker-platform reference data (Carrier + CoverageLine).
        # Idempotent — inserts missing rows by id, leaves existing rows alone.
        from app.seed_carriers import seed_broker_platform_data
        seed_broker_platform_data(session)
        session.commit()

        # Seed demo users.
        # After the 2026-05-21 project rename (Third Space Risk → Nightline
        # Risk), the demo broker email moved from broker@thirdspace.risk
        # to broker@thirdspace.risk. Existing rows on a long-running database
        # (Railway prod) keep the old email because the seed loop below only
        # inserts when the id is missing. The small UPDATE in the elif keeps
        # the persisted row's email in sync with DEMO_USERS on every boot —
        # idempotent (no-op once the migration has run once).
        for demo in DEMO_USERS:
            existing = session.get(UserRecord, demo["id"])
            if existing is None:
                session.add(UserRecord(
                    id=demo["id"],
                    email=demo["email"],
                    password_hash=create_password_hash(demo["password"]),
                    name=demo["name"],
                    role=demo["role"],
                    tenant_id=demo["tenant_id"],
                ))
            elif existing.email != demo["email"]:
                existing.email = demo["email"]
                session.add(existing)
        session.commit()

        # Sync USER_COUNTER
        all_users = session.exec(select(UserRecord)).all()
        max_counter = len(DEMO_USERS) + 1
        for u in all_users:
            try:
                num = int(u.id.split("_")[1])
                if num >= max_counter:
                    max_counter = num + 1
            except Exception:
                pass
        _auth.USER_COUNTER = max_counter

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
        # Upsert seed incidents using deterministic IDs so new entries
        # are added on deploy without re-seeding the whole table.
        from datetime import datetime as _dt
        inserted = 0
        for idx, raw in enumerate(SEED_INCIDENTS):
            seed_id = f"seed-{raw['venue_id']}-{idx:03d}"
            if session.get(IncidentRecord, seed_id):
                continue
            occurred = raw["occurred_at"]
            if isinstance(occurred, str):
                occurred = _dt.fromisoformat(occurred)
            session.add(IncidentRecord(
                id=seed_id,
                venue_id=raw["venue_id"],
                occurred_at=occurred,
                location=raw["location"],
                summary=raw["summary"],
                reported_by=raw["reported_by"],
                injury_observed=raw["injury_observed"],
                police_called=raw["police_called"],
                ems_called=raw["ems_called"],
                status=raw.get("status", "open"),
            ))
            inserted += 1
        if inserted:
            session.commit()
            print(f"[SEED] Inserted {inserted} new seed incident(s).")
        # Backfill packets for any incidents that don't have one yet
        _backfill_incident_packets(session)
    yield

app = FastAPI(title="Nightline Risk OS", lifespan=lifespan)

app.include_router(auth_router, prefix="/api/auth", tags=["auth"])
app.include_router(ingestion_router, prefix="/api/v1", tags=["ingestion"])

from app.api.v1.placement import router as placement_router  # noqa: E402
app.include_router(placement_router, prefix="/api", tags=["placement"])

from app.api.v1.policies import router as policies_router  # noqa: E402
app.include_router(policies_router, prefix="/api", tags=["policies"])

from app.api.v1.claims import router as claims_router  # noqa: E402
app.include_router(claims_router, prefix="/api", tags=["claims"])

from app.api.v1.venues import router as venues_router  # noqa: E402
app.include_router(venues_router, prefix="/api", tags=["venues"])

from app.api.v1.incidents import router as incidents_router  # noqa: E402
app.include_router(incidents_router, prefix="/api", tags=["incidents"])

from app.api.v1.packets import router as packets_router  # noqa: E402
app.include_router(packets_router, prefix="/api", tags=["packets"])

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


# Venue routes (/api/venues, /api/venues/{venue_id}, /api/venues/count,
# /api/portfolio) migrated to app.api.v1.venues — see the router mounted
# below the FastAPI(app) declaration. Kept here as a navigation marker
# during the Phase B migration so a `git blame` reader can find the move.


# Incident routes (/api/incidents, /api/incidents/{id}, PATCH .../status,
# /api/venues/{vid}/incidents) migrated to app.api.v1.incidents — see the
# router mounted below the FastAPI(app) declaration.


EVIDENCE_DIR = Path(__file__).resolve().parent.parent / "evidence_uploads"
EVIDENCE_DIR.mkdir(exist_ok=True)


@app.get("/api/debug/llm-provider")
def debug_llm_provider(test: bool = False) -> dict:
    """Returns which LLM provider is active and which API key env vars are set.
    Pass ?test=true to do a live draft_memo call — note this burns one quota
    request, so don't poll this endpoint with test=true."""
    import os
    from app.providers import get_default_provider
    try:
        prov = get_default_provider()
        active = {"provider_name": prov.provider_name, "mode": prov.mode.value}
    except Exception as exc:
        active = {"provider_name": "ERROR", "mode": "error", "error": f"{exc.__class__.__name__}: {exc}"}

    response: dict = {
        "active": active,
        "env": {
            "ANTHROPIC_API_KEY_set": bool(os.getenv("ANTHROPIC_API_KEY")),
            "GEMINI_API_KEY_set": bool(os.getenv("GEMINI_API_KEY")),
        },
    }

    if test:
        try:
            prov = get_default_provider()
            result = prov.draft_memo(
                incident_summary="Patron tripped over a chair. Minor bruise.",
                incident_location="Test bar",
                risk_type="general_incident",
                severity="low",
                confidence=0.7,
                citation_excerpts=["Test policy: standard documentation."],
            )
            response["test_call"] = {
                "ok": True,
                "provider": result.provider,
                "summary_first_120_chars": result.summary[:120],
            }
        except Exception as exc:
            response["test_call"] = {
                "ok": False,
                "error_class": exc.__class__.__name__,
                "error_message": str(exc)[:600],
            }

    return response


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
    """Run corroboration and emit a v2 packet referencing v1 — never mutates v1."""
    from app.agents.vision_agent import VisionFinding
    findings = [VisionFinding(**a.findings) for a in analyses]

    result = corroborate(
        findings=findings,
        incident_summary=incident.summary,
        injury_observed=incident.injury_observed or False,
        police_called=incident.police_called or False,
        ems_called=incident.ems_called or False,
    )

    prior_packet = session.exec(
        select(UnderwritingPacket)
        .where(UnderwritingPacket.incident_id == incident_id)
        .order_by(UnderwritingPacket.generated_at.desc())
    ).first()

    if not prior_packet:
        return

    occurred_iso = (
        incident.occurred_at
        if isinstance(incident.occurred_at, str)
        else incident.occurred_at.isoformat()
    )
    incident_payload = IncidentCreate(
        occurred_at=occurred_iso,
        location=incident.location,
        summary=incident.summary,
        reported_by=incident.reported_by,
        injury_observed=incident.injury_observed or False,
        police_called=incident.police_called or False,
        ems_called=incident.ems_called or False,
    )

    new_packet = regenerate_packet_with_corroboration(
        session=session,
        prior_packet=prior_packet,
        incident=incident_payload,
        corroboration_summary=result.summary,
        corroboration_status=result.status,
        corroboration_flags=result.flags,
        confidence_adjustment=result.confidence_adjustment,
        evidence_analysis_ids=[a.id for a in analyses],
    )
    print(
        f"[VISION] Packet v2 {new_packet.id} (parent {prior_packet.id}) — "
        f"corroboration: {result.status}"
    )


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


# Above incident routes moved to app.api.v1.incidents (Phase B).


# Packet routes (GET /api/incidents/{id}/packets, GET /api/packets/{id})
# moved to app.api.v1.packets.


@app.post("/api/venues/{venue_id}/policy-docs", status_code=201)
def ingest_policy_doc(
    venue_id: str,
    payload: dict,
    session: Session = Depends(get_session),
    _: None = Depends(require_broker),
) -> dict:
    """Ingest a markdown policy document for this venue.

    Builds a PageIndex-style hierarchical tree (regex fallback in Phase 1) and
    persists:
      * one PolicyDocument row with the full tree_json (source for deep retrieve
        + citation rendering)
      * N SourceRecord leaf rows (one per clause) with source_metadata enriched
        with doc_id / node_id / page_start / page_end / path — the retrieval
        layer reads these and surfaces them in Citation objects.

    Idempotent at both layers: the PolicyDocument id is a hash of the full input
    text, and SourceRecord ids are hashes of leaf content. Re-uploading the same
    text returns the existing doc_id and 0 newly-inserted chunks.
    """
    import hashlib
    _resolve_venue(venue_id, session)
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="`text` (markdown body) is required")
    source_file = payload.get("source_file", "uploaded_policy.md")

    tree_json, leaves = build_policy_tree(text=text, source_file=source_file)
    if not leaves:
        raise HTTPException(
            status_code=400,
            detail="No chunks extracted. Policy must use '## Section' / '### Clause' headings.",
        )

    # Deterministic doc_id over (venue, source_file, text) — re-upload of the
    # same content returns the same PolicyDocument row.
    doc_hash_input = f"{venue_id}|{source_file}|{text}".encode("utf-8")
    doc_id = f"policy-{hashlib.sha256(doc_hash_input).hexdigest()[:16]}"

    existing_doc = session.get(PolicyDocument, doc_id)
    if existing_doc is None:
        session.add(PolicyDocument(
            id=doc_id,
            venue_id=venue_id,
            source_file=source_file,
            content_type="text/markdown",
            page_count=len(leaves),  # synthesized: 1 page per leaf in regex mode
            tree_json=tree_json,
            status="ready",
        ))

    inserted_ids: list[str] = []
    for chunk in leaves:
        content = chunk["content"]
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        source_id = f"ingested-{content_hash[:16]}"
        if session.get(SourceRecord, source_id):
            continue
        meta = dict(chunk.get("metadata", {}))
        meta["doc_id"] = doc_id  # back-reference into PolicyDocument
        source_type = "policy_exclusion" if meta.get("is_exclusion") else "policy"
        session.add(SourceRecord(
            id=source_id,
            venue_id=venue_id,
            source_type=source_type,
            origin_system=INGESTED_ORIGIN,
            external_ref=source_file,
            excerpt=content[:2000],
            content_hash=content_hash,
            source_metadata=meta,
        ))
        inserted_ids.append(source_id)

    session.commit()
    return {
        "venue_id": venue_id,
        "doc_id": doc_id,
        "chunks_extracted": len(leaves),
        "chunks_inserted": len(inserted_ids),
        "source_ids": inserted_ids,
    }


@app.get("/api/venues/{venue_id}/sources")
def list_venue_sources(venue_id: str, session: Session = Depends(get_session)) -> list[dict]:
    """Source registry — all evidence sources for a venue."""
    _resolve_venue(venue_id, session)
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


# Review-decision route moved to app.api.v1.packets.


@app.post("/api/packets/{packet_id}/claim-proposal", status_code=201)
def create_claim_proposal_route(
    packet_id: str,
    payload: ClaimProposalCreate,
    session: Session = Depends(get_session),
) -> dict:
    """Operator proposes a claim against a packet.

    Mirrors `/review-decisions`: the actor ID rides in the body, no token gate.
    The UI enforces who-can-do-what; the validation in `claim_proposals` is the
    only contract-level guarantee (override requires reason, etc.).
    """
    try:
        proposal = create_claim_proposal(
            session=session,
            packet_id=packet_id,
            operator_id=payload.operator_id,
            override_recommendation=payload.override_recommendation,
            override_reason=payload.override_reason,
            override_freetext=payload.override_freetext,
        )
    except ClaimProposalValidationError as error:
        message = str(error)
        # "Packet not found" is the one shape that maps to 404; the rest are
        # 400-class input problems.
        status = 404 if "Packet not found" in message else 400
        raise HTTPException(status_code=status, detail=message) from error
    return _claim_proposal_to_dict(proposal)


@app.post("/api/claim-proposals/{proposal_id}/broker-decision")
def broker_decision_on_proposal(
    proposal_id: str,
    payload: BrokerDecisionCreate,
    session: Session = Depends(get_session),
) -> dict:
    """Broker approves or rejects a pending operator proposal."""
    try:
        proposal = record_claim_broker_decision(
            session=session,
            proposal_id=proposal_id,
            broker_id=payload.broker_id,
            decision=payload.decision,
            notes=payload.notes,
        )
    except ClaimProposalValidationError as error:
        message = str(error)
        status = 404 if "Proposal not found" in message else 400
        raise HTTPException(status_code=status, detail=message) from error
    return _claim_proposal_to_dict(proposal)


@app.get("/api/claim-proposals")
def list_claim_proposals(
    venue_id: str | None = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """Cross-venue claim-proposal list.

    No role gate at the route level — the frontend filters by the logged-in
    user's tenant for operators, and shows the full list for brokers. The
    optional `venue_id` query param exists so an operator's portfolio call can
    scope server-side once an auth layer lands.
    """
    statement = select(ClaimProposal).order_by(ClaimProposal.proposed_at.desc())
    if venue_id:
        statement = statement.where(ClaimProposal.venue_id == venue_id)
    proposals = session.exec(statement).all()
    return [_claim_proposal_to_dict(p) for p in proposals]


@app.get("/api/claim-proposals/by-packet/{packet_id}")
def get_claim_for_packet(packet_id: str, session: Session = Depends(get_session)) -> dict:
    """Return the latest claim proposal for a packet, or 404 if none exists."""
    proposal = session.exec(
        select(ClaimProposal)
        .where(ClaimProposal.packet_id == packet_id)
        .order_by(ClaimProposal.proposed_at.desc())
    ).first()
    if proposal is None:
        raise HTTPException(status_code=404, detail="No claim proposal for this packet")
    return _claim_proposal_to_dict(proposal)


@app.get("/api/override-stats")
def get_cross_venue_override_stats(session: Session = Depends(get_session)) -> dict:
    """Cross-venue override-accuracy aggregates.

    The broker's portfolio view of "how well-calibrated are operator overrides
    across all my venues?" Empty DB returns the same shape with zeros and
    None rates — contract stable so the frontend can render unconditionally.
    """
    stats = compute_override_stats(session=session)
    return override_stats_to_dict(stats)


@app.get("/api/venues/{venue_id}/override-stats")
def get_venue_override_stats(venue_id: str, session: Session = Depends(get_session)) -> dict:
    """Per-venue override-accuracy aggregates.

    `_resolve_venue` runs first — unknown venue is a hard 404, matching the
    pattern of /api/venues/{venue_id}/risk-score etc. Empty stats for a
    valid venue still return 200 with the zero-shape.
    """
    _resolve_venue(venue_id, session)
    stats = compute_override_stats(session=session, venue_id=venue_id)
    return override_stats_to_dict(stats)


# GET /api/packets and /api/packets/{id}/audit-events moved to
# app.api.v1.packets.


def simulate_event_queue(venue_id: str, events: list[StreamEvent], venue_data: dict):
    time.sleep(0.5)
    live_state_manager.process_events(venue_id, events, venue_data)
    print(f"[QUEUE WORKER] Processed {len(events)} events for venue {venue_id}")


@app.post("/api/venues/{venue_id}/events/stream", status_code=202)
def ingest_event_stream(venue_id: str, events: list[StreamEvent], background_tasks: BackgroundTasks, session: Session = Depends(get_session)):
    """High-volume ingestion — accepts immediately, processes asynchronously."""
    venue_data = _resolve_venue(venue_id, session)
    background_tasks.add_task(simulate_event_queue, venue_id, events, venue_data)
    return {"status": "accepted", "message": f"Queued {len(events)} events for asynchronous processing"}


@app.post("/api/venues/{venue_id}/events/inject")
def inject_event_sync(venue_id: str, events: list[StreamEvent], session: Session = Depends(get_session)):
    """Demo endpoint — synchronously processes events so the UI can refresh immediately."""
    venue_data = _resolve_venue(venue_id, session)
    live_state_manager.process_events(venue_id, events, venue_data)
    live = live_state_manager.get_state(venue_id, venue_data["capacity"], venue_data)
    return {
        "status": "processed",
        "events_count": len(events),
        "compliance_queue_length": len(live.compliance_queue),
    }


def _packet_to_dict(packet: UnderwritingPacket, session: Session | None = None) -> dict:
    incident_payload: dict = {}
    venue_prior_claims = 0
    latest_proposal: ClaimProposal | None = None
    if session is not None:
        incident = session.get(IncidentRecord, packet.incident_id)
        if incident is not None:
            incident_payload = {
                "injury_observed": incident.injury_observed or False,
                "police_called": incident.police_called or False,
                "ems_called": incident.ems_called or False,
            }
        # Per-packet latest proposal — frontend uses this to render the state
        # badge + action row without a second round-trip. Order by proposed_at
        # desc so a re-proposal (if we ever allow it) returns the newest.
        latest_proposal = session.exec(
            select(ClaimProposal)
            .where(ClaimProposal.packet_id == packet.id)
            .order_by(ClaimProposal.proposed_at.desc())
        ).first()
        # Placeholder for venue claim history once Claims is built — for now 0.
        # Wired through so the recommender's signature is stable when real data lands.
    recommendation = recommend_claim_filing(
        risk_signal=packet.risk_signals or {},
        incident=incident_payload,
        venue_prior_claim_count=venue_prior_claims,
    )
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
        "claim_recommendation": recommendation_to_dict(recommendation),
        "claim_proposal": _claim_proposal_to_dict(latest_proposal) if latest_proposal else None,
    }


def _claim_proposal_to_dict(proposal: ClaimProposal) -> dict:
    return {
        "id": proposal.id,
        "packet_id": proposal.packet_id,
        "venue_id": proposal.venue_id,
        "proposed_by": proposal.proposed_by,
        "proposed_at": proposal.proposed_at.isoformat(),
        "override_recommendation": proposal.override_recommendation,
        "override_reason": proposal.override_reason,
        "override_freetext": proposal.override_freetext,
        "state": proposal.state,
        "broker_decided_by": proposal.broker_decided_by,
        "broker_decided_at": proposal.broker_decided_at.isoformat() if proposal.broker_decided_at else None,
        "broker_notes": proposal.broker_notes,
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
def get_live_state(
    venue_id: str,
    session: Session = Depends(get_session),
    user: dict | None = Depends(current_user_optional),
) -> LiveVenueState:
    venue = _resolve_venue(venue_id, session)
    state = live_state_manager.get_state(venue_id, venue["capacity"], venue)
    # Floor telemetry (live capacity + infrastructure) is operator-only. Brokers
    # and anonymous callers get summary fields (compliance_queue, premium_impact)
    # with floor data zeroed out — keeps broker compliance views working without
    # leaking the operator's live shift state.
    if not can_read_venue_floor(user, venue_id, session):
        state = state.model_copy(update={
            "current_capacity": 0,
            "infrastructure": [],
        })
    return state


@app.get("/api/venues/{venue_id}/risk-score")
def get_venue_risk_score(venue_id: str, session: Session = Depends(get_session)) -> dict:
    _resolve_venue(venue_id, session)
    return get_risk_score(venue_id, VENUES, session=session, live_state_manager=live_state_manager)


@app.get("/api/venues/{venue_id}/quote")
def get_venue_quote(venue_id: str, session: Session = Depends(get_session)) -> dict:
    _resolve_venue(venue_id, session)
    return get_premium_quote(venue_id, VENUES, session=session, live_state_manager=live_state_manager)


COMPLIANCE_EVIDENCE_MAX_BYTES = 20 * 1024 * 1024  # 20MB


def _predict_evidence_citation(venue_id: str, item_description: str, session: Session):
    """Top TF-IDF citation for a compliance item description.

    Used both to stamp `cited_*` on a ComplianceEvidence row at upload time and
    to power the citation chip the FE renders before upload. Returns `None`
    when there's nothing to cite (no ingested policy docs yet).
    """
    if not item_description:
        return None
    sources = load_knowledge_sources_for_venue(session, venue_id)
    kb = SemanticKnowledgeBase(sources, stream_events=[])
    hits = kb.retrieve(venue_id, item_description, limit=1)
    return hits[0] if hits else None


def _find_compliance_item(venue_id: str, venue: dict, item_id: str):
    """Pull a ComplianceItem out of the LiveVenueState's queue by id."""
    state = live_state_manager.get_state(venue_id, venue["capacity"], venue)
    for q in state.compliance_queue:
        if q.id == item_id:
            return q
    return None


@app.get("/api/venues/{venue_id}/compliance/{item_id}/citation")
def predict_compliance_citation(
    venue_id: str,
    item_id: str,
    session: Session = Depends(get_session),
) -> dict:
    """Predict the policy clause this compliance item maps to.

    Returns `{citation: null}` when no policy doc is ingested yet or the item
    is unknown — the FE chip stays hidden in that case.
    """
    venue = _resolve_venue(venue_id, session)
    item = _find_compliance_item(venue_id, venue, item_id)
    if item is None:
        return {"citation": None}
    hit = _predict_evidence_citation(venue_id, item.description, session)
    return {"citation": hit.model_dump() if hit else None}


@app.post("/api/venues/{venue_id}/compliance/{item_id}/upload")
async def upload_compliance_evidence(
    venue_id: str,
    item_id: str,
    file: UploadFile = File(...),
    uploaded_by: str = "operator",
    session: Session = Depends(get_session),
) -> dict:
    """Persist the uploaded file and link it to (venue_id, compliance_item_id).

    Previously this endpoint accepted the file and discarded it before resolving
    the item — operator-friendly UX, but the audit trail was a lie. Now the file
    lands on disk and a ComplianceEvidence row records the linkage. The
    auto-resolve behavior is preserved for backwards compatibility; broker
    validation gating is a separate fix.
    """
    from uuid import uuid4
    venue = _resolve_venue(venue_id, session)

    contents = await file.read()
    if len(contents) > COMPLIANCE_EVIDENCE_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum size for compliance evidence is "
                   f"{COMPLIANCE_EVIDENCE_MAX_BYTES // (1024 * 1024)}MB.",
        )

    # Look up the citation BEFORE resolve_compliance_item runs (which removes
    # the item from the live queue). Best-effort: missing item or missing
    # policy docs just leaves the cited_* columns null.
    item = _find_compliance_item(venue_id, venue, item_id)
    citation = _predict_evidence_citation(venue_id, item.description, session) if item else None

    evidence_id = f"ce-{uuid4().hex[:12]}"
    safe_name = f"{evidence_id}_{file.filename or 'upload'}"
    dest = EVIDENCE_DIR / safe_name
    dest.write_bytes(contents)

    record = ComplianceEvidence(
        id=evidence_id,
        venue_id=venue_id,
        compliance_item_id=item_id,
        filename=file.filename or "upload",
        content_type=file.content_type or "application/octet-stream",
        file_path=str(dest),
        file_size=len(contents),
        uploaded_by=uploaded_by,
        cited_source_id=citation.source_id if citation else None,
        cited_doc_id=citation.doc_id if citation else None,
        cited_node_id=citation.node_id if citation else None,
        cited_page_start=citation.page_start if citation else None,
        cited_page_end=citation.page_end if citation else None,
    )
    session.add(record)
    session.commit()

    # Preserve existing auto-resolve behavior — broker validation gate is #2 in the queue.
    live_state_manager.resolve_compliance_item(venue_id, item_id)

    return {
        "status": "accepted",
        "evidence_id": evidence_id,
        "item_id": item_id,
        "filename": record.filename,
        "file_size": record.file_size,
        "uploaded_at": record.uploaded_at.isoformat(),
        "citation": citation.model_dump() if citation else None,
    }


@app.get("/api/venues/{venue_id}/compliance/{item_id}/evidence")
def list_compliance_evidence(venue_id: str, item_id: str, session: Session = Depends(get_session)) -> list[dict]:
    """Return all persisted evidence files for a compliance item (audit-trail readout)."""
    _resolve_venue(venue_id, session)
    rows = session.exec(
        select(ComplianceEvidence)
        .where(ComplianceEvidence.venue_id == venue_id)
        .where(ComplianceEvidence.compliance_item_id == item_id)
        .order_by(ComplianceEvidence.uploaded_at)
    ).all()
    return [
        {
            "id": r.id,
            "filename": r.filename,
            "content_type": r.content_type,
            "file_size": r.file_size,
            "uploaded_by": r.uploaded_by,
            "uploaded_at": r.uploaded_at.isoformat(),
        }
        for r in rows
    ]

