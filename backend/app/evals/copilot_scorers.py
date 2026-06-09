from __future__ import annotations

from app.copilot.faithfulness import assert_grounded
from app.copilot.schemas import AnswerType, CopilotReply, ToolResult


def intent_routing_accuracy(*, expected: str, actual: str | None) -> float:
    return 1.0 if actual == expected else 0.0


def faithfulness_score(reply: CopilotReply, tool_results: list[ToolResult]) -> float:
    return 1.0 if assert_grounded(reply.text, tool_results).ok else 0.0


def refusal_correctness(*, should_refuse: bool, reply: CopilotReply) -> float:
    refused = reply.answer_type == AnswerType.refuse
    return 1.0 if refused == should_refuse else 0.0


def action_appropriateness(*, should_propose: bool, reply: CopilotReply) -> float:
    proposed = reply.answer_type == AnswerType.propose_action and reply.proposed_action is not None
    return 1.0 if proposed == should_propose else 0.0
