# Third Space Risk Requirements and Design

Last updated: 2026-05-05

## Purpose

This document is the living source of truth for the current Third Space Risk demo. It serves two audiences:

- Interview briefing: a concise explanation of the product thesis, demo flow, and technical choices.
- Engineering handoff: a requirements/design record for what exists today, how it works, what is still mocked, and what should come next.

## Product Thesis

Third Space Risk is an underwriting and claims-defensibility operating system for venues. The core idea is that music venues, bars, and other "third spaces" generate operational signals every night, but those signals are usually disconnected from insurance workflows.

The demo shows how a venue incident can become a structured underwriting packet:

- incident details from venue staff
- relevant operational context from door count, POS, staffing, policy, and camera metadata
- a risk signal for underwriter review
- an evidence checklist for claims defensibility
- an underwriting memo with open questions
- a reconstructed timeline with cited sources

The current scope is intentionally narrow: one venue, one brawl incident, one underwriting review packet.

## Current Demo Scope

The implemented demo centers on Elsewhere Brooklyn as a synthetic venue profile.

Primary user path:

1. User opens the underwriter console at `/underwriter`.
2. The page displays a fallback preview packet so the experience is useful before the backend is called.
3. User clicks `RUN BRAWL FLOW`.
4. Frontend posts a fixed demo incident to the backend.
5. Backend builds a cited incident review packet from seeded knowledge sources and stream events.
6. Frontend replaces the fallback preview with the live API response.

Secondary path:

1. Backend exposes a high-volume event ingestion endpoint.
2. Event payloads are accepted immediately with `202`.
3. Processing is simulated through a FastAPI background task.

## What Exists Today

### Backend

Location: `backend/`

Implemented with FastAPI, SQLModel, SQLite, and Pydantic.

Current endpoints:

- `GET /api/health`
  - Returns service health.
- `GET /api/venues`
  - Returns seeded venue data.
- `POST /api/venues/{venue_id}/incidents`
  - Creates a brawl incident review packet for a known venue.
  - Persists the incident and evaluation to SQLite.
  - Returns an `IncidentFlowResponse`.
- `POST /api/venues/{venue_id}/events/stream`
  - Accepts a list of stream events.
  - Simulates async queue processing through a background task.

Important backend files:

- `backend/app/main.py`
  - FastAPI app, startup seeding, CORS, routes.
- `backend/app/incident_flow.py`
  - Core brawl incident workflow.
- `backend/app/schemas.py`
  - API request/response models.
- `backend/app/models.py`
  - SQLModel persistence models.
- `backend/app/rag.py`
  - Simple keyword-based retrieval over seeded documents and stream events.
- `backend/app/agents/`
  - Product runtime Markdown contracts for future underwriting packet agents.
  - Contracts exist for retrieval, risk evaluation, underwriter memo drafting, customer actions, and claims timeline reconstruction.
  - These contracts are loaded at runtime by a deterministic orchestration layer.
- `backend/app/agents/runtime.py`
  - Deterministic agent workflow/orchestration layer for the underwriting packet flow.
  - Loads required Markdown contracts, records step metadata internally, and executes retrieval, risk evaluation, customer actions, timeline reconstruction, and memo drafting without live LLM calls.
- `backend/app/seed_data.py`
  - Synthetic venue, knowledge sources, and stream events.
- `backend/app/database.py`
  - SQLite engine and session provider.
- `backend/app/fastapi_compat.py`
  - Compatibility patch for FastAPI/Starlette mismatch in this local environment.

### Frontend

Location: `frontend/`

Implemented with Next.js, React, and plain CSS.

Current routes:

- `/`
  - Venue-style dashboard with industrial visual treatment.
  - Currently static.
- `/underwriter`
  - Editorial underwriter dossier UI.
  - Calls the backend incident flow.
  - Shows incident details, risk signal, memo, RAG evidence, and timeline.

Important frontend files:

- `frontend/src/app/underwriter/page.tsx`
  - Main interactive underwriter console.
- `frontend/src/app/page.tsx`
  - Static venue portal/dashboard view.
- `frontend/src/app/styles.css`
  - Global styling, venue theme, editorial theme, responsive rules.
- `frontend/src/lib/incidentView.mjs`
  - Small helper for summarizing evidence.
- `frontend/src/lib/incidentView.test.mjs`
  - Node assertion test for evidence summary behavior.

### Tests and Verification

Backend:

- `backend/tests/test_brawl_incident_flow.py`
  - Verifies the incident endpoint creates a cited review packet.
  - Verifies the same demo incident can be submitted more than once without primary-key collision.
