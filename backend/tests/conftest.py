import sys
from pathlib import Path

import pytest


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
for module_name in list(sys.modules):
    if module_name == "app" or module_name.startswith("app."):
        del sys.modules[module_name]


@pytest.fixture(autouse=True)
def _reset_incident_delta_tracker():
    """Module-level singleton tracks new incidents in-process. Tests that
    create incidents via the API bump it; without a reset, later tests see
    stale deltas and the underwriter-baseline assumptions break."""
    from app.underwriting.scoring import incident_delta_tracker
    incident_delta_tracker.reset()
    yield
    incident_delta_tracker.reset()
