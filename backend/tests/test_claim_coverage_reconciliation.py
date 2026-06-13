"""Coverage-drift reconciliation.

When a venue's LAST active policy lapses, its open claim proposals become
unfileable — a 'coverage lapsed' hold (the root cause of the "Approved · ready
to file" vs "Cannot file: no_active_policy" contradiction: a proposal routed
while covered, then the policy lapsed). When coverage returns the hold is
restored. Edge-triggered at the policy-transition seam so the audit fires only
on the transition that crosses the coverage on/off boundary.
"""
from datetime import date
from decimal import Decimal

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import AuditEvent, ClaimProposal, Policy, Venue
from app.services.policies import lapse_policy, reinstate_policy


def _session() -> Session:
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    return Session(eng)


def _add_policy(s, pid, venue, status):
    s.add(Policy(
        id=pid, submission_id=f"sub-{pid}", bound_quote_id=f"q-{pid}", venue_id=venue,
        carrier_id="c", status=status,
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium=Decimal("5000"), commission_amount=Decimal("750"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
        terms_snapshot={}, snapshot_hash=f"h-{pid}",
    ))


def _seed(s, *, venue="v1", proposal_state="approved"):
    s.add(Venue(id=venue, name="V"))
    _add_policy(s, "pol-1", venue, "active")
    s.add(ClaimProposal(id="pr-1", packet_id="pk-1", venue_id=venue,
                        proposed_by="auto-router", state=proposal_state))
    s.commit()


def _audits(s, proposal_id, event_type):
    return s.exec(select(AuditEvent).where(
        AuditEvent.entity_type == "claim_proposal",
        AuditEvent.entity_id == proposal_id,
        AuditEvent.event_type == event_type,
    )).all()


def test_policy_lapse_holds_open_proposal_with_audit():
    s = _session(); _seed(s)
    lapse_policy(s, "pol-1", reason="nonpayment", actor_id="sys")
    assert len(_audits(s, "pr-1", "claim_proposal.coverage_lapsed")) == 1


def test_reinstating_policy_restores_proposal_with_audit():
    s = _session(); _seed(s)
    lapse_policy(s, "pol-1", reason="x", actor_id="sys")
    reinstate_policy(s, "pol-1", actor_id="sys")
    assert len(_audits(s, "pr-1", "claim_proposal.coverage_restored")) == 1


def test_lapse_with_another_active_policy_does_not_hold():
    """Still covered by a second policy → not a coverage-off edge → no hold."""
    s = _session(); _seed(s)
    _add_policy(s, "pol-2", "v1", "active")
    s.commit()
    lapse_policy(s, "pol-1", reason="x", actor_id="sys")
    assert _audits(s, "pr-1", "claim_proposal.coverage_lapsed") == []


def test_terminal_proposal_not_held_on_lapse():
    """A proposal already filed with the carrier is not an open hold candidate."""
    s = _session(); _seed(s, proposal_state="filed_with_carrier")
    lapse_policy(s, "pol-1", reason="x", actor_id="sys")
    assert _audits(s, "pr-1", "claim_proposal.coverage_lapsed") == []
