# Engineering Backlog

Working checklist for the subscription-free work (no API keys, no S3/email/SMS
accounts yet). Gated/integration items live in [`go-live-readiness.md`](./go-live-readiness.md).

Last updated: 2026-05-30.

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

### 1. Eval harness deepening  ★ headline / best pitch fit  — mostly already shipped (audited 2026-05-27)
- [x] Audit current eval scenarios + scoring — done. Harness is mature: 15 standard + 6 adversarial scenarios, 10 scorers (severity/citation/review-status/factor + NDCG@5/MRR retrieval + 3 safety).
- [x] ~~Add more research-grounded scenarios~~ — already 15 across 7 exposure classes (A&B, dram-shop, crowd, medical, premises, property, negligent-security) + 6 adversarial.
- [x] ~~Per-provider baseline snapshots + regression gate~~ — already stack-keyed (`baseline.py`); `--compare-baseline` exits 1 on any scorer drop.
- [x] ~~Scorecard on `/evals`~~ — already a full scoreboard (`frontend/src/app/evals/page.tsx`); reads `public/eval-baseline.json`.
- [x] ~~Wire/confirm CI gate~~ — already wired: `evals` + `evals-matrix` jobs in `ci.yml` run `--compare-baseline`.
- [x] Closed the last gap: `off_topic_review_status` 50%→100%. The review gate now fail-safes to `needs_review` on any `general_incident` (unrecognized) input instead of auto-approving at low severity. Aggregate now **21/21 = 100%** on the deterministic stack.

### 2. Correctness pass on latent bugs  ✓ done 2026-05-27
- [x] Fix the tz naive/aware crash in incident-packet backfill — `_reconstruct_timeline_meta._parse` returned mixed-awareness datetimes (naive seed `occurred_at` vs aware `Z` stream events); normalized via `as_utc()`. Regression test in `test_claims_timeline_meta.py`.
- [x] Swept `fromisoformat`/`timedelta`/`total_seconds` sites — no other Python naive/aware comparison crashes. `alert_dispatcher.py:181` uses naive `utcnow()` but only in a SQL filter (DB-handled); left as-is per the out-of-scope `utcnow` deprecation rule.
- [x] Reviewed every `except Exception` site — all log or are intentional best-effort guards; none silently hide real failures.
- [x] Safety Record scoring made recency-decayed + exposure-normalized (`scoring.py` `_effective_incident_load`); fixes the saturated curve where 20+ incidents all read ~1/100 and closing a case didn't move the score. Shipped `scripts/audit_incidents.py` + `scripts/cleanup_stale_incidents.py` (dry-run/`--apply`, archive-only) to remediate venues bloated with stale app-generated open incidents. `/risk-score` + `/quote` are now venue-access gated.
- [x] Triage/ingestion demo flow accumulates unbounded open incidents (`inc-` rows). Fixed with a self-healing per-venue open-incident cap (`app/services/incident_maintenance.py` `enforce_open_incident_cap`, wired into `create_brawl_incident_flow` with `protect_ids` so the just-filed incident is never archived) + extracted the cleanup script's core into a tested `archive_stale_incidents`/`find_stale_incidents` service (single source of truth). Tests in `test_incident_maintenance.py`.
- [x] Re-resolve compliance crash: both `POST /venues/{id}/compliance/{item}/upload` and the broker waiver route (`app/api/v1/compliance.py`) now skip the transition when the signal is already `resolved` — idempotent success, never a 500. RED-proven regression tests in `test_compliance_resolve.py` + `test_compliance_evidence.py`.
- [ ] Prod data cleanup (ops, not code): run `DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.audit_incidents --venue elsewhere-brooklyn` against Railway, review the age buckets, then `cleanup_stale_incidents --apply` to drop the ~29 stale open `inc-` rows so the live Safety Record recovers. The recency-decay model already softens it, but the "29 open" display persists until cleaned.

### 3. Deterministic (no-key) agent quality
- [x] Improve the keyword-ladder risk classifier (`app/providers/deterministic.py`) — added a generalizable aggravator/mitigator severity modifier + filled the medical keyword gap. `severity_match` 47%→100%, aggregate 57%→95%, no other scorer regressed. Unit tests in `test_risk_classifier.py` include over-fit guards (novel summaries + plain-incident guards). Baseline + public scoreboard refreshed.
- [ ] Tighten deterministic memo templates so no-key output reads credibly in a demo.
- [ ] Add eval coverage that pins the deterministic-mode quality (ties into track 1).

