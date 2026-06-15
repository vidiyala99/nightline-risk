"""OpenAI-compatible copilot provider (spec §3,9).

One provider that drives ANY OpenAI-compatible chat endpoint — Ollama (local,
keyless), Groq (free tier), OpenRouter, vLLM, … — selected purely by env vars:

    COPILOT_LLM_BASE_URL   e.g. http://localhost:11434/v1   (Ollama)
                           e.g. https://api.groq.com/openai/v1
    COPILOT_LLM_MODEL      e.g. llama3.1:8b  /  llama-3.3-70b-versatile
    COPILOT_LLM_API_KEY    optional (Ollama needs none; Groq/OpenRouter do)

Safety is structural, not trusted to the model:
  - The model may only CALL the read tools — it never receives free rein to
    state numbers. It picks a tool; we run the real (venue-gated) tool; the
    model phrases the answer from that result.
  - The engine still runs the faithfulness guard over the final text against
    the tool results, so an ungrounded number is downgraded — same gate the
    deterministic path uses.
  - Actions never reach this provider: the engine intercepts action intents
    before calling it, so confirm-gated mutations stay deterministic.
  - ANY failure (no model, network, bad response, no tool chosen) falls back to
    the deterministic provider — the copilot never hard-fails.
"""
from __future__ import annotations

import json
import os
import time

from app.copilot.prompts import SYSTEM_PROMPT, TOOL_DESCRIPTIONS
from app.copilot.provider import ChatProvider, DeterministicChatProvider, _REFUSAL
from app.copilot.schemas import AnswerType, CopilotReply, ReplyLink


def _tool_defs() -> list[dict]:
    # Read tools only — actions are handled deterministically before this provider.
    from app.copilot.tools import TOOL_CATALOG
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": TOOL_DESCRIPTIONS.get(t.name, t.name),
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        }
        for t in TOOL_CATALOG
        if t.kind == "read"
    ]


