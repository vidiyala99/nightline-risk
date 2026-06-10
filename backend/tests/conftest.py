import os
import sys
from pathlib import Path

import pytest

# Mark the process as a test run BEFORE app modules import. Gates the cheap-bcrypt
# path (app.auth) and any other test-only fast paths. Set as early as possible so
# module-level seeding done at fixture/lifespan setup also sees it.
os.environ.setdefault("TESTING", "1")

# Route ALL integration tests (TestClient / get_session) at a throwaway DB so the
# suite can never write into the real dev database.db. app.database reads
# DATABASE_URL and falls back to sqlite:///database.db — so set it here, before the
# app modules are (re)imported below. The dev backend runs without this env var, so
# it keeps using database.db; only the pytest process is redirected.
os.environ.setdefault("DATABASE_URL", "sqlite:///test_run.db")


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
# Put the tests dir itself on the path so shared helpers (e.g. `factories`) are
# importable as top-level modules from any test file (`tests/` is not a package).
sys.path.insert(0, str(Path(__file__).resolve().parent))
for module_name in list(sys.modules):
    if module_name == "app" or module_name.startswith("app."):
        del sys.modules[module_name]


_INTEGRATION_MARKERS = ("TestClient", "get_session", "create_db_and_tables")
_file_is_integration: dict[str, bool] = {}


def _is_integration(path: str) -> bool:
    """A test file is `integration` if it touches the app/DB stack (spins up a
    TestClient, opens a DB session, or bootstraps tables); otherwise `unit`
    (pure functions — pricing, scorers, money/time helpers, schemas). Auto-derived
    from source so the split stays correct with zero per-file labeling."""
    cached = _file_is_integration.get(path)
    if cached is not None:
        return cached
    try:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
    except OSError:
        text = ""
    result = any(tok in text for tok in _INTEGRATION_MARKERS)
    _file_is_integration[path] = result
    return result


def pytest_collection_modifyitems(items):
    """Tag every test `unit` or `integration` (auto). Inner-loop: `pytest -m unit`
    (sub-second, no DB); pre-merge / CI: the full suite. Keeps the fast tier honest
    without anyone remembering to add a marker."""
    for item in items:
        mark = "integration" if _is_integration(str(item.fspath)) else "unit"
        item.add_marker(getattr(pytest.mark, mark))


@pytest.fixture(autouse=True)
def _reset_incident_delta_tracker():
    """Module-level singleton tracks new incidents in-process. Tests that
    create incidents via the API bump it; without a reset, later tests see
    stale deltas and the underwriter-baseline assumptions break."""
    from app.underwriting.scoring import incident_delta_tracker
    incident_delta_tracker.reset()
    yield
    incident_delta_tracker.reset()
