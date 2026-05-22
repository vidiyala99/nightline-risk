"""Unified error envelope for 4xx/5xx responses across all routers.

Background: pre-Phase-A, this codebase had four different 4xx response
shapes — `{error, message}` (placement quotes), `{detail: str}` (claims),
narrative-string `detail` (legacy main.py 409s), and bare `detail` (auth).
The frontend had to branch on shape to extract a usable message.

This module defines a single `ErrorEnvelope` shape that ALL routes should
emit on failure:

    {"error": "<machine_code>", "message": "<human_text>", "details": <opt>}

Field semantics:
    error:    a stable machine-readable code (snake_case). Used by the
              frontend to switch on (e.g. "quote_not_bindable" branches
              to the "show carrier-out-of-appetite warning" UI). Stable
              across releases.
    message:  human-readable, may be shown to the user as-is. Free-form.
    details:  optional dict for structured context (field-level
              validation errors, retry-after seconds, etc.). Omit when
              not needed.

Migration policy: legacy routes that emit `{"detail": "..."}` should
move to `error_response(...)`. The frontend's PlacementApiError already
handles both shapes (see `lib/placement.ts`); once all 4xx surfaces are
migrated, the legacy branch can be dropped.

Helpers:
  - `error_response(error, message, status_code, details=None)`:
    convenience factory; returns an HTTPException with the envelope.
  - `wrap_service_error(e, status_code, error_code)`:
    converts a ServiceError-style exception into the envelope.
"""
from __future__ import annotations

from typing import Optional, Any

from fastapi import HTTPException
from pydantic import BaseModel


class ErrorEnvelope(BaseModel):
    """Pydantic shape for OpenAPI documentation. The actual 4xx response
    body is constructed via `error_response()` below since FastAPI's
    HTTPException doesn't accept a Pydantic model directly as `detail`."""
    error: str
    message: str
    details: Optional[dict[str, Any]] = None


def error_response(
    error: str,
    message: str,
    *,
    status_code: int,
    details: Optional[dict[str, Any]] = None,
) -> HTTPException:
    """Build an HTTPException carrying the standard envelope as `detail`.

    Usage:
        raise error_response(
            "incident_status_invalid",
            "Status must be one of: open, under_review, closed",
            status_code=400,
        )
    """
    body: dict[str, Any] = {"error": error, "message": message}
    if details is not None:
        body["details"] = details
    return HTTPException(status_code=status_code, detail=body)
