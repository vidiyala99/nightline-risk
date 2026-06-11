"""Filename safety helper shared by upload paths (path-traversal + header injection).

A neutral home so service-layer code can import it without depending on a route
module. The evidence route keeps its own private `_sanitize_filename` for now
(security-critical, separately TDD'd); consolidate in a follow-up.
"""
from __future__ import annotations

import re

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


def sanitize_filename(raw: str | None) -> str:
    """Reduce a client-supplied filename to a safe basename (falls back to 'upload')."""
    if not raw:
        return "upload"
    basename = raw.replace("\\", "/").split("/")[-1]
    cleaned = _CONTROL_CHARS.sub("", basename).replace('"', "")
    cleaned = cleaned.lstrip(". ").strip()
    return cleaned or "upload"
