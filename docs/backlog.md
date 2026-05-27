# Engineering Backlog

Working checklist for the subscription-free work (no API keys, no S3/email/SMS
accounts yet). Gated/integration items live in [`go-live-readiness.md`](./go-live-readiness.md).

Last updated: 2026-05-27.

---

## Recently shipped (context for picking back up)

- [x] Web↔mobile consistency: Book navigation fix, role-aware naming, factor-glyph parity, 3 new mobile screens (Settings, Market, Ingestion).
- [x] Settings made real: `PATCH /api/auth/me` + change-password (web + mobile); fake sub-sections neutralized.
- [x] Password reset flow (built; emails gated on `RESEND_API_KEY` — logs the reset URL until then).
- [x] Config hardening: `validate_startup_env()` fails fast in prod without `APP_SECRET` (caught a real silent-session-reset bug on Railway).
- [x] Storage abstraction: all file I/O behind `app/storage.py` (`LocalStorage`); S3 is a one-class swap.
- [x] ETL hardening: startup-seeds connector runs (demo page populated), rejection-reason observability, extract retry/backoff. De-flaked `test_run_pos_moves_a_venue_score`.
- [x] Test scaffolding: Vitest (frontend), jest-expo (mobile).

---

## Next up (subscription-free) — pick a track

### 1. Eval harness deepening  ★ headline / best pitch fit
- [ ] Audit current eval scenarios + scoring in `backend/app/evals/` (runner, baselines).
- [ ] Add more research-grounded incident scenarios (A&B, dram-shop, crowd, medical).
- [ ] Per-provider baseline snapshots + regression gate (runs on deterministic providers — no keys).
- [ ] Render a scorecard on the `/evals` page (pass-rate, per-factor accuracy, deltas).
- [ ] Wire/confirm the CI gate fails on baseline regression.

### 2. Correctness pass on latent bugs  ✓ done 2026-05-27
- [x] Fix the tz naive/aware crash in incident-packet backfill — `_reconstruct_timeline_meta._parse` returned mixed-awareness datetimes (naive seed `occurred_at` vs aware `Z` stream events); normalized via `as_utc()`. Regression test in `test_claims_timeline_meta.py`.
- [x] Swept `fromisoformat`/`timedelta`/`total_seconds` sites — no other Python naive/aware comparison crashes. `alert_dispatcher.py:181` uses naive `utcnow()` but only in a SQL filter (DB-handled); left as-is per the out-of-scope `utcnow` deprecation rule.
- [x] Reviewed every `except Exception` site — all log or are intentional best-effort guards; none silently hide real failures.

### 3. Deterministic (no-key) agent quality
- [ ] Improve the keyword-ladder risk classifier (`app/providers/deterministic.py`) — better factor recognition than ~50%.
- [ ] Tighten deterministic memo templates so no-key output reads credibly in a demo.
- [ ] Add eval coverage that pins the deterministic-mode quality (ties into track 1).

### 4. Test-coverage expansion
- [ ] Frontend: component/integration tests beyond the `account`/`market` unit tests; broaden the 6 Playwright e2e specs.
- [ ] Enable the skipped `frontend/e2e/settings.spec.ts` once the backend deploy includes the auth endpoints (it's `describe.skip` pending deploy).
- [ ] Mobile: tests beyond `format.ts` helpers (lightweight, given Expo render-test flakiness).

---

## Gated — needs an account/keys (revisit when available)

See [`go-live-readiness.md`](./go-live-readiness.md) for detail. Summary:
- [ ] 🔒 Object storage (S3/GCS) — `S3Storage` behind the existing `Storage` interface; **biggest real blocker** (Railway FS is ephemeral → evidence/PDFs vanish on redeploy).
- [ ] 🔒 Email provider (Resend) — set `RESEND_API_KEY` + `FRONTEND_URL`, verify domain → reset emails actually send.
- [ ] 🔒 LLM live mode — set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` (+ budget) to swap deterministic stubs for real agents.
- [ ] 🔒 A real operational connector (e.g. scheduling/POS) — the `staffing` slot is the cheapest real-API swap.
- [ ] SMS (Twilio), payments (Stripe), loss-run ingestion — only if v1 scope expands.

---

## Recommended order

Quick confidence-builder: **track 2 (correctness)** → headline work: **track 1 (evals)**. Tracks 3–4 are good filler. All four are independent; none need a subscription.
