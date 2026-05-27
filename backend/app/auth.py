import base64
import hashlib
import hmac
import logging
import os
import secrets
import time
from typing import Optional

import bcrypt

logger = logging.getLogger(__name__)

_env_secret = os.getenv("APP_SECRET")
if _env_secret:
    _APP_SECRET = _env_secret.encode()
else:
    # No hardcoded fallback: a known default in source would let anyone forge a
    # valid session token. Generate an ephemeral per-process secret and warn —
    # tokens won't survive a restart until APP_SECRET is set, which is the nudge.
    _APP_SECRET = secrets.token_hex(32).encode()
    logger.warning(
        "APP_SECRET is not set — using an ephemeral random secret. Sessions will "
        "reset on restart. Set APP_SECRET in any real/production deployment."
    )
TOKEN_EXPIRE_SECONDS = 24 * 3600

# Demo seed users — written to DB on startup, not used as runtime auth store
DEMO_USERS = [
    {
        "id": "user_001",
        "email": "broker@nightline.risk",
        "name": "Alex Chen",
        "role": "broker",
        "tenant_id": None,
        "password": "demo123",
    },
    {
        "id": "user_002",
        "email": "venue@elsewhere.com",
        "name": "Jordan Miller",
        "role": "venue_operator",
        "tenant_id": "elsewhere-brooklyn",
        "password": "demo123",
    },
]

USER_COUNTER = len(DEMO_USERS) + 1


def _sign(payload: str) -> str:
    return hmac.new(_APP_SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]


def create_token(user_id: str, email: str, role: str, tenant_id: Optional[str] = None) -> str:
    expiry = int(time.time()) + TOKEN_EXPIRE_SECONDS
    payload = f"{user_id}:{email}:{role}:{tenant_id or ''}:{expiry}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode()
    return f"{_sign(encoded)}.{encoded}"


def verify_token(token: str) -> Optional[dict]:
    try:
        if "." not in token:
            return None
        signature, encoded = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(encoded)):
            return None
        payload = base64.urlsafe_b64decode(encoded.encode()).decode()
        parts = payload.split(":")
        if len(parts) < 5:
            return None
        if time.time() > int(parts[4]):
            return None
        return {
            "sub": parts[0],
            "email": parts[1],
            "role": parts[2],
            "tenant_id": parts[3] if parts[3] else None,
        }
    except Exception:
        return None


RESET_TOKEN_EXPIRE_SECONDS = 3600  # 1 hour


def create_reset_token(user_id: str) -> str:
    """Short-lived, purpose-scoped token for password reset. The `reset:` prefix
    keeps it distinct from a session token (verify_token rejects it and vice-versa)."""
    expiry = int(time.time()) + RESET_TOKEN_EXPIRE_SECONDS
    payload = f"reset:{user_id}:{expiry}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode()
    return f"{_sign(encoded)}.{encoded}"


def verify_reset_token(token: str) -> Optional[str]:
    """Return the user_id for a valid, unexpired reset token, else None."""
    try:
        if "." not in token:
            return None
        signature, encoded = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(encoded)):
            return None
        payload = base64.urlsafe_b64decode(encoded.encode()).decode()
        parts = payload.split(":")
        if len(parts) != 3 or parts[0] != "reset":
            return None
        if time.time() > int(parts[2]):
            return None
        return parts[1]
    except Exception:
        return None


def _pw_bytes(password: str) -> bytes:
    # bcrypt hashes only the first 72 bytes; truncate to avoid backend errors
    # on long inputs.
    return password.encode("utf-8")[:72]


def _is_bcrypt(hashed: str) -> bool:
    return hashed.startswith(("$2b$", "$2a$", "$2y$"))


def create_password_hash(password: str) -> str:
    """Hash a password with bcrypt (salted, slow). New hashes are '$2b$...'."""
    return bcrypt.hashpw(_pw_bytes(password), bcrypt.gensalt()).decode("utf-8")


def needs_rehash(hashed: str) -> bool:
    """True for legacy unsalted-sha256 hashes that should be upgraded to bcrypt
    on next successful login."""
    return not _is_bcrypt(hashed)


