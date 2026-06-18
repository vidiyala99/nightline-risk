"""F-7 — _incident_report must survive Postgres' JSON-as-string round-trip.
On Postgres, Column(JSON) fields can come back as JSON strings; the unguarded
.get()/len() previously raised and the blanket except swallowed it to None,
silently hiding the entire AI panel."""
import json
from datetime import date

from sqlmodel import Session, SQLModel, create_engine

from app.api.v1.adjusting import _as_dict, _as_list, _incident_report
from app.models import Claim, Policy, UnderwritingPacket, UserRecord, Venue
from app.services.claims import file_fnol

VENUE_ID = "elsewhere-brooklyn"
USER_ID = "u-brk"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(UserRecord(id=USER_ID, email="b@x.com", password_hash="x", name="B", role="broker"))
    s.commit()
    return s


def _claim_with_packet(s: Session) -> str:
    s.add(Policy(
        id="pol-1", policy_number="POL-1", submission_id="sub-1", bound_quote_id="q-1",
        venue_id=VENUE_ID, carrier_id="markel-specialty", status="active",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium="5000.00", commission_amount="750.00", commission_rate="0.15",
        coverage_lines=["gl"], terms_snapshot={}, snapshot_hash="h",
    ))
    s.commit()
    claim = file_fnol(s, policy_id="pol-1", coverage_line="gl",
                      date_of_loss=date(2026, 3, 1), filed_by=USER_ID)
    s.add(UnderwritingPacket(
        id="pkt-1", venue_id=VENUE_ID, incident_id="inc-1", rubric_version_id="rv-1",
        status="reviewed", snapshot_hash="h",
        risk_signals={"severity": "high", "confidence": 0.85},
        memo={"summary": "Documented A&B."}, citation_ids=["cit-1"],
    ))
    claim.defense_package_id = "pkt-1"
    s.add(claim)
    s.commit()
    return claim.id


def test_as_dict_and_as_list_coerce_json_strings():
    assert _as_dict('{"severity": "high"}') == {"severity": "high"}
    assert _as_dict({"a": 1}) == {"a": 1}
    assert _as_dict("not json") == {} and _as_dict(None) == {}
    assert _as_list('["a", "b"]') == ["a", "b"]
    assert _as_list(["x"]) == ["x"]
    assert _as_list("nope") == [] and _as_list(None) == []


def test_incident_report_survives_json_strings():
    s = _session()
    cid = _claim_with_packet(s)
    # Force the Postgres shape: JSON columns come back as STRINGS. Reassign on
    # the identity-mapped instance; _incident_report re-gets the same object.
    pkt = s.get(UnderwritingPacket, "pkt-1")
    pkt.risk_signals = json.dumps({"severity": "high", "confidence": 0.85})
    pkt.memo = json.dumps({"summary": "Documented A&B."})
    pkt.citation_ids = json.dumps(["cit-1"])
    s.add(pkt)
    s.flush()

    rep = _incident_report(s, s.get(Claim, cid))
    assert rep is not None                      # pre-fix: None (swallowed)
    assert rep["severity"] == "high"
    assert rep["memo_summary"] == "Documented A&B."
    assert rep["citation_count"] == 1
