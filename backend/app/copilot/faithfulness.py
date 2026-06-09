from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.copilot.schemas import ToolResult

_NUM = re.compile(r"\$?\d[\d,]*(?:\.\d+)?%?")


@dataclass
class GroundCheck:
    ok: bool
    unsupported: list[str] = field(default_factory=list)


def _supported_strings(tool_results: list[ToolResult]) -> str:
    parts: list[str] = []
    for tr in tool_results:
        parts.append(str(tr.data))
        parts.extend(c.excerpt for c in tr.citations)
    return " ".join(parts)


def assert_grounded(text: str, tool_results: list[ToolResult]) -> GroundCheck:
    """Every numeric/currency token in the reply must appear in some tool result.
    Deterministic and conservative: numbers (scores, money, counts) are the
    high-risk hallucination surface for this domain."""
    haystack = _supported_strings(tool_results)
    hay_nums = set(_NUM.findall(haystack.replace(",", "")))
    unsupported = [t for t in _NUM.findall(text.replace(",", "")) if t not in hay_nums]
    return GroundCheck(ok=not unsupported, unsupported=unsupported)
