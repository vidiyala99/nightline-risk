"""Render an UnderwritingPacket into a defense-grade PDF an adjuster or
defense attorney can use against an A&B / liquor-liability claim.

Two layers, split so the content is unit-testable without a PDF parser:
  - build_defense_sections(session, packet_id) -> dict   (pure data assembly)
  - render_defense_pdf(sections) -> bytes                (reportlab layout)

The PDF bundles the chain-of-custody story already in the data model: the
packet snapshot hash (tamper-evidence), incident facts (incl. A&B structured
fields), claims timeline, corroboration verdict, an evidence inventory with
per-file content hashes, cited sources, and the audit-event trail.
"""
from __future__ import annotations

import json
from io import BytesIO

from sqlmodel import Session, select

from app.models import (
    AuditEvent,
    Claim,
    CitationRecord,
    EvidenceAnalysis,
    EvidenceFile,
    IncidentRecord,
    SourceRecord,
    UnderwritingPacket,
)


class DefensePackageError(Exception):
    """Raised when a defense package can't be assembled (e.g. unknown packet)."""


def _as_list(value) -> list:
    """Coerce a JSON list column to a real list. SQLite round-trips these as
    parsed lists, but on Postgres they can come back as a JSON-encoded string —
    in which case `list(value)` would iterate characters. Defensive at the read
    boundary so the renderer never sees a str where it expects list[dict]."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except (ValueError, TypeError):
            return []
    return []


def build_defense_sections(session: Session, packet_id: str) -> dict:
    """Assemble the structured sections of the defense package. Pure data —
    no reportlab. Raises DefensePackageError if the packet doesn't exist."""
    packet = session.get(UnderwritingPacket, packet_id)
    if packet is None:
        raise DefensePackageError(f"Packet {packet_id!r} not found")

    incident = session.get(IncidentRecord, packet.incident_id)
    claim = session.exec(
        select(Claim).where(Claim.defense_package_id == packet_id)
    ).first()

    citations = list(
        session.exec(select(CitationRecord).where(CitationRecord.packet_id == packet_id))
    )
    source_ids = {c.source_id for c in citations}
    sources = {}
    if source_ids:
        sources = {
            s.id: s
            for s in session.exec(select(SourceRecord).where(SourceRecord.id.in_(source_ids)))
        }

    evidence_files: list[EvidenceFile] = []
    analyses: dict[str, EvidenceAnalysis] = {}
    if incident is not None:
        evidence_files = list(
            session.exec(select(EvidenceFile).where(EvidenceFile.incident_id == incident.id))
        )
        analyses = {
            a.evidence_id: a
            for a in session.exec(
                select(EvidenceAnalysis).where(EvidenceAnalysis.incident_id == incident.id)
            )
        }

    audit = list(
        session.exec(
            select(AuditEvent)
            .where(AuditEvent.entity_id == packet_id)
            .order_by(AuditEvent.created_at)
        )
    )

    return {
        "cover": {
            "packet_id": packet.id,
            "venue_id": packet.venue_id,
            "incident_id": packet.incident_id,
            "generated_at": packet.generated_at.isoformat(),
            "snapshot_hash": packet.snapshot_hash,
            "claim_ref": (claim.carrier_claim_number or claim.id) if claim else None,
            "claim_status": claim.status if claim else None,
        },
        "incident": _incident_section(incident),
        "timeline": _as_list(packet.claims_timeline),
        "corroboration": {
            "status": packet.corroboration_status,
            "flags": _as_list(packet.corroboration_flags),
        },
        "evidence": [
            {
                "filename": e.filename,
                "content_type": e.content_type,
                "content_hash": e.content_hash,
                "captured_at": e.captured_at,
                "uploaded_by": e.uploaded_by,
                "file_size": e.file_size,
                "analysis": (
                    {
                        "corroboration": analyses[e.id].corroboration,
                        "raw_description": analyses[e.id].raw_description,
                    }
                    if e.id in analyses
                    else None
                ),
            }
            for e in evidence_files
        ],
        "citations": [
            {
                "claim_id": c.claim_id,
                "excerpt": c.excerpt,
                "validation_status": c.validation_status,
                "source_type": c.citation_type,
                "source_id": c.source_id,
                "source_content_hash": (
                    sources[c.source_id].content_hash if c.source_id in sources else None
                ),
            }
            for c in citations
        ],
        "audit": [
            {
                "event_type": a.event_type,
                "actor_id": a.actor_id,
                "actor_type": a.actor_type,
                "at": a.created_at.isoformat(),
            }
            for a in audit
        ],
    }


