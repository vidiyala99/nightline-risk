"""COI auto-fill core: a broker re-issues certificates to the same recurring
holders (landlords / event clients) constantly. Re-typing the holder's address,
operations text, and additional-insured scope every time is the daily servicing
grind — and an inexact name re-type ("ACME, LLC" vs "Acme LLC") mints a duplicate
instead of superseding. This groups prior COIs by a normalized holder name and
surfaces the most-recent details to pre-fill, with the canonical spelling."""
from datetime import date, datetime, timezone

from app.models import CertificateOfInsurance
from app.services.coi_autofill import normalize_holder, summarize_holders


def _coi(holder, *, addr="1 Main St", desc="Operations", ai=False, scope=None,
         issued, cid="coi-x"):
    return CertificateOfInsurance(
        id=cid, policy_id="pol-1", certificate_holder=holder,
        certificate_holder_address=addr, description_of_operations=desc,
        additional_insured=ai, additional_insured_scope=scope,
        status="active", expires_on=date(2027, 1, 1),
        issued_at=datetime(*issued, tzinfo=timezone.utc), issued_by="b1",
    )


def test_normalize_collapses_case_punctuation_and_whitespace():
    assert normalize_holder("ACME, LLC") == normalize_holder("Acme LLC")
    assert normalize_holder("  599 Johnson   LLC ") == "599 johnson llc"
    assert normalize_holder("Acme LLC") != normalize_holder("Beacon LLC")


def test_summarize_groups_by_normalized_holder_and_counts():
    certs = [
        _coi("Acme LLC", issued=(2026, 1, 1), cid="c1"),
        _coi("ACME, LLC", issued=(2026, 3, 1), cid="c2"),
        _coi("Beacon Properties", issued=(2026, 2, 1), cid="c3"),
    ]
    out = summarize_holders(certs)
    assert len(out) == 2
    by_name = {s.certificate_holder: s for s in out}
    # Canonical spelling = the most recently issued one.
    assert "ACME, LLC" in by_name
    assert by_name["ACME, LLC"].times_used == 2


def test_summarize_carries_most_recent_prefill_fields():
    certs = [
        _coi("Acme LLC", addr="old addr", desc="old ops", ai=False, issued=(2026, 1, 1), cid="c1"),
        _coi("Acme LLC", addr="new addr", desc="new ops", ai=True,
             scope="single_event", issued=(2026, 5, 1), cid="c2"),
    ]
    s = summarize_holders(certs)[0]
    assert s.certificate_holder_address == "new addr"
    assert s.description_of_operations == "new ops"
    assert s.additional_insured is True
    assert s.additional_insured_scope == "single_event"
    assert s.last_issued_at == "2026-05-01T00:00:00+00:00"


def test_summarize_sorts_by_usage_then_recency():
    certs = [
        _coi("Once Co", issued=(2026, 6, 1), cid="c1"),
        _coi("Twice Co", issued=(2026, 1, 1), cid="c2"),
        _coi("Twice Co", issued=(2026, 2, 1), cid="c3"),
    ]
    out = summarize_holders(certs)
    assert out[0].certificate_holder == "Twice Co"   # 2 uses outranks 1


def test_summarize_empty():
    assert summarize_holders([]) == []