def verify_password(password: str, hashed: str) -> bool:
    """Verify against bcrypt; fall back to the legacy unsalted-sha256 hash so
    pre-migration users can still authenticate (then get rehashed on login)."""
    if _is_bcrypt(hashed):
        try:
            return bcrypt.checkpw(_pw_bytes(password), hashed.encode("utf-8"))
        except (ValueError, TypeError):
            return False
    legacy = hashlib.sha256(password.encode()).hexdigest()
    return hmac.compare_digest(legacy, hashed)


def _record_to_dict(record) -> dict:
    import json as _json
    raw = getattr(record, "extra_venue_ids", None)
    extra_ids = _json.loads(raw) if raw else []
    return {
        "id": record.id,
        "email": record.email,
        "password_hash": record.password_hash,
        "name": record.name,
        "role": record.role,
        "tenant_id": record.tenant_id,
        "extra_venue_ids": extra_ids,
    }


def authenticate_user(email: str, password: str, session) -> Optional[dict]:
    from sqlmodel import select
    from app.models import UserRecord
    record = session.exec(select(UserRecord).where(UserRecord.email == email)).first()
    if record and verify_password(password, record.password_hash):
        # Transparent migration: upgrade a legacy unsalted-sha256 hash to bcrypt
        # on successful login. Existing users are migrated without a flag-day.
        if needs_rehash(record.password_hash):
            record.password_hash = create_password_hash(password)
            session.add(record)
            session.commit()
        return _record_to_dict(record)
    return None


def get_user_by_id(user_id: str, session) -> Optional[dict]:
    from app.models import UserRecord
    record = session.get(UserRecord, user_id)
    return _record_to_dict(record) if record else None


def register_user(email: str, password: str, name: str, role: str, session) -> Optional[dict]:
    global USER_COUNTER
    from sqlmodel import select
    from app.models import UserRecord

    if session.exec(select(UserRecord).where(UserRecord.email == email)).first():
        return None

    user_id = f"user_{USER_COUNTER:03d}"
    USER_COUNTER += 1
    tenant_id = f"venue_{USER_COUNTER:03d}" if role == "venue_operator" else None

    record = UserRecord(
        id=user_id,
        email=email,
        password_hash=create_password_hash(password),
        name=name,
        role=role,
        tenant_id=tenant_id,
    )
    session.add(record)
    session.commit()
    session.refresh(record)
    return _record_to_dict(record)


# ── Router ────────────────────────────────────────────────────────────────────

from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel
from sqlmodel import Session
from app.database import get_session

router = APIRouter()


class LoginRequest(BaseModel):
    email: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    password: str
    name: str
    role: str = "venue_operator"


class ProfileUpdateRequest(BaseModel):
    name: Optional[str] = None
    email: Optional[str] = None


class PasswordChangeRequest(BaseModel):
    old_password: str
    new_password: str


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


@router.post("/login")
def login(request: LoginRequest, session: Session = Depends(get_session)):
    user = authenticate_user(request.email, request.password, session)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(user["id"], user["email"], user["role"], user["tenant_id"])
    return {"access_token": token, "user": {k: v for k, v in user.items() if k != "password_hash"}}


@router.post("/register")
def register(request: RegisterRequest, session: Session = Depends(get_session)):
    user = register_user(request.email, request.password, request.name, request.role, session)
    if not user:
        raise HTTPException(status_code=400, detail="User with this email already exists")
    token = create_token(user["id"], user["email"], user["role"], user["tenant_id"])
    return {"access_token": token, "user": {k: v for k, v in user.items() if k != "password_hash"}}


def require_non_broker(authorization: str = Header(None)):
    """Raises 403 if the caller's token identifies them as a broker."""
    if not authorization or not authorization.startswith("Bearer "):
        return
    decoded = verify_token(authorization.split(" ")[1])
    if decoded and decoded.get("role") == "broker":
        raise HTTPException(status_code=403, detail="Brokers cannot modify venues")


