"""HTTP integration tests for the Phase 2 policy endpoints.

Mirrors test_placement_api.py — uses TestClient against the live
app.main.app, tests auth gating, status code mapping, response shapes,
and one full bind → endorse → certificate → cancel end-to-end loop.
"""
import pytest
from fastapi.testclient import TestClient

from app.auth import create_token
from app.main import app


VENUE_ID = "elsewhere-brooklyn"


def _broker_headers():
    token = create_token("user-broker-policy-test", "broker@example.com", "broker", None)
    return {"Authorization": f"Bearer {token}"}


def _operator_headers():
    token = create_token("user-op-policy-test", "op@example.com", "venue_operator", VENUE_ID)
    return {"Authorization": f"Bearer {token}"}


def _well_formed_breakdown() -> dict:
    return {
        "lines": {
            "gl": {"premium": "3850.00"},
            "liquor": {"premium": "1750.00"},
        },
        "fees": {"policy_fee": "150.00", "surplus_lines_tax": "144.84"},
        "subtotal": "5600.00",
        "total": "5894.84",
        "commission_rate": "0.15",
        "commission_amount": "839.23",
    }


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ─── Helpers ─────────────────────────────────────────────────────────────


def _create_quoted_selected_quote(client) -> str:
    """Create a submission → submit → quote → select. Returns the quote_id
    ready for binding."""
    # Create submission
    sub_resp = client.post(
        "/api/submissions",
        json={
            "venue_id": VENUE_ID,
            "effective_date": "2026-11-01",
            "coverage_lines": ["gl", "liquor"],
            "requested_limits": {},
        },
        headers=_broker_headers(),
    )
    assert sub_resp.status_code == 201
    sid = sub_resp.json()["id"]

    # Submit to market
    submit_resp = client.post(
        f"/api/submissions/{sid}/submit",
        json={"target_carriers": ["markel-specialty"]},
        headers=_broker_headers(),
    )
    assert submit_resp.status_code == 200
    qid = submit_resp.json()["quotes_created"][0]["id"]

    # Record carrier response
    rr = client.post(
        f"/api/quotes/{qid}/record-response",
        json={"status": "quoted", "premium_breakdown": _well_formed_breakdown()},
        headers=_broker_headers(),
    )
    assert rr.status_code == 200

    # Select the quote
    sel = client.post(f"/api/quotes/{qid}/select", headers=_broker_headers())
    assert sel.status_code == 200

    return qid


# ─── Auth gating ────────────────────────────────────────────────────────


def test_bind_quote_requires_auth(client):
    r = client.post("/api/quotes/abc/bind", json={})
    assert r.status_code == 401


def test_bind_quote_rejects_operator_role(client):
    r = client.post("/api/quotes/abc/bind", json={}, headers=_operator_headers())
    assert r.status_code == 403


def test_list_policies_rejects_unauthenticated(client):
    r = client.get("/api/policies")
    assert r.status_code == 401


# ─── POST /api/quotes/{qid}/bind ────────────────────────────────────────


def test_bind_quote_happy_path(client):
    qid = _create_quoted_selected_quote(client)
    r = client.post(f"/api/quotes/{qid}/bind", json={}, headers=_broker_headers())
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["id"].startswith("pol-")
    assert body["status"] == "bound_pending_number"
    assert body["policy_number"] is None
    assert body["snapshot_hash"] != ""
    assert body["annual_premium"] == "5894.84"


def test_bind_quote_with_policy_number_starts_active(client):
    qid = _create_quoted_selected_quote(client)
    r = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "MK-2026-00042"},
        headers=_broker_headers(),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["status"] == "active"
    assert body["policy_number"] == "MK-2026-00042"


