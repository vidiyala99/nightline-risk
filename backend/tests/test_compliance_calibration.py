from app.underwriting.fusion import Signal, fuse, COMPLIANCE_K


def sig(p, sev="medium", st="open"):
    return Signal(provenance=p, severity=sev, status=st)


def test_low_trust_spam_cannot_beat_two_verified_items():
    verified_two = fuse([sig("underwriter_verified"), sig("underwriter_verified")], COMPLIANCE_K)
    auto_five = fuse([sig("auto_generated", "low")] * 5, COMPLIANCE_K)
    # Five low-trust auto items must NOT drag the score below two verified items.
    assert auto_five > verified_two


def test_resolving_only_ever_raises_score():
    open_two = fuse([sig("underwriter_verified"), sig("underwriter_verified")], COMPLIANCE_K)
    one_resolved = fuse([sig("underwriter_verified"), sig("underwriter_verified", st="resolved")], COMPLIANCE_K)
    assert one_resolved > open_two


def test_severity_monotonic():
    assert (
        fuse([sig("operator_reported", "urgent")], COMPLIANCE_K)
        < fuse([sig("operator_reported", "low")], COMPLIANCE_K)
    )