- `backend/pytest.ini`
  - Restricts test collection to `tests/` so generated pytest cache temp directories do not break test discovery.

Frontend:

- `npm run test`
  - Runs `node src/lib/incidentView.test.mjs`.
- `npm run build`
  - Verifies Next.js production build and TypeScript compilation.

Latest verified commands:

```powershell
cd backend
pytest -q

cd ..\frontend
npm run test
npm run build
```

## Architecture

### Request Flow

```text
Browser /underwriter
  -> POST /api/venues/elsewhere-brooklyn/incidents
    -> validate venue id
    -> create incident object
    -> retrieve seeded citations
    -> create risk signal
    -> create action plan
    -> build claims timeline
    -> create underwriting memo
    -> persist incident and evaluation
    -> return IncidentFlowResponse
  -> render dossier sections from response
```

### Data Flow

Input:

- Hard-coded demo incident in `frontend/src/app/underwriter/page.tsx`.

Context sources:

- Policy text.
- Staffing log.
- Controls questionnaire.
- Door count event.
- POS event.
- Camera metadata event.

Processing:

- `create_brawl_incident_flow()` creates the incident record and delegates packet assembly to the deterministic agent runtime.
- `backend/app/agents/runtime.py` loads the Markdown contracts and executes named agent steps.
- The retrieval step uses `VenueKnowledgeBase.retrieve()` to score seeded documents using query terms.
- Risk evaluation, customer actions, timeline reconstruction, and memo drafting are deterministic Python implementations behind the agent boundary.
- No LLM, provider integration, or prompt executor is called by the backend.

Output:

- Incident packet containing incident details, risk signal, action plan, claims timeline, underwriting memo, and citations.

### Agent Contracts Roadmap

The project now has product-facing Markdown contracts and deterministic runtime orchestration for the underwriting packet flow:

- Retrieval agent
  - Defines search intent, required source types, citation standards, missing evidence, and retrieval review status.
- Risk evaluator agent
  - Maps incident facts and cited evidence to risk type, severity, confidence, explanation, mitigating factors, and review status.
- Underwriter memo agent
  - Drafts underwriter-facing summary, evidence summary, open questions, audit notes, and cited underwriting impact.
- Customer action agent
  - Converts packet gaps into venue/customer-facing evidence tasks while avoiding unsupported liability language.
- Claims timeline agent
  - Reconstructs event chronology with source ids, confidence, gaps, and defensibility notes.

Contracts-first and deterministic orchestration were chosen deliberately:

- Explainability: the demo can show how agent responsibilities are separated before model behavior is introduced.
- Testability: expected inputs, outputs, citations, review flags, and failure modes can become eval fixtures.
- Demo integrity: the current system stays deterministic instead of introducing unvalidated LLM behavior into the interview flow.

Provider-backed runtime integration should come later, after provider setup and evals exist. A future implementation may route each packet step through an LLM, a deterministic fallback, or a hybrid path. The current request path already uses the agent orchestration boundary, but each step still executes deterministic Python logic.

### Persistence

SQLite is used for MVP persistence.

Tables:

- `Venue`
  - `id`
  - `name`
- `IncidentRecord`
  - incident metadata and reported facts
  - one-to-one relationship to evaluation
- `IncidentEvaluation`
  - JSON fields for risk signal, action plan, underwriting memo, and claims timeline

Incident IDs use a UUID suffix so repeated demo submissions do not collide.

## API Contract

### IncidentCreate

```json
{
  "occurred_at": "2026-05-02T23:13:00Z",
  "location": "rear bar",
  "summary": "Two patrons began fighting near the rear bar during a sold-out DJ event.",
  "reported_by": "shift-lead",
  "injury_observed": false,
  "police_called": false,
  "ems_called": false
}
```

### IncidentFlowResponse

Top-level fields:

- `incident`
- `risk_signal`
- `action_plan`
- `claims_timeline`
- `underwriting_memo`

The frontend currently depends on this response shape directly.

## Local Development

Backend:

```powershell
cd backend
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Frontend:

```powershell
cd frontend
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open:

- Frontend: `http://localhost:3000/underwriter`
- Backend health: `http://localhost:8000/api/health`

Important CORS note:

- Backend currently allows `http://localhost:3000`.
- Use `localhost` in the browser unless CORS is expanded.

## Requirements Captured So Far

### Product Requirements

- Show how operational venue data supports underwriting and claims defense workflows.
- Support two primary personas: venue operators and brokers/underwriters.
- Make evidence visible and cited — not hidden behind generic AI output.
- Preserve a clear distinction between observed facts, source evidence, and generated outputs.
- Demonstrate the full operational loop: live data → compliance action → evidence upload → claims defense.
- Communicate the savings story: Third Space rate vs market rate, not just a risk score.
- Provide a local demo that runs end-to-end without narration.

