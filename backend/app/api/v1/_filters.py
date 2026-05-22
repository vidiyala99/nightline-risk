"""Shared query-string parsing helpers for v1/ routers.

Pulled out of individual router files so the CSV-status-filter inconsistency
flagged in the CTO audit (placement.py vs claims.py used subtly different
parsing) goes away.
"""
from __future__ import annotations

from typing import Optional


def parse_status_filter(raw: Optional[str]) -> Optional[list[str]]:
    """Translate a ?status=... query parameter into the shape expected by
    list_* service functions.

    Contract:
      - None / missing → None (caller decides the default; usually "active"-only)
      - "all"           → ["all"] (sentinel meaning "skip the filter entirely")
      - "a,b,c"         → ["a", "b", "c"] (trimmed, empties dropped)

    Used by /api/policies, /api/claims, /api/policies/{pid}/claims,
    /api/submissions — anywhere a comma-separated list of typed lifecycle
    statuses is acceptable.
    """
    if raw is None:
        return None
    if raw == "all":
        return ["all"]
    parts = [s.strip() for s in raw.split(",")]
    cleaned = [s for s in parts if s]
    return cleaned or None
