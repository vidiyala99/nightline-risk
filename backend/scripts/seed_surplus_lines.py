"""Seed surplus-lines filings for the demo placements. Idempotent.

Run from backend/:  python -m scripts.seed_surplus_lines

Produces (on top of the filings the E&S bind hook already creates):
  - BW-DEMO (nowadays, E&S): filing + 3 declinations -> diligent search complete -> fileable.
  - EB-DEMO (elsewhere, E&S): filing + 2 declinations -> incomplete (shows the
    file-guard blocking a premature filing and the 'needs attention' surface).
"""
from __future__ import annotations

import sys
from datetime import date

from sqlmodel import Session, select

from app.database import engine
from app.models import Declination, Policy, SurplusLinesFiling
from app.services.surplus_lines import (
    create_filing_for_policy,
    record_declination,
    recompute_diligent_search,
)
from scripts.seed_demo_placements import ensure_eb_current_policy
from scripts.seed_demo_placements import seed as seed_placements


def _ensure_filing(session: Session, policy: Policy, *, declines: int) -> None:
    filing = session.exec(
        select(SurplusLinesFiling).where(SurplusLinesFiling.policy_id == policy.id)
    ).first()
    if filing is None:
        filing = create_filing_for_policy(session, policy, actor_id="user_001")
    existing = session.exec(
        select(Declination).where(Declination.submission_id == policy.submission_id)
    ).all()
    if not existing:
        for i in range(declines):
            record_declination(
                session, policy.submission_id, carrier_name=f"Admitted Mutual {i+1}",
                reason="outside nightlife appetite", declined_at=date.today(),
            )
    recompute_diligent_search(session, filing)


def main() -> int:
    with Session(engine) as s:
        seed_placements(s)
        ensure_eb_current_policy(s)
        s.commit()
    with Session(engine) as s:
        nowadays = s.exec(
            select(Policy).where(Policy.policy_number == "BW-DEMO-2026-0001")
        ).first()
        eb = s.exec(
            select(Policy).where(Policy.policy_number == "EB-DEMO-2026-0001")
        ).first()
        if nowadays:
            _ensure_filing(s, nowadays, declines=3)
        if eb:
            _ensure_filing(s, eb, declines=2)
        s.commit()
    print("[seed] surplus-lines filings ensured (nowadays: complete, EB: incomplete)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
