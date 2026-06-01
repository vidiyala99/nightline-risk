"""HTTP integration tests for the Phase 1 placement endpoints.

Uses FastAPI TestClient against the real SQLite database via app.main.app
— same pattern as test_portfolio.py. Verifies the full request loop:
HTTP body → service → DB write → response shape.

The service-layer behavior is already tested in test_submissions_service.py;
this file focuses on:
  - HTTP shapes (status codes, response keys)
  - RBAC enforcement (401/403 on missing/wrong roles)
  - Error mapping (service exceptions → correct HTTP errors)
"""

import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


VENUE_ID = "elsewhere-brooklyn"


def _broker_headers():
    token = create_token("user-broker-test", "broker@example.com", "broker", "tenant-1")
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token("user-op-test", "operator@example.com", "venue_operator", VENUE_ID)
    return {"Authorization": f"Bearer {token}"}


def _new_submission_body(**overrides) -> dict:
    body = {
        "venue_id": VENUE_ID,
        "effective_date": "2026-11-01",
        "coverage_lines": ["gl", "liquor"],
        "requested_limits": {"gl": {"per_occurrence": "1000000", "aggregate": "2000000"}},
    }
    body.update(overrides)
    return body


@pytest.fixture
def client():
    """Single TestClient. Each test interacts with the same SQLite DB; the
    autouse `_reset_incident_delta_tracker` fixture from conftest cleans
    in-memory state, but DB rows from one test persist into the next.
    Tests are written to be order-independent via unique submission ids
    (auto-generated uuids)."""
    with TestClient(app) as c:
        yield c


# ─── Auth gating ─────────────────────────────────────────────────────────

def test_create_submission_requires_auth(client):
    r = client.post("/api/submissions", json=_new_submission_body())
    assert r.status_code == 401


def test_create_submission_rejects_operator_role(client):
    r = client.post("/api/submissions", json=_new_submission_body(), headers=_operator_headers())
    assert r.status_code == 403


def test_list_submissions_rejects_unauthenticated(client):
    r = client.get("/api/submissions")
    assert r.status_code == 401


# ─── GET /api/submissions/transitions ────────────────────────────────────

def test_transitions_endpoint_returns_matrix(client):
    """Public endpoint — no auth — exposes the lifecycle matrix to the
    frontend kanban for client-side drop-target validation."""
    r = client.get("/api/submissions/transitions")
    assert r.status_code == 200
    body = r.json()
    assert body["open"] == sorted(["in_market", "withdrawn"])
    assert body["bound"] == []


# ─── POST /api/submissions ───────────────────────────────────────────────

def test_create_submission_happy_path(client):
    r = client.post("/api/submissions", json=_new_submission_body(), headers=_broker_headers())
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "open"
    assert body["venue_id"] == VENUE_ID
    assert body["coverage_lines"] == ["gl", "liquor"]
    assert body["id"].startswith("sub-")


def test_create_submission_unknown_venue_returns_400(client):
    r = client.post(
        "/api/submissions",
        json=_new_submission_body(venue_id="ghost-venue"),
        headers=_broker_headers(),
    )
    assert r.status_code == 400
    assert "Unknown venue" in r.json()["detail"]


# ─── GET /api/submissions ────────────────────────────────────────────────

def test_list_submissions_returns_array(client):
    # Ensure at least one open submission exists.
    client.post("/api/submissions", json=_new_submission_body(), headers=_broker_headers())
    r = client.get("/api/submissions", headers=_broker_headers())
    assert r.status_code == 200
    rows = r.json()
    assert isinstance(rows, list)
    assert any(row["status"] == "open" for row in rows)


def test_list_submissions_status_filter_parses_csv(client):
    r = client.get("/api/submissions?status=in_market,quoting", headers=_broker_headers())
    assert r.status_code == 200
    rows = r.json()
    for row in rows:
        assert row["status"] in ("in_market", "quoting")


