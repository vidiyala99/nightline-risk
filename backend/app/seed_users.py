"""Seed (or repair) the demo login accounts from `DEMO_USERS`.

Single source of truth for demo-account seeding, called from BOTH:
  - the FastAPI startup lifespan (every boot / fresh DB), and
  - `scripts/seed_demo_users.py` (on-demand, e.g. against Neon).

Self-healing + idempotent. For each demo account:
  - missing id  → insert with the demo password
  - existing id → sync email and role, and (re)set the password to the demo
    password when it doesn't already verify.

That last point matters: a demo id can pre-date the persona (a real
registration may have claimed `user_003` before `carrier` existed), leaving a
row whose password isn't the demo one. Demo accounts have fixed, known
credentials, so we repair it into a working login rather than leaving it to
silently 401. The password is only rewritten when it doesn't verify, so reruns
are no-op writes.
"""
from __future__ import annotations

from sqlmodel import Session

from app.auth import DEMO_USERS, create_password_hash, verify_password
from app.models import UserRecord


def seed_demo_users(session: Session) -> dict:
    """Insert/repair every account in DEMO_USERS. Commits. Returns
    {"created": [...], "repaired": [...]} for logging."""
    created: list[str] = []
    repaired: list[str] = []
    for demo in DEMO_USERS:
        existing = session.get(UserRecord, demo["id"])
        if existing is None:
            session.add(UserRecord(
                id=demo["id"],
                email=demo["email"],
                password_hash=create_password_hash(demo["password"]),
                name=demo["name"],
                role=demo["role"],
                tenant_id=demo["tenant_id"],
            ))
            created.append(f"{demo['id']} ({demo['email']} · {demo['role']})")
            continue
        fixes: list[str] = []
        if existing.email != demo["email"]:
            existing.email = demo["email"]
            fixes.append("email")
        if existing.role != demo["role"]:
            existing.role = demo["role"]
            fixes.append("role")
        if not verify_password(demo["password"], existing.password_hash):
            existing.password_hash = create_password_hash(demo["password"])
            fixes.append("password")
        if fixes:
            session.add(existing)
            repaired.append(f"{demo['id']} ({demo['email']} · {demo['role']}) [{', '.join(fixes)}]")
    session.commit()
    return {"created": created, "repaired": repaired}
