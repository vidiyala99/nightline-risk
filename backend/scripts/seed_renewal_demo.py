"""Seed a coherent renewal-at-risk demo policy. Idempotent.

Run from backend/:  python -m scripts.seed_renewal_demo

The `renewal_at_risk` broker finding fires on an in-force policy expiring within
60 days with no live renewal in motion. To make that scenario real (and
renewable end-to-end), we take the EB current policy — EB-DEMO-2026-0001, on the
real `elsewhere-brooklyn` venue, with a real prior submission (`sub-demo-eb-current`)
— and set its expiration ~22 days out. A RELATIVE date is used on purpose so the
policy stays inside the renewal window on every run, surviving reseeds.

This replaces the old `pol-tasks-soon` test-fixture leak (phantom venue) that
could surface the card but could not actually be renewed.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta

from sqlmodel import Session, select

from app.database import engine
from app.models import Policy
from app.services.policies import _compute_policy_snapshot_hash
from scripts.seed_demo_placements import ensure_eb_current_policy
from scripts.seed_demo_placements import seed as seed_placements

DAYS_TO_EXPIRY = 22


def seed(session: Session) -> Policy | None:
    """Ensure the EB current policy exists and expires ~22 days out.

    Returns the policy (or None if the prerequisite EB policy can't be found)."""
    seed_placements(session)
    ensure_eb_current_policy(session)
    pol = session.exec(
        select(Policy).where(Policy.policy_number == "EB-DEMO-2026-0001")
    ).first()
    if pol is None:
        return None
    pol.expiration_date = date.today() + timedelta(days=DAYS_TO_EXPIRY)
    # Keep the snapshot coherent with the mutated term (the hash body includes
    # expiration_date) so the policy isn't left tamper-flagged.
    pol.snapshot_hash = _compute_policy_snapshot_hash(pol)
    session.add(pol)
    return pol


def main() -> int:
    with Session(engine) as s:
        pol = seed(s)
        s.commit()
        if pol is None:
            print("[seed] renewal-demo: EB current policy not found; run seed_demo_placements first")
            return 0
        # Read the fields while the session is still open (avoids DetachedInstanceError).
        number, pid, exp = pol.policy_number, pol.id, str(pol.expiration_date)
    print(
        f"[seed] renewal-at-risk policy {number} ({pid}) "
        f"expires {exp} (~{DAYS_TO_EXPIRY}d, elsewhere-brooklyn) — "
        "surfaces the 'Start the renewal' card and renews end-to-end"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