def test_list_submissions_venue_filter(client):
    r = client.get(f"/api/submissions?venue_id={VENUE_ID}", headers=_broker_headers())
    assert r.status_code == 200
    rows = r.json()
    for row in rows:
        assert row["venue_id"] == VENUE_ID


# ─── GET /api/submissions/{sid} ──────────────────────────────────────────

def test_submission_detail_includes_quotes_array(client):
    create_resp = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    )
    sid = create_resp.json()["id"]

    r = client.get(f"/api/submissions/{sid}", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == sid
    assert "quotes" in body
    assert body["quotes"] == []   # no quotes until submit_to_market runs


def test_submission_detail_404_for_unknown_id(client):
    r = client.get("/api/submissions/sub-doesnotexist", headers=_broker_headers())
    assert r.status_code == 404


# ─── POST /api/submissions/{sid}/submit ──────────────────────────────────

def test_submit_to_market_creates_quotes(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]

    r = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty", "burns-wilcox"]},
        headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["submission"]["status"] == "in_market"
    assert len(body["quotes_created"]) == 2
    assert all(q["status"] == "requested" for q in body["quotes_created"])
    assert body["rejected_carriers"] == []


def test_submit_to_market_all_out_of_appetite_returns_422(client):
    """Nautilus is property-only; submitting a GL request returns 422
    with the rejection reasons."""
    sid = client.post(
        "/api/submissions",
        json=_new_submission_body(coverage_lines=["gl", "liquor"]),
        headers=_broker_headers(),
    ).json()["id"]

    r = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["nautilus"]},
        headers=_broker_headers(),
    )
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["error"] == "out_of_appetite"


def test_submit_to_market_allow_out_of_appetite_override(client):
    sid = client.post(
        "/api/submissions",
        json=_new_submission_body(coverage_lines=["gl"]),
        headers=_broker_headers(),
    ).json()["id"]

    r = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["nautilus"], "allow_out_of_appetite": True},
        headers=_broker_headers(),
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["quotes_created"]) == 1


# ─── POST /api/quotes/{qid}/record-response ──────────────────────────────

def _well_formed_breakdown(total: str = "5894.84") -> dict:
    return {
        "lines": {
            "gl": {"premium": "3850.00"},
            "liquor": {"premium": "1750.00"},
        },
        "fees": {"policy_fee": "150.00", "surplus_lines_tax": "144.84"},
        "subtotal": "5600.00",
        "total": total,
        "commission_rate": "0.15",
    }