def test_bind_quote_rejects_unselected_quote(client):
    """Quote not is_selected → 422 quote_not_bindable."""
    # Create submission → submit → quote response, but DON'T select.
    sub_resp = client.post(
        "/api/submissions",
        json={
            "venue_id": VENUE_ID,
            "effective_date": "2026-11-01",
            "coverage_lines": ["gl"],
            "requested_limits": {},
        },
        headers=_broker_headers(),
    )
    sid = sub_resp.json()["id"]
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
    # No select — try to bind anyway.
    r = client.post(f"/api/quotes/{qid}/bind", json={}, headers=_broker_headers())
    assert r.status_code == 422
    assert r.json()["detail"]["error"] == "quote_not_bindable"


# ─── GET /api/policies ──────────────────────────────────────────────────


def test_list_policies_returns_active_by_default(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-LISTTEST-A"},
        headers=_broker_headers(),
    ).json()
    r = client.get("/api/policies", headers=_broker_headers())
    assert r.status_code == 200
    ids = {p["id"] for p in r.json()}
    assert pol["id"] in ids


def test_list_policies_filters_by_venue(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-VENUE-1"},
        headers=_broker_headers(),
    ).json()
    r = client.get(f"/api/policies?venue_id={VENUE_ID}", headers=_broker_headers())
    assert r.status_code == 200
    for p in r.json():
        assert p["venue_id"] == VENUE_ID
    assert any(p["id"] == pol["id"] for p in r.json())


# ─── GET /api/policies/{pid} ────────────────────────────────────────────


