# Nightline Risk

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

- 5000+ venue customers day 0 â€” existing book, not startups
- Backend is deterministic today; agents execute Python logic, not live LLM calls
- The system turns venue incidents into cited underwriting packets with risk signals, claims timeline, and underwriter memo

## Tests

- Backend tests use pytest with a `no:flaky` profile (defined in pytest.ini)
- Frontend tests are plain Node assertions in `src/lib/incidentView.test.mjs`

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
