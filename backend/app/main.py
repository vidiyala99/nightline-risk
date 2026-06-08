from app.fastapi_compat import patch_starlette_router_for_fastapi

patch_starlette_router_for_fastapi()

import os  # noqa: E402
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
from app.agents.runtime import UnderwritingPacketAgentRuntime  # noqa: E402
from app.providers import DeterministicProvider, DeterministicRiskClassifier  # noqa: E402
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

    # Bulk backfill ALWAYS uses the deterministic provider, never the configured
    # LLM. With ~50 seeded incidents this loop would otherwise fire 100+ Gemini
    # calls in seconds — instantly tripping the free-tier RPM cap (10-15/min) and
    # silently falling back anyway. Live incident creation
    # (create_brawl_incident_flow) still uses the configured provider, so a
    # freshly submitted incident exercises the real LLM path in a demo.
    det_runtime = UnderwritingPacketAgentRuntime(
        memo_provider=DeterministicProvider(),
        risk_classifier=DeterministicRiskClassifier(),
    )

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
            result = det_runtime.execute(
                venue_id=record.venue_id,
                venue=venue,
                incident=payload,
                knowledge_sources=load_knowledge_sources_for_venue(session, record.venue_id),
                stream_events=STREAM_EVENTS,
            )
            packet = create_packet_snapshot(
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
            # Auto-route the same way the live incident-create flow does, so a
            # broker opening a seeded high-confidence "file" incident gets an
            # actionable ClaimProposal (not just a recommendation with nothing to
            # act on). Idempotent; borderline/no-file incidents create nothing.
            from app.claim_routing import maybe_auto_route_incident
            maybe_auto_route_incident(
                session, packet=packet, operator_id=record.reported_by or "operator"
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


def _backfill_missing_proposals(session: Session) -> None:
    """Self-heal: auto-route any existing packet whose recommendation says
    'file' at high confidence but which has no ClaimProposal yet.

    `_backfill_incident_packets` only auto-routes incidents it *freshly* packets
    (it skips any incident that already has a packet). So packets created before
    auto-routing shipped — e.g. prod rows from an earlier deploy — never get
    their proposal, and the broker inbox silently misses them while the operator
    sees the claim 'sent' nowhere. This pass closes that gap on every boot.

    Idempotent and gated: maybe_auto_route_incident skips a packet that already
    has a proposal and creates nothing for borderline / not-routed packets, so
    re-running is a no-op. No LLM cost — the recommendation is deterministic.
    """
    import logging
    log = logging.getLogger("backfill")
    from app.claim_routing import maybe_auto_route_incident

    # Pre-filter to proposal-less packets so the common (already-routed) case
    # never recomputes a recommendation.
    proposed_packet_ids = set(session.exec(select(ClaimProposal.packet_id)).all())
    pending = [
        pkt for pkt in session.exec(select(UnderwritingPacket)).all()
        if pkt.id not in proposed_packet_ids
    ]
    if not pending:
        return

    healed = 0
    for pkt in pending:
        try:
            incident = session.get(IncidentRecord, pkt.incident_id)
            operator_id = (incident.reported_by if incident else None) or "auto-router"
            maybe_auto_route_incident(session, packet=pkt, operator_id=operator_id)
            created = session.exec(
                select(ClaimProposal).where(ClaimProposal.packet_id == pkt.id)
            ).first()
            if created is not None:
                session.commit()
                healed += 1
            else:
                # borderline / not-routed — nothing created, drop any pending state
                session.rollback()
        except Exception as exc:  # one bad row must not sink the rest
            session.rollback()
            log.warning("Proposal self-heal skipped %s: %s: %s", pkt.id, exc.__class__.__name__, exc)
    if healed:
        log.info("Proposal self-heal: created %d missing auto-routed proposal(s).", healed)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.config import validate_startup_env
    validate_startup_env()  # fail fast on a misconfigured prod boot (e.g. no APP_SECRET)

    create_db_and_tables()

    # Column-level ALTER migrations now live in app.database.create_db_and_tables
    # so they run on every session bootstrap, not only the FastAPI lifespan path.

    import json as _json
    from app.auth import DEMO_USERS
    import app.auth as _auth

    with next(get_session()) as session:
        # Seed venues with full data
        for venue_id, venue_data in VENUES.items():
            existing = session.get(Venue, venue_id)
            if not existing:
                session.add(Venue(id=venue_id, name=venue_data.get("name", venue_id), venue_data=_json.dumps(venue_data)))
            elif not existing.venue_data:
                existing.venue_data = _json.dumps(venue_data)
                session.add(existing)
        session.commit()

        # Seed broker-platform reference data (Carrier + CoverageLine).
        # Idempotent — inserts missing rows by id, leaves existing rows alone.
        from app.seed_carriers import seed_broker_platform_data
        seed_broker_platform_data(session)
        session.commit()

        # Seed demo users (self-healing + idempotent). On a long-running DB
        # (Railway/Neon) this keeps existing rows in sync with DEMO_USERS —
        # email (e.g. the 2026-05-21 broker rename), role, and password — so a
        # newly-added persona whose id was previously claimed by a real
        # registration is repaired into a working login rather than 401-ing.
        # Shared with scripts/seed_demo_users.py (single source of truth).
        from app.seed_users import seed_demo_users
        seed_demo_users(session)

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
        rehydrated = 0
        for v in db_venues:
            if v.id not in VENUES and v.venue_data:
                try:
                    from app.services.coverage_profile import overlay_profile_columns
                    data = _json.loads(v.venue_data)
                    # The `name` column is authoritative; venue_data may predate it
                    # or (in tests) omit it. Then overlay the onboarding columns so
                    # a rehydrated venue is consistent with a freshly-resolved one.
                    data.setdefault("name", v.name)
                    overlay_profile_columns(data, v)
                    VENUES[v.id] = data
                    rehydrated += 1
                except Exception:
                    pass
        if rehydrated:
            print(f"[REHYDRATE] Loaded {rehydrated} venue(s) from DB.")
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
        # Self-heal: auto-route any packet that predates the auto-router (created
        # by an earlier deploy) so high-confidence 'file' incidents reach the
        # broker inbox retroactively — not just freshly-packeted ones.
        _backfill_missing_proposals(session)

    # Seed real-NYC prospect venues on boot (idempotent — skips if already
    # present) so a deploy auto-populates them; no manual railway step needed.
    # Manages its own session; failures are non-fatal (e.g. snapshot missing).
    try:
        from scripts.seed_prospects import seed_prospects
        seed_prospects()
    except Exception as e:  # pragma: no cover - defensive startup guard
        print(f"[SEED] prospect seed skipped: {e}")

    # Seed ingestion run history on a fresh DB so the /ingestion page shows real
    # connector runs + quality-gate stats (and moves venue scores via the
    # rollup). Idempotent: only seeds when there are no runs yet. Non-fatal.
    # Skipped under pytest: the rollup mutates the in-memory VENUES scores, which
    # would shift baselines that the score/pricing characterization tests pin
    # (those tests exercise the runner directly with their own fixtures).
    if not os.getenv("PYTEST_CURRENT_TEST"):
        try:
            from sqlmodel import select as _select
            from app.ingestion.runner import run as _seed_ingest
            from app.models import IngestionRun as _IngestionRun
            with next(get_session()) as _s:
                if _s.exec(_select(_IngestionRun).limit(1)).first() is None:
                    runs = _seed_ingest("all", _s, venues=VENUES)
                    print(f"[SEED] ingestion seeded: {len(runs)} run(s).")
        except Exception as e:  # pragma: no cover - defensive startup guard
            print(f"[SEED] ingestion seed skipped: {e}")

    # Opt-in in-process ingestion tick for the live demo. Off in prod unless
    # INGEST_TICK_SECONDS is set; prod-realistic scheduling uses the CLI
    # (scripts.run_ingest) on a Railway cron instead.
    ingest_task = None
    _tick_seconds = os.getenv("INGEST_TICK_SECONDS")
    if _tick_seconds:
        import asyncio as _asyncio

        async def _ingest_tick(interval: float):  # pragma: no cover - background loop
            from app.database import engine as _engine
            from app.ingestion.runner import run as _run
            from sqlmodel import Session as _Session
            while True:
                await _asyncio.sleep(interval)
                try:
                    with _Session(_engine) as _s:
                        await _asyncio.to_thread(_run, "pos", _s, VENUES)
                except Exception as exc:
                    print(f"[INGEST] tick failed: {exc}")

        try:
            ingest_task = _asyncio.create_task(_ingest_tick(float(_tick_seconds)))
            print(f"[INGEST] in-process tick enabled every {_tick_seconds}s")
        except ValueError:
            print(f"[INGEST] ignoring invalid INGEST_TICK_SECONDS={_tick_seconds!r}")

    yield

    if ingest_task is not None:  # pragma: no cover - shutdown path
        ingest_task.cancel()

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

from app.api.v1.claim_proposals import router as claim_proposals_router  # noqa: E402
app.include_router(claim_proposals_router, prefix="/api", tags=["claim-proposals"])

from app.api.v1.evidence import router as evidence_router  # noqa: E402
app.include_router(evidence_router, prefix="/api", tags=["evidence"])

from app.api.v1.policy_docs import router as policy_docs_router  # noqa: E402
app.include_router(policy_docs_router, prefix="/api", tags=["policy-docs"])

from app.api.v1.operations import router as operations_router  # noqa: E402
app.include_router(operations_router, prefix="/api", tags=["operations"])

from app.api.v1.compliance import router as compliance_router  # noqa: E402
app.include_router(compliance_router, prefix="/api", tags=["compliance"])

from app.api.v1.renewals import router as renewals_router  # noqa: E402
app.include_router(renewals_router, prefix="/api", tags=["renewals"])

from app.api.v1.policy_requests import router as policy_requests_router  # noqa: E402
app.include_router(policy_requests_router, prefix="/api", tags=["policy-requests"])

from app.api.v1.tasks import router as tasks_router  # noqa: E402
app.include_router(tasks_router, prefix="/api", tags=["tasks"])

from app.api.v1.ingestion_runs import router as ingestion_runs_router  # noqa: E402
app.include_router(ingestion_runs_router, prefix="/api", tags=["ingestion-runs"])

from app.api.v1.alerts import router as alerts_router  # noqa: E402
app.include_router(alerts_router, prefix="/api", tags=["alerts"])

from app.api.v1.book import router as book_router  # noqa: E402
app.include_router(book_router, prefix="/api", tags=["book"])

from app.api.v1.loss_run import router as loss_run_router  # noqa: E402
app.include_router(loss_run_router, prefix="/api", tags=["loss-run"])

from app.api.v1.underwriting import router as underwriting_router  # noqa: E402
app.include_router(underwriting_router, prefix="/api", tags=["underwriting"])

from app.api.v1.adjusting import router as adjusting_router  # noqa: E402
app.include_router(adjusting_router, prefix="/api", tags=["adjusting"])

from app.api.v1.staff import router as staff_router  # noqa: E402
app.include_router(staff_router, prefix="/api", tags=["staff"])

from app.api.v1.comms import router as comms_router  # noqa: E402
app.include_router(comms_router, prefix="/api", tags=["comms"])

from app.api.v1.surplus_lines import router as surplus_lines_router  # noqa: E402
app.include_router(surplus_lines_router, prefix="/api", tags=["surplus-lines"])

from app.api.v1.intelligence import router as intelligence_router  # noqa: E402
app.include_router(intelligence_router, prefix="/api", tags=["intelligence"])

# CORS origins. Standard local web dev (localhost + 127.0.0.1 are distinct
# origins to a browser) + Expo mobile dev + prod. Machine-specific origins — a
# LAN IP for a phone on the same wifi, or a local verify server on another port —
# go in EXTRA_CORS_ORIGINS (comma-separated) so we never edit source for a one-off.
_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://nightline-app.vercel.app",
    "exp://localhost:8081",
    "exp://127.0.0.1:8081",
    *[o.strip() for o in os.getenv("EXTRA_CORS_ORIGINS", "").split(",") if o.strip()],
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
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

    # Re-score fraud now that corroboration evidence exists (v2). Advisory and
    # best-effort: a scoring fault must not break the vision pipeline. The
    # corroboration packet is ALREADY committed by regenerate_packet_with_corroboration
    # above, so the commit/rollback below only affects this fraud_signal mutation —
    # a re-score failure can never discard the corroboration packet.
    try:
        from app.claim_routing import fraud_signal_for_packet
        from app.packet_core import _add_audit_event

        fraud = fraud_signal_for_packet(
            session, new_packet,
            corroboration_status=result.status,
            corroboration_flags=result.flags,
        )
        new_packet.fraud_signal = fraud.to_dict()
        session.add(new_packet)
        if fraud.tier == "high":
            # Idempotent: only flag the first time this incident reaches high
            # fraud risk (a prior v1 hold or v2 flag means it's already known).
            already_flagged = session.exec(
                select(AuditEvent)
                .where(AuditEvent.entity_id == incident_id)
                .where(AuditEvent.event_type.in_(("fraud.hold", "fraud.flagged")))  # type: ignore[attr-defined]
            ).first()
            if already_flagged is None:
                _add_audit_event(
                    session=session, actor_id="vision-pipeline", actor_type="system",
                    entity_type="incident", entity_id=incident_id,
                    event_type="fraud.flagged",
                    event_metadata={"packet_id": new_packet.id, "score": fraud.score,
                                    "flags": [f.code for f in fraud.red_flags]},
                )
        session.commit()
    except Exception as exc:  # noqa: BLE001 - advisory re-score, never break vision flow
        print(f"[FRAUD] v2 re-score failed for incident {incident_id}: {exc}")
        session.rollback()


# Evidence routes (upload, list, evidence-analysis, serve) moved to
# app.api.v1.evidence.


# Above incident routes moved to app.api.v1.incidents (Phase B).


# Packet routes (GET /api/incidents/{id}/packets, GET /api/packets/{id})
# moved to app.api.v1.packets.


# Policy-docs ingest + sources list moved to app.api.v1.policy_docs.


# Review-decision route moved to app.api.v1.packets.


# ClaimProposal + override-stats routes moved to
# app.api.v1.claim_proposals.


# GET /api/packets and /api/packets/{id}/audit-events moved to
# app.api.v1.packets.


def simulate_event_queue(venue_id: str, events: list[StreamEvent], venue_data: dict):
    time.sleep(0.5)
    live_state_manager.process_events(venue_id, events, venue_data)
    print(f"[QUEUE WORKER] Processed {len(events)} events for venue {venue_id}")


# Stream/inject event routes moved to app.api.v1.operations.


def _packet_to_dict(packet: UnderwritingPacket, session: Session | None = None) -> dict:
    from app.claim_routing import recommendation_for_packet, route_status
    latest_proposal: ClaimProposal | None = None
    if session is not None:
        # Per-packet latest proposal — frontend uses this to render the state
        # badge + action row without a second round-trip. Order by proposed_at
        # desc so a re-proposal (if we ever allow it) returns the newest.
        latest_proposal = session.exec(
            select(ClaimProposal)
            .where(ClaimProposal.packet_id == packet.id)
            .order_by(ClaimProposal.proposed_at.desc())
        ).first()
    if session is not None:
        recommendation = recommendation_for_packet(session, packet)
    else:
        recommendation = recommend_claim_filing(
            risk_signal=packet.risk_signals or {},
            incident={},
            venue_prior_claim_count=0,
        )
    # Operator answers + broker resolves on the memo's open questions, so both
    # personas read the same loop state from a single packet fetch.
    open_question_responses: list[dict] = []
    if session is not None:
        from app.open_questions import list_responses, response_to_dict
        open_question_responses = [
            response_to_dict(r) for r in list_responses(session=session, packet_id=packet.id)
        ]
    # corroboration_flags is a TEXT-migrated JSON column, so on Postgres it can
    # come back as a JSON string (an `or []` guard wouldn't catch that) — coerce
    # at the read boundary. The other JSON fields here are real-JSON columns on
    # fresh tables, which psycopg deserializes correctly (verified against prod).
    from app.defense_package import _as_list
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
        "corroboration_status": packet.corroboration_status,
        "corroboration_flags": _as_list(packet.corroboration_flags),
        "claim_recommendation": recommendation_to_dict(recommendation),
        "routing_status": route_status(recommendation),
        "claim_proposal": _claim_proposal_to_dict(latest_proposal) if latest_proposal else None,
        "open_question_responses": open_question_responses,
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
        "info_requested_by": proposal.info_requested_by,
        "info_requested_at": proposal.info_requested_at.isoformat() if proposal.info_requested_at else None,
        "info_request_note": proposal.info_request_note,
        "operator_response_note": proposal.operator_response_note,
        "operator_responded_at": proposal.operator_responded_at.isoformat() if proposal.operator_responded_at else None,
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


# Live-state / risk-score / quote routes moved to app.api.v1.operations.


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


def _find_compliance_item(venue_id: str, venue: dict, item_id: str, session=None):
    """Resolve a compliance item by id.

    When a session is provided, queries open ComplianceSignal rows first. If
    not found in the DB (e.g. legacy in-memory-only item), falls back to the
    LiveVenueState in-memory queue so citation lookups still work for items
    seeded from venue_data (pre-DB era). Returns None if not found anywhere.
    """
    from app.services.compliance_signals import open_signals_for
    if session is not None:
        for r in open_signals_for(venue_id, session):
            if r.id == item_id:
                return r
        # Fall back to in-memory queue for seed items not yet migrated to DB
        state = live_state_manager.get_state(venue_id, venue["capacity"], venue)
        for q in state.compliance_queue:
            if q.id == item_id:
                return q
        return None
    # No session — in-memory only
    state = live_state_manager.get_state(venue_id, venue["capacity"], venue)
    for q in state.compliance_queue:
        if q.id == item_id:
            return q
    return None


# Compliance citation / upload / evidence routes moved to
# app.api.v1.compliance.