def current_user_optional(authorization: str = Header(None)):
    """Decoded JWT payload if present and valid, else None. Never raises.

    Use when an endpoint adapts its response to the caller's role but should
    still respond to anonymous callers (with a degraded payload).
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return verify_token(authorization.split(" ")[1])


def can_access_venue(user: dict | None, venue_id: str, session: Session) -> bool:
    """True if the caller may access ANY data scoped to `venue_id`.

    Broker/admin: cross-venue access (they manage the whole portfolio).
    Venue operator: only their own venue + any rows in `extra_venue_ids`.
    Anonymous: never.

    Sibling to `can_read_venue_floor` — that helper specifically returns
    False for brokers because floor telemetry is an operator-side surface.
    This helper is broader: any venue-scoped CRUD read (incidents, packets,
    sources, compliance evidence, etc.).
    """
    if not user:
        return False
    role = user.get("role")
    if role in ("broker", "admin"):
        return True
    if role != "venue_operator":
        return False
    if user.get("tenant_id") == venue_id:
        return True
    from app.models import UserRecord
    import json as _json
    record = session.get(UserRecord, user.get("sub"))
    if not record or not record.extra_venue_ids:
        return False
    try:
        extras = _json.loads(record.extra_venue_ids)
    except (ValueError, TypeError):
        return False
    return venue_id in extras


def require_venue_access(
    venue_id: str,
    authorization: str,
    session: Session,
) -> dict:
    """Auth+tenant gate. Returns the decoded user payload on success,
    raises 401/403 otherwise.

    Use as a function call from inside a route handler when the
    venue_id isn't a path param (e.g. resolved from an entity lookup):

        user = require_venue_access(incident.venue_id, authorization, session)
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail={
            "error": "auth_required",
            "message": "Authentication required",
        })
    decoded = verify_token(authorization.split(" ")[1])
    if not decoded:
        raise HTTPException(status_code=401, detail={
            "error": "auth_invalid",
            "message": "Invalid or expired token",
        })
    if not can_access_venue(decoded, venue_id, session):
        raise HTTPException(status_code=403, detail={
            "error": "venue_access_denied",
            "message": f"You do not have access to venue {venue_id!r}",
        })
    return decoded


def can_read_venue_floor(user: dict | None, venue_id: str, session: Session) -> bool:
    """True if the caller may see live floor telemetry for a specific venue.

    Floor data (live capacity, infrastructure status) is the operator's
    working surface — brokers see policy artifacts (risk, premium, compliance
    summary) but not the live shift state of their clients' venues.
    """
    if not user:
        return False
    role = user.get("role")
    if role == "admin":
        return True
    if role != "venue_operator":
        return False
    if user.get("tenant_id") == venue_id:
        return True
    # Check extra_venue_ids (operators who manage multiple venues)
    from app.models import UserRecord
    import json as _json
    record = session.get(UserRecord, user.get("sub"))
    if not record or not record.extra_venue_ids:
        return False
    try:
        extras = _json.loads(record.extra_venue_ids)
    except (ValueError, TypeError):
        return False
    return venue_id in extras


def require_broker(authorization: str = Header(None)):
    """Raises 401 without a valid token, or 403 if the caller is not a broker/admin.

    Stricter than require_non_broker (which allows anonymous): policy doc upload
    is a broker-onboarding action — there's no operator path through this gate.
    """
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    decoded = verify_token(authorization.split(" ")[1])
    if not decoded:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if decoded.get("role") not in ("broker", "admin"):
        raise HTTPException(status_code=403, detail="Broker access required")
    return decoded


def _get_current_user_record(authorization: str, session: Session):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    decoded = verify_token(authorization.split(" ")[1])
    if not decoded:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    from app.models import UserRecord
    record = session.get(UserRecord, decoded["sub"])
    if not record:
        raise HTTPException(status_code=404, detail="User not found")
    return record


@router.get("/me")
def get_me(authorization: str = Header(None), session: Session = Depends(get_session)):
    record = _get_current_user_record(authorization, session)
    user = _record_to_dict(record)
    return {k: v for k, v in user.items() if k != "password_hash"}