### 4. Test-coverage expansion
- [ ] Frontend: component/integration tests beyond the `account`/`market` unit tests; broaden the 6 Playwright e2e specs.
- [ ] Enable the skipped `frontend/e2e/settings.spec.ts` once the backend deploy includes the auth endpoints (it's `describe.skip` pending deploy).
- [ ] Mobile: tests beyond `format.ts` helpers (lightweight, given Expo render-test flakiness).

### 5. Data & Defense integration surface — vision-vs-built (added 2026-05-30)

The "Data & Defense" marketing diagram promises: inputs (Cameras, POS, HR, ID Scanner)
→ savings engine → outputs (**Slack/Text, Ticketing, Scheduling, Reporting**). Status of
each output box, verified against code on 2026-05-30:

- **Slack / Text — channels MISSING; the dispatch seam exists.** `AlertEvent` + per-venue
  `PushSubscription` + `app/services/alert_dispatcher.py::dispatch_alert()` already deliver
  alerts via **Web Push** (gated on `VAPID_PRIVATE_KEY`). `app/services/email.py` (Resend) is
  wired for password reset only — not operational alerts. No Slack, Twilio/SMS, or webhook code.
  - [ ] **Slack adapter behind the `dispatch_alert` seam** — Slack *incoming webhooks* need NO
    paid account, so this is subscription-free and demoable. **Highest-leverage first move** (closes
    the most visibly-missing box). ★
  - [ ] Also route operational `AlertEvent`s through `email.py` (reuse the existing provider), not push-only.
  - [ ] 🔒 **SMS (Twilio)** — same seam, but needs a paid account. Gated.
- **Ticketing — PRESENT internally, under other names.** No external ticketing integration, but
  `BrokerTask`, `PolicyRequest`, the `ComplianceSignal` queue, `AlertEvent`, and the `/tasks` page
  already are the actionable-item layer.
  - [ ] (optional) Unify these into one "inbox / tickets" surface so the diagram box maps 1:1.
  - [ ] 🔒 External ticketing (Linear / Zendesk / Jira) — gated, low priority.
- **Scheduling — simulated *input*, not an output.** `StaffingConnector` (`app/ingestion/connectors.py`)
  ingests a simulated "scheduling feed → staffing_ratio" (RNG). Directionality differs from the diagram:
  data flows IN as a risk signal; there is no scheduling write-back.
  - [ ] 🔒 Real scheduling API (7shifts / Deputy) — the cheapest real-connector swap; the slot exists.
- **Reporting — BUILT (strongest box).** Defense-package PDF export (`app/defense_package.py`),
  `UnderwritingPacket` + audit trail, broker portfolio / risk-profile dashboards, `/evals` scoreboard,
  override-calibration stats.
  - [ ] (enhancement) Scheduled / exportable periodic report (e.g. weekly savings-summary PDF or email).

**Inputs (left side)** are simulated connectors (`app/ingestion/connectors.py`): `PosConnector`,
`IdScanConnector`, `StaffingConnector`, + camera via the vision pipeline. No distinct HR-System
connector. Tracked under "Real operational connectors" in `go-live-readiness.md`.

> First move when we start: the **Slack incoming-webhook adapter** on the existing `dispatch_alert`
> seam — subscription-free, demoable, and it's the one output box that's genuinely absent rather than
> just renamed (ticketing) or simulated (scheduling) or already built (reporting).

---

## Gated — needs an account/keys (revisit when available)

See [`go-live-readiness.md`](./go-live-readiness.md) for detail. Summary:
- [x] Object storage (S3/GCS) — `S3Storage` **implemented** (boto3, `STORAGE_BACKEND=s3`), Stubber-tested. Only remaining step is ops: create a bucket (Cloudflare R2 free tier) + set the four `S3_*` env vars on Railway. Was the biggest real blocker (Railway FS is ephemeral → evidence/PDFs vanish on redeploy).
- [ ] 🔒 Email provider (Resend) — set `RESEND_API_KEY` + `FRONTEND_URL`, verify domain → reset emails actually send.
- [ ] 🔒 LLM live mode — set `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` (+ budget) to swap deterministic stubs for real agents.
- [ ] 🔒 A real operational connector (e.g. scheduling/POS) — the `staffing` slot is the cheapest real-API swap.
- [ ] SMS (Twilio), payments (Stripe), loss-run ingestion — only if v1 scope expands.

---

## Recommended order

Quick confidence-builder: **track 2 (correctness)** → headline work: **track 1 (evals)**. Tracks 3–4 are good filler. All four are independent; none need a subscription.
