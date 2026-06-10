# Backend testing — fast inner loop, full suite before merge

The suite is ~1,300 tests. You almost never need to run all of it while iterating.
Pick the smallest gear that covers your change; CI runs everything.

## Gears (fastest → most thorough)

| Command (from `backend/`) | What | Speed |
|---|---|---|
| `python -m pytest -m unit` | Pure-logic tests (pricing, scorers, money/time, schemas) — no app/DB | ~30 s |
| `python -m scripts.affected_tests --run` | Only the test files your current diff touches (import-graph) | varies |
| `python -m pytest -m integration` | Everything that spins up a TestClient / DB session | ~2.5 min |
| `python -m pytest` | Full suite | ~3.5 min |

### Run only what your change affects
`scripts/affected_tests.py` maps your git diff → the test files that (transitively)
`import` the changed `app.*` modules, via static import edges.

```bash
python -m scripts.affected_tests              # print the affected test files
python -m scripts.affected_tests --run        # run pytest on just those
python -m scripts.affected_tests --base main  # vs a base ref instead of working tree
python -m scripts.affected_tests --run -- -x  # pass flags through to pytest
```
It's conservative and honest: changing a foundational module (e.g. `app/auth.py`,
imported almost everywhere) legitimately selects most of the suite — that *is* the
blast radius. A leaf service selects a handful of files.

## The `unit` / `integration` split is automatic
`tests/conftest.py::pytest_collection_modifyitems` tags each test by reading its
source: a file that mentions `TestClient`, `get_session`, or `create_db_and_tables`
is `integration`; otherwise `unit`. **No per-file markers to maintain** — write a
test and it lands in the right tier. Markers are registered in `pytest.ini`
(`--strict-markers`, so a typo'd `-m` fails loudly).

## Why it's fast now (and was slow before)
- **bcrypt cost.** `app.auth.create_password_hash` uses 4 rounds under `TESTING`
  (set in `conftest.py`) instead of 12. bcrypt's slowness is a production security
  feature and pure overhead in tests; it was the single dominant cost (the auth
  files alone went 168 s → 8.5 s; the full suite 37 min → ~3.5 min). Verification is
  cost-agnostic, so real 12-round hashes still verify.

## Known limitation — shared-DB ordering coupling (tracked)
Tests share one on-disk `sqlite:///database.db`, so writes accumulate across files.
A couple of "broker sees all rows" list tests
(`test_evidence_tenant_isolation`, `test_ingestion_runs_api`) can fail in full-suite
*order* while passing in isolation — accumulated rows push their seeded rows out of a
limited query window. It's an isolation gap, not a product bug. The fix (per-test DB
reset + `pytest-xdist -n auto` for true parallelism) is tracked in the backlog
(Track 13 testing-infra). Until then: if one of those two fails in a full run, re-run
it alone to confirm it's the ordering flake.

If you hit "no such column" or stale rows locally: `rm database.db` (the schema
self-heals via the `_COLUMN_MIGRATIONS` allowlist on next boot).
