# Nightline Risk - Project Configuration

## Project Overview
Nightline Risk is a local demo of an underwriting and claims-defensibility workflow for venues. The current product slice turns a synthetic venue brawl incident into a cited underwriting packet with risk signal, customer actions, claims timeline, and underwriter memo.

The application architecture includes:
- **Backend:** Python application using FastAPI, SQLModel, SQLite, and agent orchestration. It contains dependencies for AI integration (`google-generativeai`, `instructor`, `chromadb`).
- **Frontend:** Next.js (React 19) web application using TypeScript. It provides an underwriter console and a venue dashboard.
- **Infrastructure:** Docker Compose is configured for Redpanda (Kafka-compatible messaging), Postgres + pgvector (database/vector storage), and Redis (caching).

## Building and Running

### Backend
Navigate to the `backend/` directory to run the API locally:
```powershell
cd backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### Frontend
Navigate to the `frontend/` directory to run the Next.js development server:
```powershell
cd frontend
npm.cmd run dev -- --hostname 127.0.0.1 --port 3000
```
Open `http://localhost:3000/underwriter` in the browser.

To build the frontend for production:
```powershell
cd frontend
npm.cmd run build
```

### Infrastructure
To start the supporting services (Postgres, Redis, Redpanda):
```powershell
docker-compose up -d
```

## Testing

### Backend Tests
```powershell
cd backend
pytest -q -p no:flaky
```

### Frontend Tests
```powershell
cd frontend
npm.cmd run test
```

## Development Conventions
- **Backend Framework:** FastAPI with SQLModel for ORM/database interaction. Uses `pytest` for backend testing.
- **Frontend Framework:** Next.js with React 19, heavily relying on TypeScript for static typing. Code resides in `frontend/src/app/` following App Router patterns.
- **Deterministic Orchestration:** The current backend logic operates deterministically without live LLM calls, handling workflows like claims timeline, customer action generation, retrieval, and underwriter memo synthesis via pre-configured agents.

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
