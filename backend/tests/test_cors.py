"""CORS origin policy (app/main.py).

With allow_credentials=True, a broad `https://.*\\.vercel\\.app` regex lets ANY
attacker-deployed vercel.app site make authenticated cross-origin requests with
a victim's credentials. Pin to this project's own origins. See backlog item 0."""
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _acao(origin: str) -> str | None:
    resp = client.get("/api/health", headers={"Origin": origin})
    return resp.headers.get("access-control-allow-origin")


def test_cors_allows_known_prod_origin():
    assert _acao("https://nightline-app.vercel.app") == "https://nightline-app.vercel.app"


def test_cors_allows_project_preview_subdomain():
    origin = "https://nightline-app-git-feat-x-aakash.vercel.app"
    assert _acao(origin) == origin


def test_cors_allows_localhost_dev():
    assert _acao("http://localhost:3000") == "http://localhost:3000"


def test_cors_rejects_arbitrary_vercel_subdomain():
    # The attack: a site the attacker controls must not receive a credentialed
    # CORS grant just because it lives on *.vercel.app.
    assert _acao("https://evil-attacker.vercel.app") is None


def test_cors_rejects_unknown_origin():
    assert _acao("https://evil.com") is None
