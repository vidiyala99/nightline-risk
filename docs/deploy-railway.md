# Backend deploy — Railway + Neon (reverted from Render, 2026-05-30)

The backend (FastAPI) runs on **Railway** (Hobby $5 plan, always-on); Postgres is
**Neon** (free tier, permanent). Frontend stays on Vercel.

Service: **`nightline-risk-api`** (project `cheerful-gentleness`) →
`https://nightline-risk-api-production-355c.up.railway.app`
(Railway assigns the `-355c` suffix; it's tied to the project, not the repo name.)

> Why Railway over the free Render tier: Render's free web service sleeps after
> ~15min idle (~50s cold start), which made demos feel unreliable. The $5 Hobby
> plan is always-on. Neon stays as the DB because it's free, permanent, and was
> already seeded — Railway only provides the always-on compute.

---

## Service configuration
- **Source:** GitHub `vidiyala99/nightline-risk`, branch `main`, **Root Directory `backend`**.
- **Builder: Dockerfile** (`backend/railway.toml` sets `builder = "dockerfile"`).
  Nixpacks fails to build the native deps (chromadb/onnxruntime); the committed
  `backend/Dockerfile` (python:3.12-slim) is the same image Render built fine.
  The Dockerfile's `CMD` binds `${PORT:-8080}`; Railway injects `$PORT`.
- **Do NOT add a Railway Postgres plugin** — we use Neon.

## Environment variables (set on the service → Variables)
| Key | Value |
|---|---|
| `DATABASE_URL` | the Neon **pooled** connection string (`...-pooler...?sslmode=require&channel_binding=require`) |
| `APP_SECRET` | a strong random secret — the app refuses to boot in prod without it |
| `APP_ENV` | `production` |
| `STORAGE_BACKEND` | `local` (ephemeral on Railway too; S3 is the real fix — see `docs/go-live-readiness.md`) |

Railway auto-injects `PORT` and `RAILWAY_ENVIRONMENT` (the latter drives
`app.config.is_production()`). No `GEMINI_API_KEY` needed — the app falls back to
its deterministic provider without it.

## Point the frontend + mobile at Railway
- **Vercel** (frontend): set `NEXT_PUBLIC_API_URL = https://nightline-risk-api-production-355c.up.railway.app`
  for **Production AND Preview**, then redeploy (NEXT_PUBLIC vars are baked at build
  time — a redeploy is required, and watch for stray trailing whitespace/dots).
- **Mobile** (Expo): set `EXPO_PUBLIC_API_URL` the same way for builds.
- e2e specs, `.github/workflows/e2e.yml`, and `scripts/seed_demo_data.py` already
  point at this URL.

## Seeding (optional, after first deploy)
Run seeds from your machine against Neon directly (from `backend/`):
```
DATABASE_URL="<neon-connection-string>" python -m scripts.seed_demo_placements
DATABASE_URL="<neon-connection-string>" python -m scripts.seed_prospects
DATABASE_URL="<neon-connection-string>" python -m scripts.seed_defense_demo
```

## Notes / caveats
- **Neon free Postgres is permanent** and needs no card; CORS in `app/main.py`
  already allows `nightline-app.vercel.app` + `*.vercel.app`.
- **Ephemeral storage:** local-disk evidence files are lost on redeploy. Fix is
  `STORAGE_BACKEND=s3`.
- The old Render Blueprint (`render.yaml`) and Fly config (`backend/fly.toml`) are
  left in the repo for rollback. The retired `thirdspacerisk-production` Railway
  project (with its own Postgres) can be deleted once this one is confirmed.
