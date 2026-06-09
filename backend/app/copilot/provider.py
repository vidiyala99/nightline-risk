from __future__ import annotations

from abc import ABC, abstractmethod

from app.copilot.schemas import AnswerType, CopilotReply, ReplyLink

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
        # Count/status answers carry a single navigation link (set by the tool in
        # data) instead of a wall of per-item citations.
        nav_href = result.data.get("nav_href")
        link = ReplyLink(label=result.data.get("nav_label", "View"), href=nav_href) if nav_href else None
        return CopilotReply(
            answer_type=AnswerType.answer,
            text=_template(tool, result),
            citations=result.citations,
            link=link,
        )


def _template(tool: str, r) -> str:
    d = r.data
    if tool == "get_risk_score":
        factor = str(d.get("top_factor", "")).replace("_", " ") or "—"
        return f"Your venue's risk is {d.get('score', '?')}/100 — tier {d.get('tier', '?')}. Weakest driver: {factor}."
    if tool == "get_exposure":
        n = d.get("count", 0)
        return f"{n} thing(s) need your attention." if n else "Nothing needs your attention right now."
    if tool == "list_open_claims":
        n = d.get("count", 0)
        return f"You have {n} open claim(s)." if n else "You have no open claims."
    if tool == "list_incidents":
        n = d.get("count", 0)
        return f"You have {n} open incident(s)." if n else "You have no open incidents."
    return "Done."
