import pytest
from app.underwriting.fusion import Signal, signal_weight, fuse, COMPLIANCE_K


def s(provenance="underwriter_verified", severity="medium", status="open"):
    return Signal(provenance=provenance, severity=severity, status=status)


def test_signal_weight_is_product_of_three_tables():
    assert signal_weight(s()) == 1.0  # 1.0 * 1.0 * 1.0
    assert signal_weight(s("auto_generated", "urgent", "open")) == 0.75  # 0.3 * 2.5 * 1.0
    assert signal_weight(s("underwriter_verified", "medium", "resolved")) == 0.2  # * 0.2


def test_fuse_empty_is_clean_100():
    assert fuse([], COMPLIANCE_K) == 100


def test_fuse_anchor_one_verified_open_is_about_70():
    assert fuse([s()], COMPLIANCE_K) == 70


def test_fuse_anchor_one_auto_urgent_nudges_not_tanks():
    score = fuse([s("auto_generated", "urgent", "open")], COMPLIANCE_K)
    assert score == 77  # round(100 * exp(-0.75/2.8))


def test_fuse_anchor_two_verified_open_is_about_49():
    assert fuse([s(), s()], COMPLIANCE_K) == 49


def test_fuse_is_clamped_and_deterministic():
    many = [s("underwriter_verified", "urgent", "open")] * 50
    assert fuse(many, COMPLIANCE_K) == 0
    assert fuse(many, COMPLIANCE_K) == fuse(many, COMPLIANCE_K)


def test_unknown_enum_raises():
    with pytest.raises(KeyError):
        signal_weight(s(provenance="rumor"))
