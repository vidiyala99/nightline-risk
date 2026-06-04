from datetime import date, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from sqlmodel import Session, SQLModel, create_engine, select

from app.database import engine
from app.lifecycles import (
    InvalidTransitionError,
    SL_FILING_TERMINAL_STATES,
    SL_FILING_TRANSITIONS,
    assert_valid_transition,
)
from app.models import Carrier, Declination, Policy, SurplusLinesFiling, Venue
from app.surplus_lines_docs import (
    render_diligent_search_affidavit,
    render_nonadmitted_disclosure,
    render_sl_tax_statement,
)
from app.services.surplus_lines import (
    SurplusLinesError,
    confirm_filing,
    create_filing_for_policy,
    file_filing,
    record_declination,
    recompute_diligent_search,
    void_filing,
)
from app.underwriting.pricing import NY_SURPLUS_LINES_TAX
from app.underwriting.surplus_lines import (
    NY_STAMPING_FEE,
    REQUIRED_DECLINATIONS,
    compute_sl_charges,
    diligent_search_complete,
)
from scripts.seed_demo_placements import seed as seed_placements


def test_tax_rate_is_corrected():
    assert NY_SURPLUS_LINES_TAX == Decimal("0.036")
    assert NY_STAMPING_FEE == Decimal("0.0015")
    assert REQUIRED_DECLINATIONS == 3


def test_compute_sl_charges_known_base():
    # base = subtotal + policy_fee
    charges = compute_sl_charges(Decimal("5650.00"))
    assert charges.tax == Decimal("203.40")          # 5650 * 0.036
    assert charges.stamping_fee == Decimal("8.48")    # usd(5650 * 0.0015) = usd(8.475) = 8.48
    assert charges.total_charges == Decimal("211.88")


def test_diligent_search_rules():
    assert diligent_search_complete(3, export_list_exempt=False) is True
    assert diligent_search_complete(2, export_list_exempt=False) is False
    assert diligent_search_complete(0, export_list_exempt=True) is True


def test_models_persist():
    # Self-sufficient in-memory engine (peer pattern: test_ingestion_models.py)
    # — isolated, builds its own schema, no dependency on the shared database.db.
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        f = SurplusLinesFiling(
            id="slf-1", policy_id="pol-1", venue_id="v-1",
            taxable_premium=Decimal("5650.00"), surplus_lines_tax=Decimal("203.40"),
            stamping_fee=Decimal("8.48"), total_charges=Decimal("211.88"),
            filing_deadline=date(2026, 7, 1),
        )
        d = Declination(
            id="decl-1", submission_id="sub-1",
            carrier_name="Acme Admitted", declined_at=date(2026, 5, 1),
            reason="outside appetite",
        )
        s.add(f); s.add(d); s.commit()
        assert f.status == "pending"
        assert f.diligent_search_complete is False
        assert d.reason == "outside appetite"


def test_filing_lifecycle_matrix():
    assert SL_FILING_TRANSITIONS["pending"] == {"filed", "void"}
    assert SL_FILING_TRANSITIONS["filed"] == {"confirmed", "void"}
    assert SL_FILING_TRANSITIONS["confirmed"] == {"void"}
    assert SL_FILING_TRANSITIONS["void"] == set()
    assert SL_FILING_TERMINAL_STATES == frozenset({"void"})
    assert_valid_transition(SL_FILING_TRANSITIONS, "pending", "filed", entity_name="filing")
    with pytest.raises(InvalidTransitionError):
        assert_valid_transition(SL_FILING_TRANSITIONS, "pending", "confirmed", entity_name="filing")


def _bound_demo_policy(session):
    """Seed the demo placements and return the bound E&S policy (BW-DEMO)."""
    seed_placements(session)
    session.commit()
    return session.exec(
        select(Policy).where(Policy.policy_number == "BW-DEMO-2026-0001")
    ).first()


def _throwaway_es_policy(session):
    """A fresh, uniquely-identified bound E&S policy stand-in for state-mutating
    tests — avoids leaking filing state across reruns of the shared database.db."""
    u = uuid4().hex[:8]
    pol = Policy(
        id=f"pol-sl-{u}", submission_id=f"sub-sl-{u}", bound_quote_id=f"q-sl-{u}",
        venue_id=f"v-sl-{u}", carrier_id="burns-wilcox",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("1000.00"), commission_amount=Decimal("120.00"),
        commission_rate=Decimal("0.12"),
        terms_snapshot={"premium_breakdown": {"subtotal": "1000.00", "fees": {"policy_fee": "150.00"}}},
    )
    session.add(pol)
    session.commit()
    return pol


def test_create_filing_computes_charges_and_deadline():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        bd = pol.terms_snapshot["premium_breakdown"]
        base = Decimal(bd["subtotal"]) + Decimal(bd["fees"]["policy_fee"])
        assert filing.taxable_premium == base
        # reconciles with the quote engine's own tax (same 0.036, same base)
        assert filing.surplus_lines_tax == Decimal(bd["fees"]["surplus_lines_tax"])
        assert filing.stamping_fee == (base * Decimal("0.0015")).quantize(Decimal("0.01"))
        assert filing.filing_deadline == pol.bound_at.date() + timedelta(days=45)


def test_bind_autocreates_filing_for_es():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)  # burns-wilcox is e&s, bound via bind_quote
        carrier = s.get(Carrier, pol.carrier_id)
        assert carrier.market_type == "e&s"
        filing = s.exec(
            select(SurplusLinesFiling).where(SurplusLinesFiling.policy_id == pol.id)
        ).first()
        assert filing is not None  # the bind hook created it


