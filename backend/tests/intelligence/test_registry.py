from app.intelligence.findings import REGISTRY
from app.intelligence.finding import PERSONA_KINDS


def test_registry_has_a_callable_for_every_persona_kind():
    all_kinds = {k for kinds in PERSONA_KINDS.values() for k in kinds}
    assert set(REGISTRY) == all_kinds
    for kind, fn in REGISTRY.items():
        assert callable(fn), kind
