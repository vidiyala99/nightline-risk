from __future__ import annotations

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field

from app.schemas.domain import Citation


class AnswerType(str, Enum):
    answer = "answer"
    clarify = "clarify"
    refuse = "refuse"
    propose_action = "propose_action"


class ToolResult(BaseModel):
    tool: str
    data: dict[str, Any] = Field(default_factory=dict)
    citations: list[Citation] = Field(default_factory=list)


class ProposedAction(BaseModel):
    kind: str                 # "send_to_broker" | "resolve_compliance"
    target_id: str            # incident_id | compliance item_id
    summary: str              # human-readable confirmation text
    gating_passed: bool       # hint only; server re-validates on confirm
    requires_attachment: bool = False


class CopilotTurn(BaseModel):
    message: str
    confirm_action: Optional[ProposedAction] = None


class ReplyLink(BaseModel):
    """A navigation affordance: a count/status answer surfaces the number, then
    a single link to the full list (e.g. "View active incidents" -> /incidents)
    instead of dumping every row as a citation chip."""
    label: str
    href: str


class CopilotReply(BaseModel):
    answer_type: AnswerType
    text: str
    citations: list[Citation] = Field(default_factory=list)
    proposed_action: Optional[ProposedAction] = None
    followups: list[str] = Field(default_factory=list)
    link: Optional[ReplyLink] = None
    # Telemetry: which provider produced this reply. "deterministic" (no-key
    # keyword path), "llm" (the configured LLM answered), or "llm_fallback" (the
    # LLM was tried but degraded to deterministic — e.g. rate-limit, no model,
    # ungrounded output). Lets prod measure the LLM-vs-fallback rate.
    source: str = "deterministic"
