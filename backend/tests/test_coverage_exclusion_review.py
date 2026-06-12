"""review_policy_exclusions: the consumer that joins a venue's real loss
exposure to its ingested policy *exclusion* clauses, returning cited matches.
The whole point is to fire ONLY when an exclusion bites on a loss the venue
actually has — and to abstain (no false coverage alarms) otherwise."""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlmodel import SQLModel, Session, create_engine

import app.models  # noqa: F401
from app.models import IncidentRecord, Policy, SourceRecord
from app.knowledge_sources import INGESTED_ORIGIN
from app.coverage.exclusion_review import review_policy_exclusions, ExclusionMatch


def _fresh_session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def _policy(venue_id: str = "v1") -> Policy:
    return Policy(
        id="pol-1", submission_id="s1", bound_quote_id="q1", venue_id=venue_id,
        carrier_id="c1", status="active",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("0"), commission_amount=Decimal("0"),
        commission_rate=Decimal("0"), coverage_lines=["gl"],
    )


def _incident(iid: str, venue_id: str, summary: str, category: str | None = None) -> IncidentRecord:
    return IncidentRecord(
        id=iid, venue_id=venue_id, occurred_at="2026-05-01", location="x",
        summary=summary, reported_by="s", injury_observed=False,
        police_called=False, ems_called=False, incident_category=category,
        status="open",
    )


def _exclusion_clause(sid: str, venue_id: str, text: str, node_id: str) -> SourceRecord:
    return SourceRecord(
        id=sid, venue_id=venue_id, source_type="policy_exclusion",
        origin_system=INGESTED_ORIGIN, external_ref="master.md", excerpt=text,
        content_hash=sid, source_metadata={
            "node_id": node_id, "doc_id": "policy-abc", "clause_id": "9.1",
            "page_start": None, "page_end": None, "path": "Exclusions > 9.1",
        },
    )


def test_fires_when_exclusion_bites_on_top_exposure():
    s = _fresh_session()
    s.add(_policy())
    s.add(_incident("inc-1", "v1", "Brawl at the bar"))
    s.add(_incident("inc-2", "v1", "altercation by the door"))
    s.add(_exclusion_clause(
        "ingested-1", "v1",
        "The carrier shall not be liable for any claim arising out of assault and battery.",
        "node-ab",
    ))
    s.commit()

    matches = review_policy_exclusions(s, s.get(Policy, "pol-1"))
    assert len(matches) == 1
    m = matches[0]
    assert isinstance(m, ExclusionMatch)
    assert m.category_key == "assault_battery"
    assert m.exposure_rank == 1
    assert m.citation.node_id == "node-ab"
    assert m.citation.page_start is None  # markdown ingestion — clause-anchored
    assert m.citation.clause_id == "9.1"


def test_abstains_when_exclusion_does_not_match_any_exposure():
    """Firearms exclusion on a venue whose only losses are liquor-related — the
    exclusion is irrelevant to this venue, so no false coverage alarm."""
    s = _fresh_session()
    s.add(_policy())
    s.add(_incident("inc-1", "v1", "Patron over-served and intoxicated"))
    s.add(_exclusion_clause(
        "ingested-1", "v1",
        "Any claim arising from the discharge of any firearm is excluded.",
        "node-gun",
    ))
    s.commit()

    assert review_policy_exclusions(s, s.get(Policy, "pol-1")) == []


def test_abstains_when_no_exclusion_clauses_ingested():
    s = _fresh_session()
    s.add(_policy())
    s.add(_incident("inc-1", "v1", "Brawl at the bar"))
    s.commit()

    assert review_policy_exclusions(s, s.get(Policy, "pol-1")) == []


def test_abstains_when_venue_has_no_incidents():
    """No loss history → no exposure to rank → nothing to flag even if the
    policy excludes things."""
    s = _fresh_session()
    s.add(_policy())
    s.add(_exclusion_clause(
        "ingested-1", "v1",
        "Any claim arising out of assault and battery is excluded.",
        "node-ab",
    ))
    s.commit()

    assert review_policy_exclusions(s, s.get(Policy, "pol-1")) == []


def test_top_exposure_match_sorts_first():
    """A&B is the venue's #1 exposure (2 incidents) and liquor #2 (1). Both are
    excluded — the A&B match must lead."""
    s = _fresh_session()
    s.add(_policy())
    s.add(_incident("inc-1", "v1", "fight at the door"))
    s.add(_incident("inc-2", "v1", "altercation on the floor"))
    s.add(_incident("inc-3", "v1", "intoxicated guest over-served"))
    s.add(_exclusion_clause(
        "ingested-liquor", "v1", "Liquor liability is excluded under this form.", "node-liq",
    ))
    s.add(_exclusion_clause(
        "ingested-ab", "v1", "Assault and battery claims are excluded.", "node-ab",
    ))
    s.commit()

    matches = review_policy_exclusions(s, s.get(Policy, "pol-1"))
    assert [m.category_key for m in matches] == ["assault_battery", "liquor"]
    assert matches[0].exposure_rank == 1
    assert matches[1].exposure_rank == 2


def test_failure_isolated_returns_empty(monkeypatch):
    """Any internal error degrades to [] — a coverage-review hiccup must never
    blank the broker's whole findings panel."""
    s = _fresh_session()
    s.add(_policy())
    s.add(_incident("inc-1", "v1", "Brawl"))
    s.commit()

    monkeypatch.setattr(
        "app.coverage.exclusion_review.load_ingested_policy_sources",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert review_policy_exclusions(s, s.get(Policy, "pol-1")) == []