@router.patch("/me")
def update_me(
    request: ProfileUpdateRequest,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    """Update the caller's own name and/or email. Email must be unique."""
    from sqlmodel import select
    from app.models import UserRecord
    from app.packet_core import _add_audit_event

    record = _get_current_user_record(authorization, session)
    changed: list[str] = []

    if request.name is not None:
        new_name = request.name.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        if new_name != record.name:
            record.name = new_name
            changed.append("name")

    if request.email is not None:
        new_email = request.email.strip().lower()
        if "@" not in new_email or "." not in new_email:
            raise HTTPException(status_code=400, detail="Invalid email address")
        if new_email != record.email:
            existing = session.exec(select(UserRecord).where(UserRecord.email == new_email)).first()
            if existing and existing.id != record.id:
                raise HTTPException(status_code=409, detail="That email is already in use")
            record.email = new_email
            changed.append("email")

    if changed:
        session.add(record)
        _add_audit_event(
            session=session,
            actor_id=record.id,
            actor_type="user",
            entity_type="user",
            entity_id=record.id,
            event_type="profile_updated",
            event_metadata={"changed_fields": changed},
        )
        session.commit()
        session.refresh(record)

    user = _record_to_dict(record)
    return {k: v for k, v in user.items() if k != "password_hash"}


@router.post("/me/change-password", status_code=200)
def change_password(
    request: PasswordChangeRequest,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    """Change the caller's own password after verifying the current one."""
    from app.packet_core import _add_audit_event

    record = _get_current_user_record(authorization, session)
    if not verify_password(request.old_password, record.password_hash):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    if len(request.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")

    record.password_hash = create_password_hash(request.new_password)
    session.add(record)
    _add_audit_event(
        session=session,
        actor_id=record.id,
        actor_type="user",
        entity_type="user",
        entity_id=record.id,
        event_type="password_changed",
        event_metadata={},
    )
    session.commit()
    return {"success": True}


@router.post("/forgot-password", status_code=200)
def forgot_password(request: ForgotPasswordRequest, session: Session = Depends(get_session)):
    """Begin a password reset. Always 200 (never leak whether an account exists)."""
    from sqlmodel import select
    from app.models import UserRecord
    from app.services.email import send_password_reset_email

    email = request.email.strip().lower()
    record = session.exec(select(UserRecord).where(UserRecord.email == email)).first()
    if record:
        token = create_reset_token(record.id)
        frontend_url = os.getenv("FRONTEND_URL", "http://localhost:3000").rstrip("/")
        reset_url = f"{frontend_url}/reset-password?token={token}"
        send_password_reset_email(record.email, reset_url)
    return {"message": "If that email is registered, a reset link has been sent."}


@router.post("/reset-password", status_code=200)
def reset_password(request: ResetPasswordRequest, session: Session = Depends(get_session)):
    """Complete a password reset using a valid reset token."""
    from app.models import UserRecord
    from app.packet_core import _add_audit_event

    user_id = verify_reset_token(request.token)
    if not user_id:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")
    if len(request.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")

    record = session.get(UserRecord, user_id)
    if not record:
        raise HTTPException(status_code=400, detail="This reset link is invalid or has expired")

    record.password_hash = create_password_hash(request.new_password)
    session.add(record)
    _add_audit_event(
        session=session,
        actor_id=record.id,
        actor_type="user",
        entity_type="user",
        entity_id=record.id,
        event_type="password_reset",
        event_metadata={},
    )
    session.commit()
    return {"success": True}


@router.post("/me/extra-venues/{venue_id}", status_code=200)
def add_extra_venue(venue_id: str, authorization: str = Header(None), session: Session = Depends(get_session)):
    import json as _json
    record = _get_current_user_record(authorization, session)
    ids: list = _json.loads(record.extra_venue_ids) if record.extra_venue_ids else []
    if venue_id not in ids:
        ids.append(venue_id)
        record.extra_venue_ids = _json.dumps(ids)
        session.add(record)
        session.commit()
    return {"extra_venue_ids": ids}


@router.delete("/me/extra-venues/{venue_id}", status_code=200)
def remove_extra_venue(venue_id: str, authorization: str = Header(None), session: Session = Depends(get_session)):
    import json as _json
    record = _get_current_user_record(authorization, session)
    ids: list = _json.loads(record.extra_venue_ids) if record.extra_venue_ids else []
    ids = [i for i in ids if i != venue_id]
    record.extra_venue_ids = _json.dumps(ids)
    session.add(record)
    session.commit()
    return {"extra_venue_ids": ids}
