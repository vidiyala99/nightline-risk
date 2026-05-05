# Third Space Risk

AI-native insurance broker for nightlife venues (bars, clubs, music venues). Uses operational data (camera, POS, HR) for proprietary underwriting and claims defense.

## Tech Stack
- **Backend:** Python/FastAPI, SQLModel, SQLite, pytest
- **Frontend:** Next.js/React, plain Node test runner
- **Agents:** Deterministic (no live LLM calls yet)

## Commands

```powershell
# Backend
cd backend
pytest -q -p no:flaky                              # Run tests (skip flaky)
uvicorn app.main:app --host 127.0.0.1 --port 8000  # Dev server

# Frontend
cd frontend
npm.cmd run test                                   # Run tests
npm.cmd run build                                  # Build
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000  # Dev server
```

> Note: Use `npm.cmd` on Windows, not `npm`.

## Key Directories

| Path | Purpose |
|------|---------|
| `backend/app/incident_flow.py` | Core underwriting flow |
| `backend/app/orchestration/` | Agent orchestration engine |
| `backend/app/agents/` | Agent definitions (retrieval, risk evaluator, claims timeline, etc.) |
| `frontend/src/app/underwriter/` | Underwriter console UI |

## Context

- 5000+ venue customers day 0 — existing book, not startups
- Backend is deterministic today; agents execute Python logic, not live LLM calls
- The system turns venue incidents into cited underwriting packets with risk signals, claims timeline, and underwriter memo

## Tests

- Backend tests use pytest with a `no:flaky` profile (defined in pytest.ini)
- Frontend tests are plain Node assertions in `src/lib/incidentView.test.mjs`