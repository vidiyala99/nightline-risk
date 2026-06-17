"""Risk Intelligence Copilot API — the operator chat surface.

POST /api/copilot/message handles read questions and the send-to-broker
action. POST /api/copilot/message/confirm is the multipart variant that
carries the uploaded file bytes for the compliance-resolution action.

The copilot is an operator-only surface in v1: anonymous callers get 401,
non-operators get 403. Persona/data scope is enforced in code, never in a
prompt."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from sqlmodel import Session

from app.auth import verify_token
from app.copilot.engine import respond_to_message
from app.copilot.rate_limit import COPILOT_LIMITER
from app.copilot.schemas import CopilotReply, CopilotTurn, ProposedAction
from app.database import get_session

router = APIRouter()


def _operator(authorization: str | None) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    user = verify_token(authorization.split(" ")[1])
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if user.get("role") != "venue_operator":
        raise HTTPException(status_code=403, detail="Copilot is an operator surface in v1.")
    return user


def _check_rate_limit(user: dict) -> None:
    """Per-user cap so one token can't burn unbounded LLM credits. Keyed on the
    token subject; rejects with 429 once the per-minute window is exhausted."""
    if not COPILOT_LIMITER.allow(user.get("sub") or "anon"):
        raise HTTPException(
            status_code=429,
            detail="Too many copilot requests — give it a moment and try again.",
        )


@router.post("/copilot/message", response_model=CopilotReply)
def copilot_message(
    turn: CopilotTurn,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> CopilotReply:
    user = _operator(authorization)
    _check_rate_limit(user)
    return respond_to_message(user, session, turn.message, confirm_action=turn.confirm_action)


@router.post("/copilot/message/confirm", response_model=CopilotReply)
async def copilot_confirm(
    authorization: str = Header(None),
    confirm_action: str = Form(...),
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
) -> CopilotReply:
    user = _operator(authorization)
    _check_rate_limit(user)
    action = ProposedAction(**json.loads(confirm_action))
    contents = await file.read()
    attachment = {
        "file_bytes": contents,
        "filename": file.filename,
        "content_type": file.content_type,
    }
    return respond_to_message(user, session, "", confirm_action=action, attachment=attachment)
