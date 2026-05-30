# Backend deploy — Fly.io (migrated off Railway, 2026-05-30)

The backend (FastAPI + Postgres) runs on **Fly.io**. Frontend stays on Vercel.
Railway is retired — it crash-looped (502) on a Postgres-invalid migration and
the move gives us an always-on host we control.

App: **`nightline-risk-api`** → `https://nightline-risk-api.fly.dev`
Config lives in `backend/fly.toml` + `backend/Dockerfile`.

> Why a persistent server (not serverless): the app runs an in-process asyncio
> vision queue and holds in-memory state (`IncidentDeltaTracker`, live-state
> manager). It needs an always-on process — hence Fly machines, not functions.

---

## One-time setup (you run these — they need your Fly account/auth)

```bash
# 0. Install flyctl + log in
#    Windows: iwr https://fly.io/install.ps1 -useb | iex
fly auth login

cd backend

# 1. Create the app (uses backend/fly.toml; name must match `app =` there)
fly apps create nightline-risk-api

# 2. Provision managed Postgres and attach it (sets the DATABASE_URL secret).
#    app/database.py already normalizes postgres:// -> postgresql://, so no edits.
fly postgres create --name nightline-risk-db --region iad
fly postgres attach nightline-risk-db --app nightline-risk-api

# 3. Required secret — config.validate_startup_env() REFUSES to boot in prod
#    without APP_SECRET. Generate a strong one:
fly secrets set APP_SECRET=$(openssl rand -hex 32) --app nightline-risk-api
#    Optional providers (app degrades gracefully without them):
#    fly secrets set GEMINI_API_KEY=... RESEND_API_KEY=... --app nightline-risk-api

# 4. Deploy
fly deploy

# 5. Verify it booted (the migration that broke Railway must succeed here)
curl -s https://nightline-risk-api.fly.dev/api/coverage-lines   # expect a JSON array
```

## Point the frontend + mobile at Fly

- **Vercel** (frontend): set `NEXT_PUBLIC_API_URL = https://nightline-risk-api.fly.dev`
  for the Production environment, then redeploy.
- **Mobile** (Expo): set `EXPO_PUBLIC_API_URL` the same way for builds.
- e2e (`frontend/e2e/*`, `.github/workflows/e2e.yml`) and `README.md` are already
  swapped to the Fly URL in this repo.

## Seeding (optional, after first deploy)

Run seeds against the Fly Postgres. Easiest from your machine using the DB's
**public** URL (Railway-style note carried over):

```bash
fly postgres connect -a nightline-risk-db   # or grab the connstring
DATABASE_URL=<public-conn-string> python -m scripts.seed_demo_placements
```

## Notes / caveats

- **Ephemeral storage:** local-disk evidence files are still lost on machine
  restart/redeploy (same as Railway). The real fix is `STORAGE_BACKEND=s3`
  (`docs/go-live-readiness.md`) — unchanged by this migration.
- **Memory:** `fly.toml` requests 1GB to avoid a chromadb-import OOM crash-loop.
  Drop to 512MB only after confirming the boot footprint.
- **Always-on:** `min_machines_running = 1` (no cold start). Flip to
  `auto_stop_machines = "stop"` + `min_machines_running = 0` to cut cost at the
  expense of a cold start on first hit.
- **Railway:** `backend/railway.toml` is left in place for rollback optionality;
  disconnect Railway's GitHub auto-deploy on their dashboard so it doesn't keep
  trying to build the crash-looping service.
