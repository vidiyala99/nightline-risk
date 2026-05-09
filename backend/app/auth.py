import base64
import hashlib
import hmac
import os
import time
from typing import Optional

_APP_SECRET = os.getenv("APP_SECRET", "ts-risk-demo-secret-v1-do-not-use-in-prod").encode()
TOKEN_EXPIRE_SECONDS = 24 * 3600

# Demo seed users — written to DB on startup, not used as runtime auth store
DEMO_USERS = [
    {
        "id": "user_001",
        "email": "broker@thirdspace.risk",
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


def create_password_hash(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, hashed: str) -> bool:
    return hmac.compare_digest(create_password_hash(password), hashed)


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