def test_record_response_quoted_advances_submission(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    ).json()
    qid = submit["quotes_created"][0]["id"]

    r = client.post(
        f"/api/quotes/{qid}/record-response",
        json={"status": "quoted", "premium_breakdown": _well_formed_breakdown()},
        headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "quoted"

    # Submission promoted to 'quoting'.
    detail = client.get(f"/api/submissions/{sid}", headers=_broker_headers()).json()
    assert detail["status"] == "quoting"


def test_record_response_invalid_premium_returns_422(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    ).json()
    qid = submit["quotes_created"][0]["id"]

    r = client.post(
        f"/api/quotes/{qid}/record-response",
        json={"status": "quoted", "premium_breakdown": _well_formed_breakdown(total="9999.99")},
        headers=_broker_headers(),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "premium_math_mismatch"


def test_record_decline_persists_reason(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    ).json()
    qid = submit["quotes_created"][0]["id"]

    r = client.post(
        f"/api/quotes/{qid}/record-response",
        json={"status": "declined", "decline_reason": "Account too small for our minimum premium"},
        headers=_broker_headers(),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "declined"
    assert "minimum premium" in body["decline_reason"]


# ─── POST /api/quotes/{qid}/select ───────────────────────────────────────

def test_select_quote_marks_as_selected(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    ).json()
    qid = submit["quotes_created"][0]["id"]
    client.post(
        f"/api/quotes/{qid}/record-response",
        json={"status": "quoted", "premium_breakdown": _well_formed_breakdown()},
        headers=_broker_headers(),
    )

    r = client.post(f"/api/quotes/{qid}/select", headers=_broker_headers())
    assert r.status_code == 200
    assert r.json()["is_selected"] is True


def test_select_quote_rejects_non_quoted(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    ).json()
    qid = submit["quotes_created"][0]["id"]   # still 'requested'

    r = client.post(f"/api/quotes/{qid}/select", headers=_broker_headers())
    assert r.status_code == 400
    assert "expected 'quoted'" in r.json()["detail"]


# ─── POST /api/quotes/{qid}/build-indicative ─────────────────────────────

def test_build_indicative_quote_returns_full_breakdown(client):
    """The broker-path quote engine runs read-only against the carrier rates
    and returns a FullQuote JSON shape — useful for the comparison UI
    before the carrier has actually responded."""
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    ).json()
    qid = submit["quotes_created"][0]["id"]

    r = client.post(f"/api/quotes/{qid}/build-indicative", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    # Money fields are strings (JSON storage contract):
    assert isinstance(body["total"], str)
    assert isinstance(body["subtotal"], str)
    assert body["carrier_id"] == "markel-specialty"
    assert "lines" in body and "gl" in body["lines"]


# ─── POST /api/submissions/{sid}/withdraw ────────────────────────────────

def test_withdraw_submission_sets_terminal(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]

    r = client.post(
        f"/api/submissions/{sid}/withdraw",
        json={"reason": "Venue chose competitor"},
        headers=_broker_headers(),
    )
    assert r.status_code == 200
    assert r.json()["status"] == "withdrawn"


# ─── POST /api/submissions/{sid}/decline and /lose ───────────────────────


def test_decline_submission_from_in_market(client):
    """All carriers declined → submission 'declined' (from 'in_market')."""
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]}, headers=_broker_headers(),
    )
    r = client.post(
        f"/api/submissions/{sid}/decline",
        json={"reason": "class not in appetite"}, headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "declined"


def test_lose_submission_from_quoting(client):
    """Venue went elsewhere while quoting → submission 'lost'."""
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    submit = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]}, headers=_broker_headers(),
    )
    qid = submit.json()["quotes_created"][0]["id"]
    # Recording a quoted response advances the submission to 'quoting'.
    client.post(
        f"/api/quotes/{qid}/record-response",
        json={"status": "quoted", "premium_breakdown": _well_formed_breakdown()},
        headers=_broker_headers(),
    )
    r = client.post(
        f"/api/submissions/{sid}/lose",
        json={"reason": "bound with incumbent"}, headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "lost"


def test_lose_submission_from_open_returns_422(client):
    """'lost' is illegal from 'open' — lifecycle violation maps to 422."""
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    r = client.post(
        f"/api/submissions/{sid}/lose",
        json={"reason": "x"}, headers=_broker_headers(),
    )
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "invalid_transition"


def test_decline_submission_rejects_operator(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    r = client.post(
        f"/api/submissions/{sid}/decline",
        json={"reason": "x"}, headers=_operator_headers(),
    )
    assert r.status_code in (401, 403)


# ─── GET /api/carriers ───────────────────────────────────────────────────

def test_list_carriers_returns_six_seeded(client):
    r = client.get("/api/carriers", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 6
    ids = {c["id"] for c in body}
    assert "markel-specialty" in ids
    assert "burns-wilcox" in ids


def test_carrier_detail_includes_rate_overrides(client):
    """The /carriers/{id} detail surfaces the per-carrier rate overrides
    so a broker can explain to a venue why Markel's quote differs from
    Brit's on the same input."""
    r = client.get("/api/carriers/markel-specialty", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == "markel-specialty"
    assert "rate_overrides" in body
    assert body["rate_overrides"]["commission_rate"] == "0.15"


def test_carrier_detail_404_for_unknown(client):
    r = client.get("/api/carriers/ghost-co", headers=_broker_headers())
    assert r.status_code == 404


# ─── ACORD-style previews ────────────────────────────────────────────────

def test_acord_125_preview_includes_disclaimer(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    r = client.post(f"/api/submissions/{sid}/acord/125", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["form_type"].startswith("ACORD 125")
    assert "Not for redistribution" in body["disclaimer"]
    assert body["applicant"]["name"]   # populated from VENUES


def test_acord_126_preview_focuses_on_general_liability(client):
    sid = client.post(
        "/api/submissions", json=_new_submission_body(), headers=_broker_headers()
    ).json()["id"]
    r = client.post(f"/api/submissions/{sid}/acord/126", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["form_type"].startswith("ACORD 126")
    assert "general_liability" in body


# ─── End-to-end happy path ───────────────────────────────────────────────

def test_full_placement_loop_end_to_end(client):
    """The full broker workflow as one HTTP test: create → submit →
    record quote → select → withdraw. Catches integration drift cheaply."""
    # 1. Create
    sub_resp = client.post(
        "/api/submissions",
        json=_new_submission_body(),
        headers=_broker_headers(),
    )
    assert sub_resp.status_code == 201
    sid = sub_resp.json()["id"]

    # 2. Submit to two carriers
    submit_resp = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty", "burns-wilcox"]},
        headers=_broker_headers(),
    )
    assert submit_resp.status_code == 200
    quotes = submit_resp.json()["quotes_created"]
    assert len(quotes) == 2

    # 3. Quote both — submission auto-promotes to 'quoting' on first.
    for q in quotes:
        r = client.post(
            f"/api/quotes/{q['id']}/record-response",
            json={"status": "quoted", "premium_breakdown": _well_formed_breakdown()},
            headers=_broker_headers(),
        )
        assert r.status_code == 200

    # 4. Select the Markel quote
    markel_q = next(q for q in quotes if q["carrier_id"] == "markel-specialty")
    sel_resp = client.post(f"/api/quotes/{markel_q['id']}/select", headers=_broker_headers())
    assert sel_resp.status_code == 200
    assert sel_resp.json()["is_selected"] is True

    # 5. Withdraw (since bind isn't a Phase 1 endpoint; tests for that arrive in Phase 2)
    wd = client.post(
        f"/api/submissions/{sid}/withdraw",
        json={"reason": "Test E2E — clean up"},
        headers=_broker_headers(),
    )
    assert wd.status_code == 200
    assert wd.json()["status"] == "withdrawn"

    # 6. Detail view shows the terminal state + the deselected/withdrawn quotes
    detail = client.get(f"/api/submissions/{sid}", headers=_broker_headers()).json()
    assert detail["status"] == "withdrawn"
    for q in detail["quotes"]:
        # Quotes that were 'quoted' get withdrawn alongside the submission.
        assert q["status"] in ("withdrawn", "declined", "expired")


# ─── PATCH /submissions/{sid} — edit while open ──────────────────────────


def test_patch_open_submission_edits_fields(client):
    sub = client.post("/api/submissions", json=_new_submission_body(), headers=_broker_headers()).json()
    r = client.patch(
        f"/api/submissions/{sub['id']}",
        json={"notes": "priority placement", "coverage_lines": ["gl"]},
        headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["notes"] == "priority placement"
    assert body["coverage_lines"] == ["gl"]
    assert body["status"] == "open"


def test_patch_submission_unknown_404(client):
    r = client.patch("/api/submissions/sub-nope", json={"notes": "x"}, headers=_broker_headers())
    assert r.status_code == 404


def test_patch_submission_rejects_operator(client):
    sub = client.post("/api/submissions", json=_new_submission_body(), headers=_broker_headers()).json()
    r = client.patch(f"/api/submissions/{sub['id']}", json={"notes": "x"}, headers=_operator_headers())
    assert r.status_code == 403
