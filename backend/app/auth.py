import base64
import hashlib
import hmac
import os
import time
from typing import Optional

# Stable secret loaded from environment. In production this would be a
# secret manager value. For the demo, a hardcoded fallback is acceptable
# because we're not storing sensitive production data.
_APP_SECRET = os.getenv("APP_SECRET", "ts-risk-demo-secret-v1-do-not-use-in-prod").encode()

TOKEN_EXPIRE_SECONDS = 24 * 3600


def _sign(payload: str) -> str:
    """Return a 32-char hex HMAC-SHA256 signature over the payload."""
    return hmac.new(_APP_SECRET, payload.encode(), hashlib.sha256).hexdigest()[:32]


def create_token(user_id: str, email: str, role: str, tenant_id: Optional[str] = None) -> str:
    """
    Create an HMAC-signed token.

    Format: <32-char-hmac>.<base64(user_id:email:role:tenant_id:expiry)>
    The HMAC prevents forgery: verifying the signature is the first check
    in verify_token, before decoding any fields.
    """
    expiry = int(time.time()) + TOKEN_EXPIRE_SECONDS
    payload = f"{user_id}:{email}:{role}:{tenant_id or ''}:{expiry}"
    encoded = base64.urlsafe_b64encode(payload.encode()).decode()
    signature = _sign(encoded)
    return f"{signature}.{encoded}"


def verify_token(token: str) -> Optional[dict]:
    """
    Verify an HMAC-signed token and return its claims.

    Returns None if the token is malformed, the signature is invalid,
    or the token has expired.
    """
    try:
        if "." not in token:
            return None
        signature, encoded = token.split(".", 1)

        # Constant-time comparison prevents timing attacks
        expected = _sign(encoded)
        if not hmac.compare_digest(signature, expected):
            return None

        payload = base64.urlsafe_b64decode(encoded.encode()).decode()
        parts = payload.split(":")
        if len(parts) < 5:
            return None

        expiry = int(parts[4])
        if time.time() > expiry:
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
    # Constant-time comparison prevents timing-based enumeration of valid passwords
    return hmac.compare_digest(create_password_hash(password), hashed)

USERS_DB = {
    "user_001": {
        "id": "user_001",
        "email": "broker@thirdspace.risk",
        "password_hash": create_password_hash("demo123"),
        "name": "Alex Chen",
        "role": "broker",
        "tenant_id": None,
    },
    "user_002": {
        "id": "user_002",
        "email": "venue@elsewhere.com",
        "password_hash": create_password_hash("demo123"),
        "name": "Jordan Miller",
        "role": "venue_operator",
        "tenant_id": "elsewhere-brooklyn",
    },
}

USER_COUNTER = 3

def _user_record_to_dict(record) -> dict:
    return {
        "id": record.id,
        "email": record.email,
        "password_hash": record.password_hash,
        "name": record.name,
        "role": record.role,
        "tenant_id": record.tenant_id,
    }


def authenticate_user(email: str, password: str, session=None) -> Optional[dict]:
    """Authenticate a user by email and password."""
    for user in USERS_DB.values():
        if user["email"] == email and verify_password(password, user["password_hash"]):
            return user
    # Fallback: check DB (handles restarts where USERS_DB was not rehydrated)
    if session:
        from sqlmodel import select
        from app.models import UserRecord
        record = session.exec(select(UserRecord).where(UserRecord.email == email)).first()
        if record and verify_password(password, record.password_hash):
            user = _user_record_to_dict(record)
            USERS_DB[record.id] = user
            return user
    return None


def get_user_by_id(user_id: str, session=None) -> Optional[dict]:
    """Get a user by ID."""
    if user_id in USERS_DB:
        return USERS_DB[user_id]
    if session:
        from app.models import UserRecord
        record = session.get(UserRecord, user_id)
        if record:
            user = _user_record_to_dict(record)
            USERS_DB[user_id] = user
            return user
    return None


def register_user(email: str, password: str, name: str, role: str = "venue_operator", session=None) -> Optional[dict]:
    """Register a new user."""
    global USER_COUNTER

    # Check in-memory and DB for duplicate email
    for user in USERS_DB.values():
        if user["email"] == email:
            return None
    if session:
        from sqlmodel import select
        from app.models import UserRecord
        if session.exec(select(UserRecord).where(UserRecord.email == email)).first():
            return None

    user_id = f"user_{USER_COUNTER:03d}"
    USER_COUNTER += 1
    tenant_id = f"venue_{USER_COUNTER:03d}" if role == "venue_operator" else None

    new_user = {
        "id": user_id,
        "email": email,
        "password_hash": create_password_hash(password),
        "name": name,
        "role": role,
        "tenant_id": tenant_id,
    }
    USERS_DB[user_id] = new_user

    if session:
        from app.models import UserRecord
        session.add(UserRecord(
            id=user_id, email=email,
            password_hash=new_user["password_hash"],
            name=name, role=role, tenant_id=tenant_id,
        ))
        session.commit()

    return new_user

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
    safe_user = {k: v for k, v in user.items() if k != "password_hash"}
    return {"access_token": token, "user": safe_user}

@router.post("/register")
def register(request: RegisterRequest, session: Session = Depends(get_session)):
    user = register_user(request.email, request.password, request.name, request.role, session)
    if not user:
        raise HTTPException(status_code=400, detail="User with this email already exists")
    token = create_token(user["id"], user["email"], user["role"], user["tenant_id"])
    safe_user = {k: v for k, v in user.items() if k != "password_hash"}
    return {"access_token": token, "user": safe_user}

@router.get("/me")
def get_me(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    
    token = authorization.split(" ")[1]
    decoded = verify_token(token)
    
    if not decoded:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
        
    user = get_user_by_id(decoded["sub"])
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    safe_user = {k: v for k, v in user.items() if k != "password_hash"}
    return safe_user