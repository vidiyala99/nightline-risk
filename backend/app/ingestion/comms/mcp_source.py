# backend/app/ingestion/comms/mcp_source.py
"""Real MCP-client source behind the same `CommsSource` seam as the simulated
sources. Nightline acts as an MCP *client*, calling a source MCP server's list
tool (Slack/tickets/SMS) and mapping the raw records into `CommsItem`s.

The seam stays sim-compatible: swapping a simulated source for this one changes
only the source construction (`build_comms_source` in `sources.py`), never the
connector/router/classifier. Real-source config is env-gated (mirrors
`STORAGE_BACKEND` / `RESEND_API_KEY`); absent config → simulated source.

`fetch` is an injectable callable `() -> list[dict]` so tests stay deterministic
and never touch the network or require the `mcp` SDK. When `fetch` is None, the
official `mcp` SDK is imported lazily inside the real-fetch path only — the
module imports fine when `mcp` isn't installed.
"""
from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Callable, Optional

from app.ingestion.comms.sources import CommsSource
from app.ingestion.comms.types import CommsItem
from app.time import now_utc


def _parse_occurred_at(value) -> datetime:
    """Parse an ISO timestamp; fall back to now() if absent/unparseable."""
    if isinstance(value, str) and value:
        try:
            # Tolerate a trailing 'Z' (Python <3.11 doesn't accept it directly).
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return now_utc()
    return now_utc()


class McpCommsSource(CommsSource):
    """A `CommsSource` backed by an MCP server's list tool."""

    def __init__(
        self,
        source: str,
        venue_ids: list[str],
        *,
        sse_url: Optional[str] = None,
        tool_name: str = "list_items",
        default_venue_id: Optional[str] = None,
        fetch: Optional[Callable[[], list[dict]]] = None,
        as_of: Optional[datetime] = None,
    ):
        self.source = source
        self.venue_ids = venue_ids
        self.sse_url = sse_url
        self.tool_name = tool_name
        self.default_venue_id = default_venue_id
        self._fetch = fetch
        self.as_of = as_of or now_utc()

    def _fallback_venue(self) -> Optional[str]:
        return self.default_venue_id or (self.venue_ids[0] if self.venue_ids else None)

    def list_items(self, *, since: Optional[datetime] = None) -> list[CommsItem]:
        records = self._fetch() if self._fetch is not None else self._fetch_via_mcp()
        items: list[CommsItem] = []
        fallback = self._fallback_venue()
        for record in records:
            text = record.get("text")
            if not text or not str(text).strip():
                continue  # skip records with no usable text
            items.append(
                CommsItem(
                    source=self.source,
                    venue_id=record.get("venue_id") or fallback,
                    external_id=record.get("external_id") or record.get("id"),
                    text=text,
                    occurred_at=_parse_occurred_at(record.get("occurred_at")),
                    author=record.get("author"),
                )
            )
        return items

    def _fetch_via_mcp(self) -> list[dict]:
        """Call the configured MCP server's list tool over SSE. The client is
        async; bridge it with `asyncio.run` inside this sync method. `mcp` is
        imported here (lazily) so the module imports without the SDK installed."""
        if not self.sse_url:
            raise RuntimeError(
                "McpCommsSource needs an sse_url (or an injected `fetch`) to pull items."
            )

        async def _run() -> list[dict]:
            from mcp import ClientSession
            from mcp.client.sse import sse_client

            async with sse_client(self.sse_url) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(self.tool_name, arguments={})
                    return _extract_records(result)

        return asyncio.run(_run())


def _extract_records(result) -> list[dict]:
    """Pull a list of raw record dicts out of an MCP CallToolResult. Prefer
    structured content; fall back to JSON-parsing the first text block."""
    structured = getattr(result, "structuredContent", None)
    if isinstance(structured, dict):
        items = structured.get("items", structured.get("records"))
        if isinstance(items, list):
            return items
    if isinstance(structured, list):
        return structured

    content = getattr(result, "content", None) or []
    for block in content:
        text = getattr(block, "text", None)
        if text:
            import json

            parsed = json.loads(text)
            if isinstance(parsed, dict):
                return parsed.get("items", parsed.get("records", []))
            if isinstance(parsed, list):
                return parsed
    return []
