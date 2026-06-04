"""Staff tier — floor employees who log in to report incidents.

A staff member is a `UserRecord` with `role="staff"` scoped to one venue
(`tenant_id == venue_id`). The venue's operator (employer) provisions them; the
staff member sets their own password via the standard reset-token flow. They are
a restricted persona — they can file incidents for their own venue and read the
ones they reported, nothing else (gating lives in the routers/auth).

Services don't commit — the API layer owns the transaction.
"""
from __future__ import annotations

import secrets
from uuid import uuid4

from sqlmodel import Session, select

from app.auth import create_password_hash, create_reset_token
from app.models import UserRecord


class StaffError(Exception):
    """Raised for staff-provisioning failures the router maps to a 4xx
    (e.g. an email that already belongs to a user)."""


def create_staff_account(
    session: Session,
    *,
    venue_id: str,
    name: str,
    email: str,
) -> tuple[UserRecord, str]:
    """Create a `role="staff"` user scoped to `venue_id` and return
    (user, set_password_token). The account starts with an unguessable random
    password; the staff member sets a real one via the reset-token link."""
    email_norm = (email or "").strip().lower()
    if not email_norm:
        raise StaffError("Email is required")
    if session.exec(select(UserRecord).where(UserRecord.email == email_norm)).first():
        raise StaffError(f"A user already exists for {email_norm}")

    user = UserRecord(
        id=f"staff-{uuid4().hex[:12]}",
        email=email_norm,
        password_hash=create_password_hash(secrets.token_urlsafe(24)),
        name=name,
        role="staff",
        tenant_id=venue_id,
    )
    session.add(user)
    session.flush()
    return user, create_reset_token(user.id)


def list_staff(session: Session, venue_id: str) -> list[UserRecord]:
    """All staff users for a venue (the operator's 'Floor Team' roster)."""
    return list(
        session.exec(
            select(UserRecord)
            .where(UserRecord.role == "staff")
            .where(UserRecord.tenant_id == venue_id)
        ).all()
    )
