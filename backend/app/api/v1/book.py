"""Broker Book financials — money rollup across the in-force book.

The dashboard/portfolio surface answers risk questions; this answers money
ones (written/earned premium, commission revenue, incurred losses, loss
ratio) with per-coverage-line and per-carrier breakdowns. Broker-only —
operators are scoped to their own venue and have no book-wide view.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session

from app.auth import require_broker
from app.database import get_session
from app.services.book import book_financials

router = APIRouter()


@router.get("/book/financials")
def get_book_financials(
    session: Session = Depends(get_session),
    user: dict = Depends(require_broker),
) -> dict:
    """Single broker-facing money rollup over the in-force book."""
    return book_financials(session)