def test_bind_no_filing_for_admitted():
    """An admitted-carrier bind must NOT create a SurplusLinesFiling.

    Self-contained in-memory engine (peer pattern: test_policies_service.py)
    so it's isolated and rerun-safe. markel-specialty is an admitted carrier.
    """
    from sqlmodel import SQLModel as _SQLModel
    from app.models import Submission, CarrierQuote, UserRecord
    from app.seed_carriers import seed_broker_platform_data
    from app.services.policies import bind_quote

    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    _SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        s.add(Venue(id="v-adm", name="Admitted Venue"))
        s.add(UserRecord(
            id="u-adm", email="a@x.com", password_hash="x", name="B", role="broker",
        ))
        seed_broker_platform_data(s)
        sub = Submission(
            id="sub-adm", venue_id="v-adm", effective_date=date(2026, 11, 1),
            coverage_lines=["gl", "liquor"], status="quoting",
        )
        s.add(sub); s.flush()
        q = CarrierQuote(
            id="q-adm", submission_id=sub.id, carrier_id="markel-specialty",
            status="quoted", is_selected=True,
            premium_breakdown={
                "subtotal": "5600.00", "total": "5894.84",
                "fees": {"policy_fee": "150.00"},
                "commission_rate": "0.15", "commission_amount": "839.23",
            },
            coverage_terms={"gl": {"per_occurrence": "1000000"}},
        )
        s.add(q); s.commit()

        carrier = s.get(Carrier, "markel-specialty")
        assert carrier.market_type == "admitted"

        pol = bind_quote(s, "q-adm", bound_by="u-adm")
        s.commit()

        filing = s.exec(
            select(SurplusLinesFiling).where(SurplusLinesFiling.policy_id == pol.id)
        ).first()
        assert filing is None  # admitted carriers are exempt from SL filing


def test_diligent_search_recompute_and_idempotent_create():
    # Isolated throwaway policy (unique ids) so the False->True transition and
    # the idempotent-create check are rerun-safe on the shared database.db
    # (the seeded BW-DEMO filing would carry state across runs).
    with Session(engine) as s:
        pol = _throwaway_es_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        assert filing.diligent_search_complete is False  # fresh policy: 0 declinations
        for i in range(3):
            record_declination(
                s, pol.submission_id, carrier_name=f"Admitted {i}",
                reason="outside appetite", declined_at=pol.effective_date,
            )
        s.commit()
        recompute_diligent_search(s, filing)
        s.commit()
        assert filing.diligent_search_complete is True
        # idempotent: re-create returns the same filing, doesn't duplicate
        again = create_filing_for_policy(s, pol, actor_id="user_001")
        assert again.id == filing.id


def test_file_guard_blocks_incomplete_diligent_search():
    with Session(engine) as s:
        pol = _throwaway_es_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        with pytest.raises(SurplusLinesError):
            file_filing(s, filing.id, actor_id="user_001")  # 0 declinations


def test_file_then_confirm_happy_path():
    with Session(engine) as s:
        pol = _throwaway_es_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        for i in range(3):
            record_declination(s, pol.submission_id, carrier_name=f"A{i}",
                               reason="appetite", declined_at=pol.effective_date)
        recompute_diligent_search(s, filing)
        s.commit()
        filed = file_filing(s, filing.id, actor_id="user_001")
        assert filed.status == "filed" and filed.filed_at is not None
        confirmed = confirm_filing(s, filing.id, transaction_id="ELANY-X", actor_id="user_001")
        assert confirmed.status == "confirmed" and confirmed.transaction_id == "ELANY-X"


def test_invalid_transition_raises():
    with Session(engine) as s:
        pol = _throwaway_es_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        with pytest.raises(InvalidTransitionError):  # pending -> confirmed not allowed
            confirm_filing(s, filing.id, transaction_id="X", actor_id="user_001")


def test_void_filing():
    with Session(engine) as s:
        pol = _throwaway_es_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        voided = void_filing(s, filing.id, reason="duplicate", actor_id="user_001")
        assert voided.status == "void"


def test_document_renderers_return_pdf_bytes():
    with Session(engine) as s:
        pol = _bound_demo_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        s.commit()
        venue = s.get(Venue, pol.venue_id)
        carrier = s.get(Carrier, pol.carrier_id)
        decls = []
        for kind, pdf in [
            ("affidavit", render_diligent_search_affidavit(filing, decls, venue)),
            ("tax_statement", render_sl_tax_statement(filing, pol, venue)),
            ("disclosure", render_nonadmitted_disclosure(filing, pol, venue, carrier)),
        ]:
            assert isinstance(pdf, bytes) and pdf[:4] == b"%PDF", kind


def test_filing_stores_three_documents():
    with Session(engine) as s:
        pol = _throwaway_es_policy(s)
        filing = create_filing_for_policy(s, pol, actor_id="user_001")
        for i in range(3):
            record_declination(s, pol.submission_id, carrier_name=f"A{i}",
                               reason="appetite", declined_at=pol.effective_date)
        recompute_diligent_search(s, filing)
        s.commit()
        filed = file_filing(s, filing.id, actor_id="user_001")
        assert set(filed.documents.keys()) == {"affidavit", "tax_statement", "disclosure"}
        for path in filed.documents.values():
            assert isinstance(path, str) and path
