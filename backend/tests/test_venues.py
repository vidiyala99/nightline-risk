"""Venue create dedup (name+address) + the dedupe_venues merge script.

TestClient against the real SQLite DB (same pattern as test_placement_api.py).
Tests use unique venue names/ids so they're order-independent despite the
shared DB.
"""
import json as _json
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.auth import create_token
from app.database import engine
from app.main import app
from app.models import SourceRecord, Venue


def _operator_headers():
    token = create_token("user-op-dedupe", "op-dedupe@example.com", "venue_operator", "op-dedupe-tenant")
    return {"Authorization": f"Bearer {token}"}


def _unique_name() -> str:
    return f"Dedupe Bar {uuid.uuid4().hex[:8]}"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# ─── Create-time dedup (name + address) ──────────────────────────────────

def test_create_rejects_same_name_and_address(client):
    body = {"name": _unique_name(), "address": "123 Test St"}
    r1 = client.post("/api/venues", json=body, headers=_operator_headers())
    assert r1.status_code == 201, r1.text
    r2 = client.post("/api/venues", json=body, headers=_operator_headers())
    assert r2.status_code == 409
    assert r2.json()["detail"]["error"] == "venue_duplicate"


def test_create_allows_same_name_different_address(client):
    name = _unique_name()
    r1 = client.post("/api/venues", json={"name": name, "address": "1 First Ave"}, headers=_operator_headers())
    r2 = client.post("/api/venues", json={"name": name, "address": "2 Second Ave"}, headers=_operator_headers())
    assert r1.status_code == 201, r1.text
    assert r2.status_code == 201, r2.text
    assert r1.json()["id"] != r2.json()["id"]  # second got a suffixed slug


def test_create_same_explicit_id_upserts(client):
    vid = f"explicit-{uuid.uuid4().hex[:6]}"
    body = {"id": vid, "name": _unique_name(), "address": "9 Retry Rd"}
    r1 = client.post("/api/venues", json=body, headers=_operator_headers())
    r2 = client.post("/api/venues", json=body, headers=_operator_headers())
    assert r1.status_code == 201, r1.text
    assert r2.status_code == 201, r2.text  # same id → upsert, not a duplicate
    assert r2.json()["id"] == vid


# ─── dedupe_venues script ────────────────────────────────────────────────

def test_groups_detects_duplicate_name_address():
    from scripts.dedupe_venues import _groups

    name = _unique_name()
    vdata = _json.dumps({"name": name, "address": "5 Merge Ln"})
    a, b = f"a-{uuid.uuid4().hex[:6]}", f"b-{uuid.uuid4().hex[:6]}"
    with Session(engine) as s:
        s.add(Venue(id=a, name=name, venue_data=vdata))
        s.add(Venue(id=b, name=name, venue_data=vdata))
        s.commit()
        try:
            groups = _groups(s, None)
            assert any({v.id for v in g} >= {a, b} for g in groups)
        finally:
            # These bare venues lack the full venue_data the portfolio
            # aggregation expects — remove them so they don't pollute the
            # shared SQLite DB for later tests.
            for vid in (a, b):
                row = s.get(Venue, vid)
                if row:
                    s.delete(row)
            s.commit()


def test_repoint_moves_references():
    from scripts.dedupe_venues import _repoint

    name = _unique_name()
    vdata = _json.dumps({"name": name, "address": "7 Repoint Rd"})
    src_id = f"src-{uuid.uuid4().hex[:6]}"
    a, b = f"from-{uuid.uuid4().hex[:6]}", f"to-{uuid.uuid4().hex[:6]}"
    with Session(engine) as s:
        s.add(Venue(id=a, name=name, venue_data=vdata))
        s.add(Venue(id=b, name=name, venue_data=vdata))
        s.add(SourceRecord(id=src_id, venue_id=a, source_type="test", excerpt="x"))
        s.commit()
        try:
            moved = _repoint(s, a, b)
            s.commit()
            assert moved.get("SourceRecord") == 1

            ref = s.get(SourceRecord, src_id)
            assert ref is not None and ref.venue_id == b
        finally:
            ref = s.get(SourceRecord, src_id)
            if ref:
                s.delete(ref)
            for vid in (a, b):
                row = s.get(Venue, vid)
                if row:
                    s.delete(row)
            s.commit()
