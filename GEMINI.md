# Third Space Risk - Project Configuration

## Project Overview
Third Space Risk is a local demo of an underwriting and claims-defensibility workflow for venues. The current product slice turns a synthetic venue brawl incident into a cited underwriting packet with risk signal, customer actions, claims timeline, and underwriter memo.

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
