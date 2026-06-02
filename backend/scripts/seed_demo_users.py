"""Seed (or repair) the demo login accounts from app.auth.DEMO_USERS.

The app already seeds these in the FastAPI startup lifespan, but that only runs
on a fresh boot/redeploy. This script is the on-demand path — e.g. to add a
newly-introduced demo persona (the `carrier` underwriting-desk account) to a
long-running database without waiting for a redeploy.

Idempotent: inserts a demo user by id when missing; otherwise keeps the email
and role in sync with DEMO_USERS (so a renamed account / new role is repaired).
Passwords are reset to the demo password only when the row is created — an
existing account's password is left alone.

Run from the backend directory:
    python -m scripts.seed_demo_users

Against prod (Railway/Neon) use the Postgres PUBLIC url (the internal host
won't resolve locally):
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.seed_demo_users
"""
from __future__ import annotations

import sys

from sqlmodel import Session

from app.auth import DEMO_USERS, create_password_hash
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
        changed = False
        if existing.email != demo["email"]:
            existing.email = demo["email"]
            changed = True
        if existing.role != demo["role"]:
            existing.role = demo["role"]
            changed = True
        if changed:
            session.add(existing)
            repaired.append(f"{demo['id']} ({demo['email']} · {demo['role']})")
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
