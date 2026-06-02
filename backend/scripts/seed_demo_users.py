"""Seed (or repair) the demo login accounts from app.auth.DEMO_USERS.

The app already seeds these in the FastAPI startup lifespan, but that only runs
on a fresh boot/redeploy. This script is the on-demand path — e.g. to add a
newly-introduced demo persona (the `carrier` underwriting-desk account) to a
long-running database without waiting for a redeploy.

Idempotent: inserts a demo user by id when missing; otherwise keeps the email,
role, AND password in sync with DEMO_USERS. The password is (re)set to the demo
password whenever it doesn't already verify — demo accounts have fixed, known
credentials, so a pre-existing row (e.g. an id that a real registration claimed
before this persona existed) is repaired into a working demo login rather than
silently 401-ing.

Run from the backend directory:
    python -m scripts.seed_demo_users

Against prod (Railway/Neon) use the Postgres PUBLIC url (the internal host
won't resolve locally):
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.seed_demo_users
"""
from __future__ import annotations

import sys

from sqlmodel import Session

from app.auth import DEMO_USERS, create_password_hash, verify_password
from app.database import engine
from app.models import UserRecord


def seed(session: Session) -> dict:
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
        # Demo accounts must always log in with the demo password. Reset it only
        # when it doesn't already verify (avoids a needless write each run).
        if not verify_password(demo["password"], existing.password_hash):
            existing.password_hash = create_password_hash(demo["password"])
            fixes.append("password")
        if fixes:
            session.add(existing)
            repaired.append(f"{demo['id']} ({demo['email']} · {demo['role']}) [{', '.join(fixes)}]")
    session.commit()
    return {"created": created, "repaired": repaired}


def main() -> int:
    with Session(engine) as session:
        result = seed(session)
    if result["created"]:
        print("[seed] created demo users:")
        for row in result["created"]:
            print(f"  + {row}")
    if result["repaired"]:
        print("[seed] repaired demo users:")
        for row in result["repaired"]:
            print(f"  ~ {row}")
    if not result["created"] and not result["repaired"]:
        print("[seed] all demo users already present and in sync.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