def test_policy_detail_includes_endorsements_and_certificates(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-DETAIL-1"},
        headers=_broker_headers(),
    ).json()
    r = client.get(f"/api/policies/{pol['id']}", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert "endorsements" in body
    assert "certificates" in body
    assert body["endorsements"] == []
    assert body["certificates"] == []


def test_policy_detail_404_for_unknown_id(client):
    r = client.get("/api/policies/pol-doesnotexist", headers=_broker_headers())
    assert r.status_code == 404


# ─── PATCH /api/policies/{pid}/policy-number ────────────────────────────


def test_assign_policy_number_promotes_to_active(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(f"/api/quotes/{qid}/bind", json={}, headers=_broker_headers()).json()
    assert pol["status"] == "bound_pending_number"

    r = client.patch(
        f"/api/policies/{pol['id']}/policy-number",
        json={"policy_number": "MK-ASSIGNED-42"},
        headers=_broker_headers(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"
    assert r.json()["policy_number"] == "MK-ASSIGNED-42"


def test_assign_policy_number_rejects_empty_string(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(f"/api/quotes/{qid}/bind", json={}, headers=_broker_headers()).json()
    r = client.patch(
        f"/api/policies/{pol['id']}/policy-number",
        json={"policy_number": ""},
        headers=_broker_headers(),
    )
    # Pydantic min_length=1 catches it as 422 (validation error).
    assert r.status_code == 422


# ─── POST /api/policies/{pid}/endorsements ──────────────────────────────


def test_issue_endorsement_persists_and_returns(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-END-1"},
        headers=_broker_headers(),
    ).json()
    r = client.post(
        f"/api/policies/{pol['id']}/endorsements",
        json={
            "endorsement_type": "change_limit",
            "effective_date": "2027-01-15",
            "terms_diff": {
                "coverage_line": "gl",
                "field": "per_occurrence",
                "before": "1000000",
                "after": "2000000",
            },
            "premium_change": "250.00",
            "description": "Raise GL per-occ to $2M.",
        },
        headers=_broker_headers(),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["endorsement_type"] == "change_limit"
    assert body["premium_change"] == "250.00"
    assert body["terms_diff"]["field"] == "per_occurrence"


def test_issue_endorsement_malformed_terms_diff_returns_400(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-END-BAD"},
        headers=_broker_headers(),
    ).json()
    r = client.post(
        f"/api/policies/{pol['id']}/endorsements",
        json={
            "endorsement_type": "change_limit",
            "effective_date": "2027-01-15",
            "terms_diff": {"coverage_line": "gl"},   # missing field/before/after
        },
        headers=_broker_headers(),
    )
    assert r.status_code == 400
    assert "validation failed" in r.json()["detail"].lower()


def test_list_endorsements_returns_array(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-END-LIST"},
        headers=_broker_headers(),
    ).json()
    # Issue one endorsement.
    client.post(
        f"/api/policies/{pol['id']}/endorsements",
        json={
            "endorsement_type": "correction",
            "effective_date": "2027-01-15",
            "terms_diff": {
                "field_corrected": "name",
                "before": "Eslewhere", "after": "Elsewhere",
                "explanation": "typo",
            },
        },
        headers=_broker_headers(),
    )
    r = client.get(f"/api/policies/{pol['id']}/endorsements", headers=_broker_headers())
    assert r.status_code == 200
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["endorsement_type"] == "correction"


# ─── POST /api/policies/{pid}/cancel ────────────────────────────────────


def test_cancel_policy_populates_refund(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-CANCEL-1"},
        headers=_broker_headers(),
    ).json()
    r = client.post(
        f"/api/policies/{pol['id']}/cancel",
        json={
            "reason": "Venue closed",
            "method": "pro_rata",
            "cancellation_date": pol["effective_date"],   # cancel immediately
        },
        headers=_broker_headers(),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "cancelled"
    assert body["cancellation_method"] == "pro_rata"
    assert body["refund_amount"] is not None


def test_cancel_policy_rejects_invalid_method(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-CANCEL-BAD"},
        headers=_broker_headers(),
    ).json()
    r = client.post(
        f"/api/policies/{pol['id']}/cancel",
        json={
            "reason": "Test",
            "method": "freebie",
            "cancellation_date": pol["effective_date"],
        },
        headers=_broker_headers(),
    )
    assert r.status_code == 400
    assert "unknown cancellation method" in r.json()["detail"]


# ─── POST /api/policies/{pid}/certificates ──────────────────────────────


def test_issue_certificate_persists(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-COI-1"},
        headers=_broker_headers(),
    ).json()
    r = client.post(
        f"/api/policies/{pol['id']}/certificates",
        json={
            "certificate_holder": "599 Johnson LLC",
            "certificate_holder_address": "599 Johnson Ave, Brooklyn",
            "description_of_operations": "Music venue + bar operations",
            "expires_on": pol["expiration_date"],
        },
        headers=_broker_headers(),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "active"
    assert body["certificate_holder"] == "599 Johnson LLC"


def test_issue_certificate_ai_without_scope_returns_400(client):
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-COI-BAD"},
        headers=_broker_headers(),
    ).json()
    r = client.post(
        f"/api/policies/{pol['id']}/certificates",
        json={
            "certificate_holder": "X",
            "certificate_holder_address": "Y",
            "description_of_operations": "z",
            "expires_on": pol["expiration_date"],
            "additional_insured": True,
        },
        headers=_broker_headers(),
    )
    assert r.status_code == 400
    assert "additional_insured_scope" in r.json()["detail"]


def test_list_certificates_hides_superseded_by_default(client):
    """Issue two COIs to the same holder; the first should be hidden
    from the default list and visible only with ?include=superseded."""
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-COI-SUP"},
        headers=_broker_headers(),
    ).json()
    first = client.post(
        f"/api/policies/{pol['id']}/certificates",
        json={
            "certificate_holder": "EventCo",
            "certificate_holder_address": "100 Broadway",
            "description_of_operations": "Event A",
            "expires_on": pol["expiration_date"],
        },
        headers=_broker_headers(),
    ).json()
    second = client.post(
        f"/api/policies/{pol['id']}/certificates",
        json={
            "certificate_holder": "EventCo",
            "certificate_holder_address": "100 Broadway",
            "description_of_operations": "Event B (updated)",
            "expires_on": pol["expiration_date"],
        },
        headers=_broker_headers(),
    ).json()

    active = client.get(
        f"/api/policies/{pol['id']}/certificates",
        headers=_broker_headers(),
    ).json()
    assert {c["id"] for c in active} == {second["id"]}

    all_rows = client.get(
        f"/api/policies/{pol['id']}/certificates?include=superseded",
        headers=_broker_headers(),
    ).json()
    assert {c["id"] for c in all_rows} == {first["id"], second["id"]}


def test_certificate_pdf_returns_pdf_pending(client):
    """Phase 5 (defense package) brings real PDF rendering. Phase 2's
    /pdf endpoint returns metadata + a pdf_pending marker."""
    qid = _create_quoted_selected_quote(client)
    pol = client.post(
        f"/api/quotes/{qid}/bind",
        json={"policy_number": "P-COI-PDF"},
        headers=_broker_headers(),
    ).json()
    coi = client.post(
        f"/api/policies/{pol['id']}/certificates",
        json={
            "certificate_holder": "Holder",
            "certificate_holder_address": "Addr",
            "description_of_operations": "Ops",
            "expires_on": pol["expiration_date"],
        },
        headers=_broker_headers(),
    ).json()
    r = client.get(f"/api/certificates/{coi['id']}/pdf", headers=_broker_headers())
    assert r.status_code == 200
    body = r.json()
    assert body["pdf_pending"] is True
    assert "Phase 5" in body["note"]


# ─── End-to-end full lifecycle loop ─────────────────────────────────────


def test_full_policy_lifecycle_end_to_end(client):
    """One HTTP test that exercises every Phase 2 service boundary:
    bind → assign number → endorse → issue COI → cancel."""
    qid = _create_quoted_selected_quote(client)

    # 1. Bind (without policy_number)
    bind_resp = client.post(
        f"/api/quotes/{qid}/bind",
        json={},
        headers=_broker_headers(),
    )
    assert bind_resp.status_code == 201
    pol = bind_resp.json()
    pid = pol["id"]
    assert pol["status"] == "bound_pending_number"

    # 2. Assign the carrier-issued policy number
    assign_resp = client.patch(
        f"/api/policies/{pid}/policy-number",
        json={"policy_number": "MK-E2E-LIFECYCLE"},
        headers=_broker_headers(),
    )
    assert assign_resp.status_code == 200
    assert assign_resp.json()["status"] == "active"

    # 3. Mid-term endorsement
    end_resp = client.post(
        f"/api/policies/{pid}/endorsements",
        json={
            "endorsement_type": "change_limit",
            "effective_date": pol["effective_date"],
            "terms_diff": {
                "coverage_line": "gl",
                "field": "per_occurrence",
                "before": "1000000",
                "after": "2000000",
            },
            "premium_change": "250.00",
        },
        headers=_broker_headers(),
    )
    assert end_resp.status_code == 201

    # 4. Issue COI to landlord with additional_insured
    coi_resp = client.post(
        f"/api/policies/{pid}/certificates",
        json={
            "certificate_holder": "599 Johnson LLC",
            "certificate_holder_address": "599 Johnson Ave, Brooklyn",
            "description_of_operations": "Music venue lease",
            "expires_on": pol["expiration_date"],
            "additional_insured": True,
            "additional_insured_scope": "ongoing_operations",
        },
        headers=_broker_headers(),
    )
    assert coi_resp.status_code == 201
    assert coi_resp.json()["additional_insured_scope"] == "ongoing_operations"

    # 5. Cancel mid-term
    cancel_resp = client.post(
        f"/api/policies/{pid}/cancel",
        json={
            "reason": "Venue closed",
            "method": "pro_rata",
            "cancellation_date": pol["effective_date"],
        },
        headers=_broker_headers(),
    )
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "cancelled"

    # 6. Final detail view shows everything
    detail = client.get(f"/api/policies/{pid}", headers=_broker_headers()).json()
    assert detail["status"] == "cancelled"
    assert len(detail["endorsements"]) == 1
    # Active COI list now empty (active filter):
    active_cois = client.get(
        f"/api/policies/{pid}/certificates",
        headers=_broker_headers(),
    ).json()
    assert len(active_cois) == 1   # The COI itself is still 'active' status on its own row
