"""
Tests for portfolio, review decisions, audit trail, source registry, and incident status.
Uses the real SQLite database via TestClient (same pattern as test_brawl_incident_flow.py).
"""
from fastapi.testclient import TestClient
from app.main import app
from app.auth import create_token
from app.seed_data import VENUES

DEMO_INCIDENT = {
    "occurred_at": "2026-05-05T22:00:00Z",
    "location": "rear bar",
    "summary": "Test incident for automated test suite.",
    "reported_by": "pytest",
    "injury_observed": False,
    "police_called": False,
    "ems_called": False,
}


def _broker_headers():
    token = create_token("user-broker-1", "broker@example.com", "broker", "tenant-1")
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token("user-op-1", "operator@example.com", "venue_operator", "elsewhere-brooklyn")
    return {"Authorization": f"Bearer {token}"}


# ── Portfolio ─────────────────────────────────────────────────────────────────

def test_portfolio_returns_all_venues():
    with TestClient(app) as client:
        resp = client.get("/api/portfolio", headers=_broker_headers())
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == len(VENUES)
    ids = {v["id"] for v in data}
    assert "elsewhere-brooklyn" in ids


def test_portfolio_venue_has_required_fields():
    with TestClient(app) as client:
        data = client.get("/api/portfolio", headers=_broker_headers()).json()
    venue = next(v for v in data if v["id"] == "elsewhere-brooklyn")
    required = {
        "id", "name", "tier", "total_score", "capacity", "current_capacity",
        "renewal_date", "open_incidents", "compliance_actions", "has_degraded_infra",
    }
    assert required.issubset(venue.keys())


def test_portfolio_all_tiers_valid():
    with TestClient(app) as client:
        data = client.get("/api/portfolio", headers=_broker_headers()).json()
    for venue in data:
        assert venue["tier"] in ("A", "B", "C", "D"), f"{venue['id']} has invalid tier"


def test_portfolio_elsewhere_reflects_live_incident_count():
    """Risk score now reads the LIVE count of IncidentRecord rows for each
    venue (so the Risk Profile factor matches what the scoped Incidents list
    shows). Elsewhere has 6 SEED_INCIDENTS rows → incident_history factor 40
    → blended total lands in the C band. This pins the new live-count
    behavior; if Elsewhere's seeded incident rows change, update this."""
    with TestClient(app) as client:
        data = client.get("/api/portfolio", headers=_broker_headers()).json()
    elsewhere = next(v for v in data if v["id"] == "elsewhere-brooklyn")
    assert elsewhere["tier"] in ("B", "C"), f"got tier {elsewhere['tier']}"
    assert elsewhere["total_score"] < 80, "should reflect 6 real incidents, not the curated 2-incident baseline"


def test_portfolio_hides_live_capacity_from_brokers():
    """Live occupancy is operator-only floor data. The book must not leak it —
    it stays null for brokers so it matches the gated /venues/{id}/live detail
    view (regression for the 325/350-vs-0/350 contradiction)."""
    with TestClient(app) as client:
        data = client.get("/api/portfolio?source=book", headers=_broker_headers()).json()
    assert len(data) > 0
    for venue in data:
        assert venue["current_capacity"] is None, (
            f"{venue['id']} leaked live occupancy to a broker"
        )


