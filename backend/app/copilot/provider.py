from __future__ import annotations

from abc import ABC, abstractmethod

from app.copilot.schemas import AnswerType, CopilotReply

# Ordered keyword ladder: first matching intent wins. Over-fit guards live in tests.
# Mirrors the discipline of app/providers/deterministic.py's risk classifier.
# Note: claims uses "filed" (not "file") so "did anyone file a report?" routes to
# list_incidents, not list_open_claims — a real collision resolved by ladder order.
_INTENT_LADDER: list[tuple[set[str], str]] = [
    ({"risk", "score", "tier", "rating"}, "get_risk_score"),
    ({"claim", "claims", "filed", "reserve", "reserves"}, "list_open_claims"),
    ({"incident", "incidents", "report", "reports", "status"}, "list_incidents"),
    ({"exposure", "exposed", "attention", "overdue", "evidence", "compliance", "risky"}, "get_exposure"),
]

_REFUSAL = ("I can help with your venue's exposure, risk score, open claims, and compliance. "
            "Try: “what needs my attention?” or “why is my risk a C?”")


def _classify(message: str) -> str | None:
    words = set(message.lower().replace("?", " ").replace("'", " ").split())
    for keys, tool in _INTENT_LADDER:
        if words & keys:
            return tool
    return None


class ChatProvider(ABC):
    @abstractmethod
    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply: ...


class DeterministicChatProvider(ChatProvider):
    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply:
        tool = _classify(message)
        if tool is None:
            return CopilotReply(answer_type=AnswerType.refuse, text=_REFUSAL)
        result = tools.run(tool, {})
        return CopilotReply(answer_type=AnswerType.answer, text=_template(tool, result), citations=result.citations)


def _template(tool: str, r) -> str:
    d = r.data
    if tool == "get_risk_score":
        return f"Your venue's risk is {d.get('score', '?')}/100, tier {d.get('tier', '?')}. Weakest driver: {d.get('top_factor', '—')}."
    if tool == "get_exposure":
        return (f"{d['count']} thing(s) need your attention." if d.get("count")
                else "Nothing needs your attention right now.")
    if tool == "list_open_claims":
        return f"You have {d.get('count', 0)} open claim(s)."
    if tool == "list_incidents":
        return f"{d.get('count', 0)} active report(s)."
    return "Done."
