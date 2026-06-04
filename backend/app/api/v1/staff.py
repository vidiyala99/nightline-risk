"""Staff roster management (the operator's 'Floor Team').

- POST /api/venues/{venue_id}/staff — provision a staff login for the venue.
  Returns a set-password token the operator relays (or that an email step can
  send later). Auth + venue-scoped (operator owns their venue; broker any).
- GET  /api/venues/{venue_id}/staff — list the venue's staff.

Staff themselves report incidents through the normal incident endpoints (gated
to their own venue) and read their own via GET /api/incidents/mine.
"""
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from app.auth import can_access_venue, current_user_optional
from app.database import get_session
from app.services.staff import StaffError, create_staff_account, list_staff

router = APIRouter()


class StaffIn(BaseModel):
    name: str
    email: str


def _staff_out(u) -> dict:
    return {"id": u.id, "venue_id": u.tenant_id, "name": u.name, "email": u.email, "role": u.role}


def _require_venue_access(authorization: str, venue_id: str, session: Session) -> dict:
    user = current_user_optional(authorization)
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
    if not can_access_venue(user, venue_id, session):
        raise HTTPException(status_code=403, detail="No access to this venue")
    return user


@router.post("/venues/{venue_id}/staff", status_code=201)
def add_staff(
    venue_id: str,
    body: StaffIn,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    _require_venue_access(authorization, venue_id, session)
    try:
        user, set_password_token = create_staff_account(
            session, venue_id=venue_id, name=body.name, email=body.email
        )
    except StaffError as e:
        raise HTTPException(status_code=409, detail={"error": "staff_exists", "message": str(e)})
    session.commit()
    session.refresh(user)
    out = _staff_out(user)
    # The operator relays this to the new staff member to set their password
    # (an email step can deliver it automatically later).
    out["set_password_token"] = set_password_token
    return out


@router.get("/venues/{venue_id}/staff")
def get_staff(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
):
    _require_venue_access(authorization, venue_id, session)
    return [_staff_out(u) for u in list_staff(session, venue_id)]
