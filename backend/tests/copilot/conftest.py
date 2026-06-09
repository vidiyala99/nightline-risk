"""Shared fixtures for copilot tool tests.

The act-tool tests need a packet whose recommendation lands **borderline**
(confidence 0.55 ∈ [0.40, 0.70)) so ``route_status`` returns ``"borderline"``
— the operator-decision band ``validate_send_to_broker`` gates on. We mirror
the seeding shape from ``tests/test_claim_routing.py``: a Venue, a
RubricVersion, a no-injury IncidentRecord, and an UnderwritingPacket with
``risk_signals={"type":"general_incident","severity":"low","confidence":0.55}``.

The seed logic now lives in ``app.evals.copilot_seed`` so a single definition
is shared by both these fixtures and the gold eval scenarios in
``app/evals/copilot_scenarios.py``. These fixtures are thin wrappers over it.

Two variants:
  - ``seeded_borderline_incident_no_policy`` — uninsured (rec.has_active_policy
    False), so send-to-broker is blocked on coverage.
  - ``seeded_borderline_incident_insured``  — same packet + an active Policy,
    so the rec is genuinely borderline-and-insured (send-to-broker allowed).

Each yields ``(scope, incident_id)`` where ``scope`` is a ``CopilotScope``
bound to the venue/operator.
"""
import pytest

from app.models import UnderwritingPacket
from app.evals.copilot_seed import (
    INCIDENT_ID,
    VENUE,
    make_session as _make_session,
    operator_scope as _scope,
    seed_borderline as _seed_borderline,
    seed_policy as _seed_policy,
)

PACKET_ID = "pkt-borderline"


@pytest.fixture
def seeded_borderline_incident_no_policy():
    with _make_session() as s:
        _seed_borderline(s)
        s.commit()
        yield _scope(s), INCIDENT_ID


@pytest.fixture
def seeded_borderline_incident_insured():
    with _make_session() as s:
        _seed_borderline(s)
        _seed_policy(s)
        s.commit()
        # Sanity: with the active policy the packet must actually land borderline.
        from app.claim_routing import recommendation_for_packet, route_status
        pkt = s.get(UnderwritingPacket, PACKET_ID)
        assert route_status(recommendation_for_packet(s, pkt)) == "borderline"
        yield _scope(s), INCIDENT_ID


# ─── Engine-level fixtures (Task 7) ─────────────────────────────────────────
# The engine takes ``(user, session)`` (it resolves the scope itself via
# ``accessible_venue_ids``), so these reuse the SAME seed logic and just unpack
# ``scope.user`` / ``scope.session`` from the scope-based fixtures above. The
# user dict already carries ``role="venue_operator"`` + ``tenant_id=<venue_id>``
# so ``accessible_venue_ids`` resolves the operator's venue.


@pytest.fixture
def seeded_operator_session(seeded_borderline_incident_insured):
    scope, _incident_id = seeded_borderline_incident_insured
    yield scope.user, scope.session


@pytest.fixture
def seeded_borderline_incident_insured_user(seeded_borderline_incident_insured):
    scope, incident_id = seeded_borderline_incident_insured
    yield scope.user, scope.session, incident_id


@pytest.fixture
def seeded_no_policy_incident_user(seeded_borderline_incident_no_policy):
    scope, incident_id = seeded_borderline_incident_no_policy
    yield scope.user, scope.session, incident_id
