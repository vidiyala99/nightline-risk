"""Risk Intelligence Layer API — the proactive exposure surface.

GET /api/intelligence/exposure returns the caller's persona-scoped, ranked
findings. Persona + data scope are enforced in code (engine + auth gates),
never in a prompt."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from sqlmodel import Session

from app.auth import verify_token
from app.database import get_session
from app.intelligence.engine import compute_exposure
from app.schemas.intelligence import ExposureResponse, FindingOut

router = APIRouter()


@router.get("/intelligence/exposure", response_model=ExposureResponse)
def get_exposure(
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> ExposureResponse:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    user = verify_token(authorization.split(" ")[1])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    findings = compute_exposure(user, session)
    return ExposureResponse(
        persona=user.get("role", ""),
        findings=[FindingOut(**f.model_dump()) for f in findings],
    )
