"""FastAPI endpoints for Phase 2 policy lifecycle.

Mounted at /api by main.py. All endpoints broker/admin-gated via
require_broker. The /pdf endpoint returns a JSON envelope describing
where the PDF would live in production (blob storage URL); actual PDF
rendering is a Phase 5 (defense package) work item — Phase 2 stops at
the data layer for COIs.

Error mapping mirrors the placement router pattern:
  - PoliciesError → 400
  - QuoteNotBindableError → 422 with structured {error, message}
  - EndorsementValidationError → 422 with structured {error, message}
  - InvalidTransitionError → 422
  - Service rollback before re-raise
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import NoReturn, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.api.v1.placement import _broker_user_id
from app.auth import require_broker, require_venue_access
from app.database import get_session
from app.lifecycles import InvalidTransitionError
from app.models import CertificateOfInsurance, Endorsement, Policy
from app.services.policies import (
    PoliciesError,
    QuoteNotBindableError,
    assign_policy_number,
    bind_quote,
    cancel_policy,
    expire_policy,
    issue_certificate,
    issue_endorsement,
    lapse_policy,
    list_policies,
    non_renew_policy,
    reinstate_policy,
)


router = APIRouter()


# Auth helper `_broker_user_id` is imported above from the placement
# module — that's where it has the `Header(None)` annotation FastAPI
# needs to extract the Authorization header. Re-declaring it here
# without the annotation broke the extraction (header arrived as None),
# producing 401s on every authenticated endpoint.


# ─── Request/response models ────────────────────────────────────────────


class BindQuoteBody(BaseModel):
    policy_number: Optional[str] = None
    effective_date: Optional[date] = None
    term_length_days: int = 365


class AssignPolicyNumberBody(BaseModel):
    policy_number: str = Field(..., min_length=1)


class IssueEndorsementBody(BaseModel):
    endorsement_type: str
    effective_date: date
    terms_diff: dict
    premium_change: Decimal = Decimal("0.00")
    tax_change: Decimal = Decimal("0.00")
    description: str = ""


class CancelPolicyBody(BaseModel):
    reason: str = Field(..., min_length=1)
    method: str = Field(..., description="'pro_rata' | 'short_rate'")
    cancellation_date: date


class PolicyTransitionBody(BaseModel):
    """Optional reason for an end-of-life transition (expire/reinstate accept
    none; non-renew/lapse want one for the audit trail)."""
    reason: str = ""


class IssueCertificateBody(BaseModel):
    certificate_holder: str = Field(..., min_length=1)
    certificate_holder_address: str = Field(..., min_length=1)
    description_of_operations: str = Field(..., min_length=1)
    expires_on: date
    additional_insured: bool = False
    additional_insured_scope: Optional[str] = None


def _policy_to_dict(p: Policy) -> dict:
    return {
        "id": p.id,
        "policy_number": p.policy_number,
        "submission_id": p.submission_id,
        "bound_quote_id": p.bound_quote_id,
        "venue_id": p.venue_id,
        "carrier_id": p.carrier_id,
        "status": p.status,
        "effective_date": p.effective_date.isoformat(),
        "expiration_date": p.expiration_date.isoformat(),
        "annual_premium": str(p.annual_premium),
        "commission_amount": str(p.commission_amount),
        "commission_rate": str(p.commission_rate),
        "commission_paid_at": p.commission_paid_at.isoformat() if p.commission_paid_at else None,
        "coverage_lines": p.coverage_lines,
        "terms_snapshot": p.terms_snapshot,
        "snapshot_hash": p.snapshot_hash,
        "cancelled_at": p.cancelled_at.isoformat() if p.cancelled_at else None,
        "cancellation_reason": p.cancellation_reason,
        "cancellation_method": p.cancellation_method,
        "refund_amount": str(p.refund_amount) if p.refund_amount is not None else None,
        "bound_at": p.bound_at.isoformat(),
    }


def _endorsement_to_dict(e: Endorsement) -> dict:
    return {
        "id": e.id,
        "policy_id": e.policy_id,
        "endorsement_type": e.endorsement_type,
        "effective_date": e.effective_date.isoformat(),
        "description": e.description,
        "premium_change": str(e.premium_change),
        "tax_change": str(e.tax_change),
        "terms_diff": e.terms_diff,
        "issued_at": e.issued_at.isoformat(),
        "created_by": e.created_by,
    }


def _coi_to_dict(c: CertificateOfInsurance) -> dict:
    return {
        "id": c.id,
        "policy_id": c.policy_id,
        "certificate_holder": c.certificate_holder,
        "certificate_holder_address": c.certificate_holder_address,
        "additional_insured": c.additional_insured,
        "additional_insured_scope": c.additional_insured_scope,
        "description_of_operations": c.description_of_operations,
        "status": c.status,
        "issued_at": c.issued_at.isoformat(),
        "expires_on": c.expires_on.isoformat(),
        "pdf_path": c.pdf_path,
        "issued_by": c.issued_by,
    }


def _map_service_error(e: Exception) -> NoReturn:
    """Common service-error → HTTP-status mapping. Always raises;
    declared NoReturn so callers don't need an unreachable return."""
    if isinstance(e, QuoteNotBindableError):
        raise HTTPException(
            status_code=422,
            detail={"error": "quote_not_bindable", "message": str(e)},
        )
    if isinstance(e, InvalidTransitionError):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_transition", "message": str(e)},
        )
    if isinstance(e, PoliciesError):
        raise HTTPException(status_code=400, detail=str(e))
    raise e