def _incident_section(incident: IncidentRecord | None) -> dict:
    if incident is None:
        return {}
    return {
        "occurred_at": incident.occurred_at,
        "location": incident.location,
        "summary": incident.summary,
        "reported_by": incident.reported_by,
        "injury_observed": incident.injury_observed,
        "police_called": incident.police_called,
        "ems_called": incident.ems_called,
        "incident_category": incident.incident_category,
        "parties": _as_list(incident.parties),
        "witnesses": _as_list(incident.witnesses),
        "security_response": _as_list(incident.security_response),
        "weapon_involved": incident.weapon_involved,
        "refused_service_or_overserved": incident.refused_service_or_overserved,
        "injury_detail": incident.injury_detail,
    }


def render_defense_pdf(sections: dict) -> bytes:
    """Lay the sections out as a defense-grade PDF. Returns the PDF bytes."""
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    styles = getSampleStyleSheet()
    h1, h2, body, mono = styles["Title"], styles["Heading2"], styles["BodyText"], styles["Code"]
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, title="Defense Package")
    flow: list = []

    def line(text: str, style=body):
        flow.append(Paragraph(text, style))

    cover = sections["cover"]
    line("Incident Defense Package", h1)
    line(f"Venue: {cover['venue_id']} &nbsp; Incident: {cover['incident_id']}")
    line(f"Generated: {cover['generated_at']}")
    if cover.get("claim_ref"):
        line(f"Claim: {cover['claim_ref']} ({cover.get('claim_status')})")
    line("Tamper-evidence — SHA-256 of the packet body; verify the packet against this hash:")
    line(cover["snapshot_hash"], mono)
    flow.append(Spacer(1, 12))

    inc = sections.get("incident") or {}
    if inc:
        line("Incident Facts", h2)
        for k in ("occurred_at", "location", "incident_category", "summary", "injury_detail"):
            if inc.get(k):
                line(f"<b>{k.replace('_', ' ').title()}:</b> {inc[k]}")
        line(f"<b>Injury observed:</b> {inc.get('injury_observed')} &nbsp; "
             f"<b>Police:</b> {inc.get('police_called')} &nbsp; "
             f"<b>EMS:</b> {inc.get('ems_called')} &nbsp; "
             f"<b>Weapon:</b> {inc.get('weapon_involved')}")
        if inc.get("refused_service_or_overserved"):
            line(f"<b>Service note (dram-shop):</b> {inc['refused_service_or_overserved']}")
        for p in inc.get("parties") or []:
            line(f"&bull; Party [{p.get('role', '?')}]: {p.get('description', '')}")
        for w in inc.get("witnesses") or []:
            line(f"&bull; Witness: {w.get('name_or_role', '')} — {w.get('statement', '')}")
        for r in inc.get("security_response") or []:
            line(f"&bull; Response @ {r.get('at', '?')}: {r.get('action', '')}")
        flow.append(Spacer(1, 12))

    if sections.get("timeline"):
        line("Claims Timeline", h2)
        for ev in sections["timeline"]:
            line(f"{ev.get('at', '?')} — {ev.get('label', '')} <i>({ev.get('source', '')})</i>")
        flow.append(Spacer(1, 12))

    corr = sections.get("corroboration") or {}
    if corr.get("status"):
        line("Evidence Corroboration", h2)
        line(f"<b>Verdict:</b> {corr['status']}")
        for f in corr.get("flags") or []:
            line(f"&bull; {f}")
        flow.append(Spacer(1, 12))

    line("Evidence Inventory", h2)
    if sections.get("evidence"):
        for e in sections["evidence"]:
            line(f"<b>{e['filename']}</b> ({e['content_type']}, {e['file_size']} bytes) — "
                 f"captured {e.get('captured_at')}, by {e.get('uploaded_by')}")
            line(f"SHA-256: {e.get('content_hash')}", mono)
            if e.get("analysis"):
                line(f"Vision: {e['analysis'].get('corroboration')} — "
                     f"{e['analysis'].get('raw_description') or ''}")
    else:
        line("No evidence files recorded.")
    flow.append(Spacer(1, 12))

    line("Cited Sources", h2)
    if sections.get("citations"):
        for c in sections["citations"]:
            line(f"[{c.get('validation_status')}] {c.get('source_type')} ({c.get('source_id')}): "
                 f"&ldquo;{c.get('excerpt')}&rdquo;")
    else:
        line("No citations recorded.")
    flow.append(Spacer(1, 12))

    line("Audit Trail (chain of custody)", h2)
    for a in sections.get("audit") or []:
        line(f"{a.get('at')} — {a.get('event_type')} by {a.get('actor_id')} ({a.get('actor_type')})")

    doc.build(flow)
    return buf.getvalue()
