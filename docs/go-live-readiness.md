# Go-Live Readiness — Integration Checklist

Status of every external dependency, grounded in a code audit (2026-05-27).
Legend: ✅ real · 🟡 simulated/partial · ⚪ absent · 🔒 needs a paid/external account.

The AI layer is production-shaped; the gaps are mostly plumbing (storage, email,
secrets). Work items are ordered by go-live impact.

---

## Done (this pass)

- [x] **`APP_SECRET` hardening** — `app/config.py` `validate_startup_env()` runs first in the `main.py` lifespan and refuses to boot in production without `APP_SECRET` (no more silent ephemeral-secret → everyone-logged-out-on-restart). Dev keeps the warning fallback. `.env.example` documents all vars.
- [x] **Storage abstraction** — all evidence/compliance file I/O routes through `app/storage.py` (`get_storage()`), `LocalStorage` today. Swapping to S3 is a one-class add (`STORAGE_BACKEND=s3`). No DB migration (refs stay path strings).
- [x] **Password reset + pluggable email** — `app/services/email.py` (Resend, env-gated) + `/api/auth/forgot-password` & `/reset-password`; frontend "Forgot password?" + `/reset-password` page. Emails send once `RESEND_API_KEY` is set; until then the reset URL is logged.

---

## Hard blockers remaining

- [ ] 🔒 **Object storage (S3/GCS).** `LocalStorage` writes to `backend/evidence_uploads/` — **ephemeral on Railway**, so evidence + the tamper-evident defense packets vanish on redeploy. Implement `S3Storage` behind the existing `Storage` protocol and set `STORAGE_BACKEND=s3`. *Deferred: no blob subscription yet.*
- [ ] 🔒 **Email provider account.** The flow is built and env-gated; create a Resend (or SendGrid/SES) account, set `RESEND_API_KEY` + `FRONTEND_URL`, verify a sending domain.

## Deliver the core promise (simulated today)

- [ ] 🔒 **Real operational connectors.** POS, ID-scanner, and staffing/scheduling are simulated RNG (`app/ingestion/connectors.py`). The "risk score from operational reality" pitch needs ≥1 real feed (e.g. Toast/Square POS, 7shifts/Deputy scheduling). The `staffing` connector is the cheapest real-API swap (the slot already exists).
- [ ] **NYC Open Data freshness.** `NycOpenDataConnector` reads a committed static snapshot, not a live pull — fine for prospects, goes stale over months. Refresh job or live fetch later.
- [ ] 🔒 **Live carrier integration (optional).** Quotes are an internal indicative engine; there's no IVANS/rating API. A manual path exists (`/api/quotes/{qid}/record-response` lets a broker enter the real carrier reply), so carrier-in-the-loop works for an MVP without integration.

## Config / ops

- [ ] **Set production env.** `APP_SECRET` (required), `DATABASE_URL` (Postgres), and the optional feature keys — see `backend/.env.example`.
- [ ] ✅ **LLM providers** — real (Anthropic/Gemini/OpenAI), env-gated, deterministic fallback. Needs `*_API_KEY` + budget to run in live mode.
- [ ] ✅ **Web push** — real; needs `VAPID_PRIVATE_KEY`.

## Out of scope for v1 (tracked)

- [ ] ⚪ **SMS** (Twilio) — none.
- [ ] ⚪ **Payments/billing** — commission/premium are `Decimal` fields only; no Stripe/money movement. Only needed if v1 collects or pays.
- [ ] ⚪ **Loss-run ingestion** — a Phase-6 hook exists in `pricing.py`; no data feed.
