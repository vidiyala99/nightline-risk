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
