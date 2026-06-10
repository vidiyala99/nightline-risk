from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Optional

from sqlmodel import Session

from app.copilot.anthropic_provider import get_chat_provider
from app.copilot.faithfulness import assert_grounded
from app.copilot.schemas import AnswerType, CopilotReply, ProposedAction
from app.copilot.tools import (
    CopilotScope, TOOL_CATALOG,
    validate_send_to_broker, execute_send_to_broker,
    execute_resolve_compliance,
)
from app.intelligence.engine import accessible_venue_ids
from app.schemas.domain import Citation
from app.time import now_utc

logger = logging.getLogger(__name__)

_ACT_INTENT = re.compile(r"\b(send|file|submit)\b.*\bbroker\b|\bresolve\b.*\b(compliance|item)\b", re.I)
_ID = re.compile(r"\b(inc-[\w-]+)\b")  # fixture incident ids are "inc-borderline"


class _ToolBridge:
    def __init__(self, scope: CopilotScope):
        self._scope = scope
        self._by_name = {t.name: t for t in TOOL_CATALOG}
        self.catalog_names = {t.name for t in TOOL_CATALOG if t.kind == "read"}
        self.last_results = []

    def run(self, name, args):
        res = self._by_name[name].run(self._scope, args)
        self.last_results.append(res)
        return res


def _scope_for(user: dict, session: Session, now: datetime) -> CopilotScope:
    return CopilotScope(user=user, venue_ids=accessible_venue_ids(user, session), session=session, now=now)


def respond_to_message(user: dict, session: Session, message: str,
                       *, confirm_action: Optional[ProposedAction] = None,
                       attachment=None, now: Optional[datetime] = None) -> CopilotReply:
    now = now or now_utc()
    scope = _scope_for(user, session, now)

    if confirm_action is not None:
        return _execute_confirmed(scope, confirm_action, attachment)

    if _ACT_INTENT.search(message):
        return _propose_action(scope, message)

    bridge = _ToolBridge(scope)
    reply = get_chat_provider().respond(message, tools=bridge)
    if reply.answer_type == AnswerType.answer:
        g = assert_grounded(reply.text, bridge.last_results)
        if not g.ok:
            # Downgrade an ungrounded answer, but preserve the telemetry source
            # so the LLM-vs-deterministic fallback rate stays measurable.
            reply = CopilotReply(answer_type=AnswerType.clarify,
                                 text="I can only speak to what your records show — let me pull the exact figures.",
                                 citations=[c for r in bridge.last_results for c in r.citations],
                                 source=reply.source)
    _log_telemetry(reply)
    return reply


def _log_telemetry(reply: CopilotReply) -> None:
    """One structured line per copilot turn so prod can aggregate the
    LLM-vs-deterministic fallback rate (the audit's "measured fallback-rate").
    Cheap and side-effect-free; never raises."""
    logger.info(
        "copilot.reply source=%s answer_type=%s", reply.source, reply.answer_type.value
    )


def _propose_action(scope: CopilotScope, message: str) -> CopilotReply:
    m = _ID.search(message)
    if "broker" in message.lower():
        if not m:
            return CopilotReply(answer_type=AnswerType.clarify, text="Which incident should I send? Tell me its id.")
        v = validate_send_to_broker(scope, m.group(1))
        if not v.ok:
            return CopilotReply(answer_type=AnswerType.refuse, text=v.reason)
        # Cite the recommendation the summary quotes, so the net-EV figure in the
        # propose text is grounded (faithfulness guard / scorer treat a cited
        # number as supported — it's a real quote of the rec, not a guess).
        return CopilotReply(
            answer_type=AnswerType.propose_action,
            text=v.proposed.summary,
            proposed_action=v.proposed,
            citations=[Citation(source_id=v.proposed.target_id, source_type="recommendation",
                                excerpt=v.proposed.summary)],
        )
    return CopilotReply(answer_type=AnswerType.clarify,
                        text="Tell me which compliance item to resolve and attach the evidence.")


def _execute_confirmed(scope: CopilotScope, action: ProposedAction, attachment) -> CopilotReply:
    if action.kind == "send_to_broker":
        v = validate_send_to_broker(scope, action.target_id)
        if not v.ok:
            return CopilotReply(answer_type=AnswerType.refuse, text=v.reason)
        res = execute_send_to_broker(scope, action.target_id)
        return CopilotReply(answer_type=AnswerType.answer,
                            text="Sent to your broker — it's now awaiting their decision.",
                            citations=res.citations)
    if action.kind == "resolve_compliance":
        fb = attachment or {}
        res = execute_resolve_compliance(scope, action.target_id,
                                         file_bytes=fb.get("file_bytes"), filename=fb.get("filename"),
                                         content_type=fb.get("content_type"))
        if not res.data.get("executed"):
            return CopilotReply(answer_type=AnswerType.refuse, text=res.data.get("reason", "Couldn't resolve that."))
        return CopilotReply(answer_type=AnswerType.answer, text="Evidence uploaded — that compliance item is resolved.",
                            citations=res.citations)
    return CopilotReply(answer_type=AnswerType.refuse, text="I can't take that action.")