### Functional Requirements

**Broker/Underwriter flows:**
- Portfolio dashboard showing all venues with tier, score, live capacity, open incidents per venue.
- Packet Review (underwriter workbench) opens pre-loaded with the best scenario.
- Lifecycle tabs: draft → processing → needs_review → approved → blocked.
- Review Decision capture (Approve/Flag/Block) persisted to backend via audit trail.
- AI engine label and proprietary underwriting signal visible.

**Venue Operator flows:**
- Venue Risk terminal shows live capacity, insurance profile (tier, score, premium, savings vs market), coverage breakdown, infrastructure sync.
- Simulate Alert button injects a camera anomaly event synchronously, causing a compliance item to appear in the queue.
- Compliance queue with file upload — resolving items removes them from the queue.
- Incidents page with status lifecycle (open → under_review → closed), filter tabs, and close/review actions.

**Shared:**
- Role-based auth (broker, venue_operator) with hardcoded demo credentials.
- Quick Demo Login button on the login page.
- 5 seeded venues with differentiated risk scores, tiers, and infrastructure profiles.
- Incident status field with `?status=open` filter on the incidents API.
- All nav items functional — no dead ends.

### Non-Functional Requirements

- Local setup runnable before an interview with two terminal commands.
- Build (Next.js) and tests (pytest + node) pass without manual cleanup.
- No Tailwind — custom CSS utility system in `styles.css`.
- Frontend renders correctly at 1440px desktop width.

## Known Limitations

- Five synthetic venues; only Elsewhere Brooklyn has full underwriting packet data.
- Incident creation in the underwriter uses a fixed demo payload.
- Retrieval is keyword-based, not vector search.
- The rubric engine is deterministic Python — no LLM calls in the packet flow.
- No model eval suite or provider-backed fallback router.
- SQLite for persistence — not production-grade.
- Auth uses in-memory hardcoded users — no real JWT or session management.
- No frontend integration tests or browser visual regression tests.
- The Simulate Alert loop demonstrates the concept but uses an in-memory state manager, not a real event queue.
- Stream events endpoint processes asynchronously via FastAPI BackgroundTasks, not Kafka or a real queue.
- Venues page "Add Venue" shows an informational toast — venue onboarding is not implemented.

## Open Questions

Product:
- How should the broker manage renewals and carrier relationships inside the product?
- What carrier-facing outputs would actually move an underwriting decision?
- Should claims defense exports be structured documents or API-accessible records?

Technical:
- When should RAG move from keyword to vector search?
- Should the live state manager persist across server restarts (Redis/DB)?
- Should the event injection endpoint remain a demo affordance or become a real ingestion path?

## Current Demo Flow

Primary path for interview:

1. `/login` — hit ⚡ QUICK DEMO LOGIN.
2. `/dashboard` — portfolio view: 5 venues, differentiated tiers A/B/B/B/C.
3. Click **Elsewhere Brooklyn** → `/terminal/elsewhere-brooklyn`:
   - Risk Profile: Tier A, 93/100
   - Premium: $8,400/yr vs market $12,000/yr — **saving $3,600/yr (30%)**
   - Press **Simulate Alert** → camera anomaly injected → compliance item appears
   - Upload evidence → compliance item resolves
4. `/underwriter` (Packet Review):
   - Pre-loaded with Delayed Brawl scenario
   - 3-column: context rail, risk signal + memo + timeline, evidence index
   - Press **REFRESH** → runs real backend flow → Review Decision panel appears
   - Approve / Flag / Block recorded to audit trail

## Interview Talking Points

- "Two personas, two aesthetics: the venue operator sees their live operational defense, the broker sees the underwriting intelligence layer."
- "The savings story is a single number: $3,600/year saved at Elsewhere Brooklyn vs market rate, driven by evidence-first underwriting."
- "The Simulate Alert button demonstrates the full loop in 30 seconds — camera anomaly, compliance action, evidence upload — without any narration."
- "The rubric engine is deterministic and versioned. LLM-assisted drafting is Phase 2, after citation validation is reliable."
- "Every generated packet has a review state. Every underwriter decision is recorded with a reason. That's the audit trail carriers need."
- "I deliberately stopped before Postgres, Kafka, and real LLM calls. Those come after the source registry and human review loop are proven."

## Maintenance Notes

When changing the project, update this document if the change affects:

- supported user flows
- API response shape
- data model
- local run commands
- known limitations
- next milestone scope
- interview explanation
