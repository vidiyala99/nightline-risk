"""The /api/debug/llm-provider endpoint exposes infra/provider state and can
burn LLM quota (?test=true). It must be locked down to broker/admin — never
anonymous. See backlog item 0."""
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app

client = TestClient(app)


def test_debug_llm_provider_requires_auth():
    resp = client.get("/api/debug/llm-provider")
    assert resp.status_code == 401


def test_debug_llm_provider_forbids_non_broker():
    token = create_token("op-1", "op@example.com", "venue_operator", "elsewhere-brooklyn")
    resp = client.get(
        "/api/debug/llm-provider",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 403


def test_debug_llm_provider_allows_broker():
    token = create_token("brk-1", "broker@example.com", "broker", None)
    resp = client.get(
        "/api/debug/llm-provider",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert "active" in resp.json()