def test_portfolio_admin_sees_live_capacity():
    """Admins can read floor state, so the book keeps real occupancy for them."""
    admin_token = create_token("user-admin-1", "admin@example.com", "admin", "tenant-1")
    with TestClient(app) as client:
        data = client.get(
            "/api/portfolio?source=book",
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
    assert any(v["current_capacity"] is not None for v in data)


def test_portfolio_anonymous_rejected():
    with TestClient(app) as client:
        resp = client.get("/api/portfolio")
    assert resp.status_code == 401


def test_portfolio_operator_rejected():
    with TestClient(app) as client:
        resp = client.get("/api/portfolio", headers=_operator_headers())
    assert resp.status_code == 403


# ── Live state role-gating ────────────────────────────────────────────────────

def test_live_state_strips_floor_for_anonymous():
    with TestClient(app) as client:
        resp = client.get("/api/venues/elsewhere-brooklyn/live")
    assert resp.status_code == 200
    body = resp.json()
    assert body["current_capacity"] == 0
    assert body["infrastructure"] == []
    # Compliance summary remains intact for broker-side views.
    assert "compliance_queue" in body


def test_live_state_strips_floor_for_broker():
    with TestClient(app) as client:
        resp = client.get("/api/venues/elsewhere-brooklyn/live", headers=_broker_headers())
    assert resp.status_code == 200
    body = resp.json()
    assert body["current_capacity"] == 0
    assert body["infrastructure"] == []


def test_live_state_full_for_owning_operator():
    with TestClient(app) as client:
        resp = client.get("/api/venues/elsewhere-brooklyn/live", headers=_operator_headers())
    assert resp.status_code == 200
    body = resp.json()
    assert body["max_capacity"] > 0
    # Floor data is present (non-zero capacity or non-empty infrastructure) when
    # the caller is the venue's own operator.
    assert body["current_capacity"] > 0 or len(body["infrastructure"]) > 0


def test_live_state_strips_floor_for_other_operator():
    other_token = create_token("user-op-2", "other@example.com", "venue_operator", "market-hotel")
    with TestClient(app) as client:
        resp = client.get(
            "/api/venues/elsewhere-brooklyn/live",
            headers={"Authorization": f"Bearer {other_token}"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["current_capacity"] == 0
    assert body["infrastructure"] == []


# ── Incident status filter ─────────────────────────────────────────────────────

def test_incidents_status_filter_open_vs_closed():
    h = _operator_headers()
    with TestClient(app) as client:
        client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        all_resp = client.get("/api/venues/elsewhere-brooklyn/incidents", headers=h)
        open_resp = client.get("/api/venues/elsewhere-brooklyn/incidents?status=open", headers=h)

    assert all_resp.status_code == 200
    assert open_resp.status_code == 200
    assert all(i["status"] == "open" for i in open_resp.json())


def test_incident_status_patch():
    h = _operator_headers()
    with TestClient(app) as client:
        create = client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        incident_id = create.json()["incident"]["id"]
        patch = client.patch(f"/api/incidents/{incident_id}/status", json={"status": "closed"}, headers=h)
        assert patch.status_code == 200
        assert patch.json()["status"] == "closed"
        open_list = client.get("/api/venues/elsewhere-brooklyn/incidents?status=open", headers=h).json()
    assert not any(i["id"] == incident_id for i in open_list)


def test_incident_counts_reconcile_with_list_and_score():
    """Reconciliation contract: the counts endpoint's `total` must equal the
    unfiltered list length AND the scoring engine's incident input. The bug
    this guards: the Risk Profile factor showed one number, the IncidentList
    header showed another, because the list was opened with an `open` filter
    pre-applied. Now the counts endpoint is the single source of truth — the
    Risk Profile uses `total` for the headline number and `open` for the chip,
    and a no-filter list view shows `total` in its badge.
    """
    h = _operator_headers()
    venue_id = "elsewhere-brooklyn"
    with TestClient(app) as client:
        # Create one fresh incident, close another to ensure status mix.
        create_a = client.post(f"/api/venues/{venue_id}/incidents", json=DEMO_INCIDENT)
        assert create_a.status_code == 201
        create_b = client.post(f"/api/venues/{venue_id}/incidents", json=DEMO_INCIDENT)
        client.patch(
            f"/api/incidents/{create_b.json()['incident']['id']}/status",
            json={"status": "closed"},
            headers=h,
        )

        all_list = client.get(f"/api/venues/{venue_id}/incidents", headers=h).json()
        counts = client.get(f"/api/venues/{venue_id}/incidents/counts", headers=h).json()

    assert counts["total"] == len(all_list), (
        f"counts.total={counts['total']} must equal unfiltered list length {len(all_list)}"
    )
    assert counts["open"] == sum(1 for i in all_list if i["status"] == "open")
    assert counts["closed"] == sum(1 for i in all_list if i["status"] == "closed")
    # Mix is real (we have both open and closed), so the bug-reproduction
    # scenario — different filtered subsets — is exercised.
    assert counts["open"] >= 1
    assert counts["closed"] >= 1


def test_incident_status_invalid_value_rejected():
    h = _operator_headers()
    with TestClient(app) as client:
        create = client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        incident_id = create.json()["incident"]["id"]
        resp = client.patch(f"/api/incidents/{incident_id}/status", json={"status": "invalid_value"}, headers=h)
    # Phase A: untyped status strings now rejected via the lifecycle matrix at 422,
    # not 400. The earlier "open|under_review|closed" hardcoded check returned 400.
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"]["error"] == "invalid_transition"


# ── Review decisions ──────────────────────────────────────────────────────────

def test_review_decision_approve_changes_packet_status():
    h = _operator_headers()
    with TestClient(app) as client:
        client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        incidents = client.get("/api/venues/elsewhere-brooklyn/incidents", headers=h).json()
        incident_id = incidents[0]["id"]
        packets = client.get(f"/api/incidents/{incident_id}/packets").json()
        packet_id = packets[0]["id"]

        decision = client.post(
            f"/api/packets/{packet_id}/review-decisions",
            json={"reviewer_id": "test-reviewer", "decision": "approved"},
        )
        assert decision.status_code == 201
        assert decision.json()["decision"] == "approved"

        packet = client.get(f"/api/packets/{packet_id}", headers=h).json()
    assert packet["status"] == "approved"


# ── Audit trail ───────────────────────────────────────────────────────────────

def test_audit_events_include_packet_generated():
    h = _operator_headers()
    with TestClient(app) as client:
        client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        incidents = client.get("/api/venues/elsewhere-brooklyn/incidents", headers=h).json()
        incident_id = incidents[0]["id"]
        packets = client.get(f"/api/incidents/{incident_id}/packets").json()
        packet_id = packets[0]["id"]
        events = client.get(f"/api/packets/{packet_id}/audit-events").json()

    event_types = {e["event_type"] for e in events}
    assert "packet.generated" in event_types


def test_audit_events_include_decision_after_review():
    h = _operator_headers()
    with TestClient(app) as client:
        client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        incidents = client.get("/api/venues/elsewhere-brooklyn/incidents", headers=h).json()
        incident_id = incidents[0]["id"]
        packets = client.get(f"/api/incidents/{incident_id}/packets").json()
        packet_id = packets[0]["id"]
        client.post(
            f"/api/packets/{packet_id}/review-decisions",
            json={"reviewer_id": "uw-test", "decision": "approved"},
        )
        events = client.get(f"/api/packets/{packet_id}/audit-events").json()

    event_types = {e["event_type"] for e in events}
    assert "packet.review_decision_recorded" in event_types


# ── Source registry ───────────────────────────────────────────────────────────

def test_source_registry_populated_after_incident():
    with TestClient(app) as client:
        client.post("/api/venues/elsewhere-brooklyn/incidents", json=DEMO_INCIDENT)
        resp = client.get("/api/venues/elsewhere-brooklyn/sources")

    assert resp.status_code == 200
    sources = resp.json()
    assert len(sources) > 0
    for s in sources:
        assert "source_type" in s
        assert "excerpt" in s
        assert "id" in s