# ─── Bind ────────────────────────────────────────────────────────────────


@router.post("/quotes/{qid}/bind", status_code=201, dependencies=[Depends(require_broker)])
def api_bind_quote(
    qid: str,
    body: BindQuoteBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Bind a selected CarrierQuote into a Policy. ATOMIC — see
    services/policies.py.bind_quote() for the 6-step transaction."""
    try:
        policy = bind_quote(
            session,
            qid,
            policy_number=body.policy_number,
            effective_date=body.effective_date,
            term_length_days=body.term_length_days,
            bound_by=user_id,
        )
        # A bind on a prospect venue promotes it into the book (same txn).
        from app.prospects import convert_prospect_to_book
        convert_prospect_to_book(session, policy.venue_id)
        session.commit()
        return _policy_to_dict(policy)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


# ─── Policies ───────────────────────────────────────────────────────────


@router.get("/policies", dependencies=[Depends(require_broker)])
def api_list_policies(
    status: Optional[str] = None,
    venue_id: Optional[str] = None,
    carrier_id: Optional[str] = None,
    session: Session = Depends(get_session),
) -> list[dict]:
    """List policies. `status` is comma-separated for multi-status, OR
    the literal 'all' to retrieve every state. Without status, returns
    only active policies — the broker's working book."""
    if status is None:
        status_in = None
    elif status == "all":
        status_in = ["all"]
    else:
        status_in = [s.strip() for s in status.split(",")]
    rows = list_policies(
        session,
        status_in=status_in,
        venue_id=venue_id,
        carrier_id=carrier_id,
    )
    return [_policy_to_dict(p) for p in rows]


@router.get("/venues/{venue_id}/policies")
def api_list_venue_policies(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Policies for a single venue — the operator's read-only 'My Coverage'
    surface. Unlike GET /policies (broker-only), this is tenant-gated via
    require_venue_access, so a venue operator can see their own venue's
    coverage (and brokers, who have cross-venue access, can see any).

    Returns every status so the operator sees current + lapsed/expired
    history; the frontend foregrounds the active policy."""
    require_venue_access(venue_id, authorization, session)
    rows = list_policies(session, status_in=["all"], venue_id=venue_id)
    return [_policy_to_dict(p) for p in rows]


@router.get("/policies/{pid}", dependencies=[Depends(require_broker)])
def api_policy_detail(pid: str, session: Session = Depends(get_session)) -> dict:
    p = session.get(Policy, pid)
    if p is None:
        raise HTTPException(status_code=404, detail=f"Policy {pid} not found")
    endorsements = session.exec(
        select(Endorsement).where(Endorsement.policy_id == pid)
    ).all()
    certificates = session.exec(
        select(CertificateOfInsurance).where(CertificateOfInsurance.policy_id == pid)
    ).all()
    return {
        **_policy_to_dict(p),
        "endorsements": [_endorsement_to_dict(e) for e in endorsements],
        "certificates": [_coi_to_dict(c) for c in certificates],
    }


@router.patch("/policies/{pid}/policy-number", dependencies=[Depends(require_broker)])
def api_assign_policy_number(
    pid: str,
    body: AssignPolicyNumberBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        p = assign_policy_number(
            session, pid, policy_number=body.policy_number, assigned_by=user_id,
        )
        session.commit()
        return _policy_to_dict(p)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/policies/{pid}/cancel", dependencies=[Depends(require_broker)])
def api_cancel_policy(
    pid: str,
    body: CancelPolicyBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        p = cancel_policy(
            session, pid,
            reason=body.reason,
            method=body.method,
            cancellation_date=body.cancellation_date,
            cancelled_by=user_id,
        )
        session.commit()
        return _policy_to_dict(p)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


# ─── End-of-life transitions ─────────────────────────────────────────────


@router.post("/policies/{pid}/expire", dependencies=[Depends(require_broker)])
def api_expire_policy(
    pid: str,
    body: PolicyTransitionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Mark a policy expired at end of term ('active' → 'expired')."""
    try:
        p = expire_policy(session, pid, reason=body.reason, actor_id=user_id)
        session.commit()
        return _policy_to_dict(p)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/policies/{pid}/non-renew", dependencies=[Depends(require_broker)])
def api_non_renew_policy(
    pid: str,
    body: PolicyTransitionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Decline to renew at term end ('active' → 'non_renewed')."""
    try:
        p = non_renew_policy(session, pid, reason=body.reason, actor_id=user_id)
        session.commit()
        return _policy_to_dict(p)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/policies/{pid}/lapse", dependencies=[Depends(require_broker)])
def api_lapse_policy(
    pid: str,
    body: PolicyTransitionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Premium unpaid ('active' → 'lapsed'); reversible via /reinstate."""
    try:
        p = lapse_policy(session, pid, reason=body.reason, actor_id=user_id)
        session.commit()
        return _policy_to_dict(p)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.post("/policies/{pid}/reinstate", dependencies=[Depends(require_broker)])
def api_reinstate_policy(
    pid: str,
    body: PolicyTransitionBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    """Bring a lapsed policy back in force ('lapsed' → 'active')."""
    try:
        p = reinstate_policy(session, pid, reason=body.reason, actor_id=user_id)
        session.commit()
        return _policy_to_dict(p)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


# ─── Endorsements ───────────────────────────────────────────────────────


@router.post("/policies/{pid}/endorsements", status_code=201, dependencies=[Depends(require_broker)])
def api_issue_endorsement(
    pid: str,
    body: IssueEndorsementBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        end = issue_endorsement(
            session, pid,
            endorsement_type=body.endorsement_type,
            effective_date=body.effective_date,
            terms_diff=body.terms_diff,
            premium_change=body.premium_change,
            tax_change=body.tax_change,
            description=body.description,
            issued_by=user_id,
        )
        session.commit()
        return _endorsement_to_dict(end)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.get("/policies/{pid}/endorsements", dependencies=[Depends(require_broker)])
def api_list_endorsements(pid: str, session: Session = Depends(get_session)) -> list[dict]:
    if session.get(Policy, pid) is None:
        raise HTTPException(status_code=404, detail=f"Policy {pid} not found")
    rows = session.exec(
        select(Endorsement).where(Endorsement.policy_id == pid)
    ).all()
    return [_endorsement_to_dict(e) for e in rows]


# ─── Certificates of Insurance ──────────────────────────────────────────


@router.post("/policies/{pid}/certificates", status_code=201, dependencies=[Depends(require_broker)])
def api_issue_certificate(
    pid: str,
    body: IssueCertificateBody,
    user_id: str = Depends(_broker_user_id),
    session: Session = Depends(get_session),
) -> dict:
    try:
        coi = issue_certificate(
            session, pid,
            certificate_holder=body.certificate_holder,
            certificate_holder_address=body.certificate_holder_address,
            description_of_operations=body.description_of_operations,
            expires_on=body.expires_on,
            additional_insured=body.additional_insured,
            additional_insured_scope=body.additional_insured_scope,
            issued_by=user_id,
        )
        session.commit()
        return _coi_to_dict(coi)
    except (PoliciesError, InvalidTransitionError) as e:
        session.rollback()
        _map_service_error(e)


@router.get("/policies/{pid}/certificates", dependencies=[Depends(require_broker)])
def api_list_certificates(
    pid: str,
    include: Optional[str] = None,    # ?include=superseded to see history
    session: Session = Depends(get_session),
) -> list[dict]:
    if session.get(Policy, pid) is None:
        raise HTTPException(status_code=404, detail=f"Policy {pid} not found")
    stmt = select(CertificateOfInsurance).where(CertificateOfInsurance.policy_id == pid)
    if include != "superseded" and include != "all":
        stmt = stmt.where(CertificateOfInsurance.status == "active")
    rows = session.exec(stmt).all()
    return [_coi_to_dict(c) for c in rows]


@router.get("/certificates/{coi_id}/pdf", dependencies=[Depends(require_broker)])
def api_certificate_pdf(coi_id: str, session: Session = Depends(get_session)) -> Response:
    """Render the certificate as a downloadable PDF (ACORD-25 flavored).
    Reuses the reportlab layout shared with the defense-package export."""
    from app.coi_pdf import render_coi_pdf
    from app.packet_core import _add_audit_event

    c = session.get(CertificateOfInsurance, coi_id)
    if c is None:
        raise HTTPException(status_code=404, detail=f"Certificate {coi_id} not found")
    policy = session.get(Policy, c.policy_id)
    pdf = render_coi_pdf(c, policy)
    _add_audit_event(
        session=session, actor_id="system", actor_type="user",
        entity_type="certificate_of_insurance", entity_id=coi_id,
        event_type="certificate.pdf_exported", event_metadata={},
    )
    session.commit()
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="coi-{coi_id}.pdf"'},
    )
