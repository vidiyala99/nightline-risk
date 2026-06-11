"""FraudSignal carries deterministic AI provenance (provider/model/version +
input fingerprint), and it rides through to_dict() into the persisted
packet.fraud_signal."""
from datetime import datetime, timezone

from app.agents.fraud_agent import FRAUD_LOGIC_VERSION, assess_fraud

_REPORTED = datetime(2026, 5, 1, 23, 0, tzinfo=timezone.utc)
_BASE = {"occurred_at": "2026-05-01T22:00:00Z", "injury_observed": False,
         "police_called": False, "ems_called": False}


def test_fraud_signal_carries_deterministic_provenance():
    sig = assess_fraud(risk_signal={"severity": "low"}, incident=_BASE,
                       reported_at=_REPORTED, prior_claim_count=0, evidence_file_count=2)
    p = sig.provenance
    assert p is not None
    assert p["provider"] == "deterministic"
    assert p["model"] == "fraud-scorer"
    assert p["prompt_version"] == FRAUD_LOGIC_VERSION
    assert len(p["input_hash"]) == 16


def test_provenance_is_in_to_dict_for_persistence():
    sig = assess_fraud(risk_signal={"severity": "low"}, incident=_BASE,
                       reported_at=_REPORTED, prior_claim_count=0, evidence_file_count=2)
    assert sig.to_dict()["provenance"] == sig.provenance


def test_input_hash_distinguishes_different_claims():
    a = assess_fraud(risk_signal={"severity": "low"}, incident=_BASE,
                     reported_at=_REPORTED, prior_claim_count=0, evidence_file_count=2)
    b = assess_fraud(risk_signal={"severity": "high"}, incident={**_BASE, "injury_observed": True},
                     reported_at=_REPORTED, prior_claim_count=5, evidence_file_count=2)
    assert a.provenance["input_hash"] != b.provenance["input_hash"]
