from __future__ import annotations

import os

from app.copilot.provider import ChatProvider, DeterministicChatProvider
from app.copilot.schemas import CopilotReply


class AnthropicChatProvider(ChatProvider):
    """Key-gated. Same tool catalog; the model does NL + phrasing and emits a
    <<<META>>> tail (answer_type/citations/followups). The engine runs the
    faithfulness guard over .text. Only active when ANTHROPIC_API_KEY is set;
    never exercised in CI. v1 delegates to deterministic until the Messages-API
    call is wired (a key-gated follow-up), so the contract holds and the upgrade
    is one method away."""
    MODEL = "claude-haiku-4-5-20251001"

    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply:
        return DeterministicChatProvider().respond(message, tools=tools, confirm_action=confirm_action)


def get_chat_provider() -> ChatProvider:
    if os.getenv("ANTHROPIC_API_KEY"):
        return AnthropicChatProvider()
    return DeterministicChatProvider()
