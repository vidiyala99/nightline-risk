from datetime import date
from sqlmodel import Session, SQLModel, create_engine
from app.models import Venue
from app.seed_carriers import seed_broker_platform_data
from app.seed_data import VENUES
from app.services.submissions import create_submission, submit_to_market
from app.services.underwriting_desk import decision_dossier

VENUE_ID = "elsewhere-brooklyn"


def _session():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name=VENUES[VENUE_ID]["name"]))
    seed_broker_platform_data(s)
    s.commit()
    return s


def _quote(s):
    sub = create_submission(s, venue_id=VENUE_ID, effective_date=date(2026, 11, 1),
                            coverage_lines=["gl", "liquor"], requested_limits={"gl": {"per_occurrence": "1000000"}},
                            actor_id="u-broker")
    s.commit()
    res = submit_to_market(s, sub.id, target_carriers=["markel-specialty"], submitted_by="u-broker")
    s.commit()
    return res.quotes_created[0]


def test_dossier_composes_all_sections():
    with _session() as s:
        q = _quote(s)
        d = decision_dossier(s, q.id)
        assert d["quote"]["id"] == q.id
        assert d["venue"]["name"]
        assert d["risk"]["tier"] in ("A", "B", "C", "D")
        assert "factors" in d["risk"]
        assert "summary" in d["loss_run"] or d["loss_run"] is None
        assert "open_count" in d["incidents"]
        assert "status" in d["compliance"]
        assert d["suggested_premium_breakdown"]["total"]
        assert d["decidable"] is True


def test_dossier_missing_quote_returns_none():
    with _session() as s:
        assert decision_dossier(s, "q-nope") is None


def test_dossier_unknown_venue_degrades_not_500():
    with _session() as s:
        q = _quote(s)
        from app.models import Submission
        sub = s.get(Submission, q.submission_id); sub.venue_id = "venue-x"; s.add(sub); s.commit()
        d = decision_dossier(s, q.id)
        assert d["suggested_premium_breakdown"] is None
        assert d["loss_run"] is None or d["loss_run"]["summary"]["claim_count"] == 0