class OpenAICompatibleChatProvider(ChatProvider):
    MODEL_ENV = "COPILOT_LLM_MODEL"
    BASE_URL_ENV = "COPILOT_LLM_BASE_URL"
    API_KEY_ENV = "COPILOT_LLM_API_KEY"

    # Default base URL applied when only a model+key are configured (e.g. the
    # xAI Grok subclass, where LLM_BASE_URL may be left implicit).
    DEFAULT_BASE_URL = ""

    # Transient rate-limit handling: free tiers (Groq) 429 under load. Retry a
    # couple of times with exponential backoff before degrading to deterministic,
    # so a momentary 429 doesn't silently demote an answer the user can see.
    MAX_RETRIES = 2
    _BACKOFF_BASE_SECONDS = 0.5
    _BACKOFF_CAP_SECONDS = 8.0

    def __init__(self) -> None:
        self.base_url = (os.getenv(self.BASE_URL_ENV) or self.DEFAULT_BASE_URL).rstrip("/")
        self.model = os.getenv(self.MODEL_ENV) or ""
        self.api_key = os.getenv(self.API_KEY_ENV)
        if not self.base_url or not self.model:
            raise ValueError(
                f"{self.BASE_URL_ENV} and {self.MODEL_ENV} must be set for the LLM copilot provider."
            )

    # ── HTTP seams (mocked in tests) ─────────────────────────────────────────
    def _post_chat(self, payload: dict, headers: dict):
        """Raw POST to the chat-completions endpoint. Returns the httpx Response
        un-raised so the retry layer can inspect the status code."""
        import httpx

        with httpx.Client(timeout=45.0) as client:
            return client.post(
                f"{self.base_url}/chat/completions", json=payload, headers=headers
            )

    def _sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def _backoff_seconds(self, attempt: int, resp) -> float:
        # Honor a Retry-After header if the provider sends one; else exp backoff.
        retry_after = (getattr(resp, "headers", None) or {}).get("Retry-After")
        if retry_after:
            try:
                return min(float(retry_after), self._BACKOFF_CAP_SECONDS)
            except (TypeError, ValueError):
                pass
        return min(self._BACKOFF_BASE_SECONDS * (2 ** attempt), self._BACKOFF_CAP_SECONDS)

    def _chat_completion(self, messages: list[dict], tools: list[dict] | None = None) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        payload: dict = {"model": self.model, "messages": messages, "temperature": 0}
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        # The final iteration (attempt == MAX_RETRIES) skips the retry branch, so
        # a persistent 429 falls through to raise_for_status() and surfaces — let
        # respond() degrade to deterministic.
        for attempt in range(self.MAX_RETRIES + 1):
            resp = self._post_chat(payload, headers)
            if resp.status_code == 429 and attempt < self.MAX_RETRIES:
                self._sleep(self._backoff_seconds(attempt, resp))
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError("unreachable: retry loop always returns or raises")

    # ── ChatProvider ─────────────────────────────────────────────────────────
    def respond(self, message: str, *, tools, confirm_action=None) -> CopilotReply:
        try:
            return self._respond_llm(message, tools)
        except Exception as exc:  # noqa: BLE001 — never hard-fail; degrade to deterministic
            print(f"[COPILOT] LLM provider failed ({exc!r}); falling back to deterministic")
            return self._deterministic_fallback(message, tools, confirm_action)

    def _deterministic_fallback(self, message, tools, confirm_action=None) -> CopilotReply:
        reply = DeterministicChatProvider().respond(
            message, tools=tools, confirm_action=confirm_action
        )
        reply.source = "llm_fallback"
        return reply

    def _respond_llm(self, message: str, tools) -> CopilotReply:
        tool_defs = _tool_defs()
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": message},
        ]

        first = self._chat_completion(messages, tools=tool_defs)
        assistant = first["choices"][0]["message"]
        tool_calls = assistant.get("tool_calls") or []
        if not tool_calls:
            # No grounding tool chosen → refuse rather than answer ungrounded.
            return CopilotReply(answer_type=AnswerType.refuse, text=_REFUSAL, source="llm")

        # Run the model's chosen tool(s) — venue-gated; the model's args are
        # ignored (each read tool is scoped to the operator's own venue).
        messages.append(assistant)
        last_result = None
        valid = {d["function"]["name"] for d in tool_defs}
        for call in tool_calls:
            name = call.get("function", {}).get("name", "")
            if name not in valid:
                continue
            result = tools.run(name, {})
            last_result = result
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id", name),
                "name": name,
                "content": json.dumps(result.data, default=str),
            })

        if last_result is None:
            return CopilotReply(answer_type=AnswerType.refuse, text=_REFUSAL, source="llm")

        second = self._chat_completion(messages, tools=tool_defs)
        text = (second["choices"][0]["message"].get("content") or "").strip()
        if not text:
            # Model produced no prose — fall back to a deterministic templated answer.
            return self._deterministic_fallback(message, tools)

        link = None
        nav_href = last_result.data.get("nav_href")
        if nav_href:
            link = ReplyLink(label=last_result.data.get("nav_label", "View"), href=nav_href)
        return CopilotReply(
            answer_type=AnswerType.answer,
            text=text,
            citations=list(last_result.citations),
            link=link,
            source="llm",
        )


class GrokChatProvider(OpenAICompatibleChatProvider):
    """Copilot provider backed by xAI Grok (OpenAI-compatible).

    Reads the shared LLM_* namespace (same keys the eval Grok provider uses) so
    one set of credentials drives both the benchmark and the live copilot. The
    base URL defaults to xAI's endpoint when LLM_BASE_URL is left unset.
    """

    MODEL_ENV = "LLM_MODEL"
    BASE_URL_ENV = "LLM_BASE_URL"
    API_KEY_ENV = "LLM_API_KEY"
    DEFAULT_BASE_URL = "https://api.x.ai/v1"
