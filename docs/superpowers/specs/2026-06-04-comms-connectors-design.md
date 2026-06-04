# Communication & Workflow Connectors — eval-gated classify-and-route ingestion

**Date:** 2026-06-04
**Status:** Design approved; ready for implementation plan
**Related:** [`2026-05-07-architecture-v2.md`](2026-05-07-architecture-v2.md) (evidence layer), the ingestion spine (`app/ingestion/`), the real-time push lane (`app/api/v1/ingestion.py` + `app/ingestion/webhook.py`), the eval/calibration harness (`app/evals/`).

## 1. Context & motivation

Third Space's "Digital Integration" pillar pulls operational data (cameras, POS, HRIS, scheduling, ID scans) into underwriting. Nightline already has the ingestion spine for *operational telemetry* (`PosConnector`/`IdScanConnector`/`StaffingConnector` + quality gate + content-hash dedupe + `IngestionRun` audit + rollup-into-score) and a real-time push lane.

This feature extends connectors to the **human/communication channels venues actually run on** — Slack, support/maintenance tickets, and inbound texts — and turns their messy free-text into the right structured record in Nightline's evidence layer. The defensible part is **not** the pipe; it's that classification is an **eval-gated agent**: a message only auto-creates a record when calibrated confidence clears a per-kind threshold, otherwise it goes to human review. This is the homepage "eval-gated, not vibes" stance applied to ingestion.

## 2. Goals / Non-goals

**Goals (v1):**
- Ingest items from 3 source types (Slack, tickets, SMS) behind a single MCP-client seam, sharing one pipeline.
- Classify each item as `incident | compliance | noise` and extract supporting fields.
- Eval-gate the classifier (rubric-scored, per-kind calibration threshold) so auto-create is precision-bounded; everything else routes to a review queue.
- Route auto-created items into the existing evidence layer (`IncidentRecord`) or the operator compliance queue.
- Web review queue for operator/broker to confirm/correct/dismiss low-confidence items; corrections are stored as labels.
- Reuse the ingestion spine for dedupe, retry, and the `/ingestion` runs view.

**Non-goals (explicit deferrals):**
- **Real MCP source wiring** (live Slack/Zendesk/Twilio OAuth). v1 ships **simulated** sources behind the seam; the real MCP server drops in with no connector changes.
- **Mobile review queue** — fast-follow after web.
- **Auto-retraining** the rubric from review corrections. v1 *captures* corrected labels; using them to regenerate the rubric is later.
- Operational-metric output from comms (rejected during design — comms map to incident/compliance, not a numeric rate).

## 3. Architecture & data flow

```
MCP source (Slack / tickets / SMS)  →  CommsSource adapter (MCP-client seam)
  → CommsConnector (extends ingestion-spine Connector)
      extract()   : pull items since watermark (via the source)
      transform() : classifier agent → CommsClassification
      eval-gate   : calibrated confidence ≥ per-kind threshold?
      load()      : route →  incident   → IncidentRecord (→ packet/claim pipeline)
                             compliance → compliance follow-up (operator queue)
                             noise      → drop (counted)
                             below threshold / ambiguous / classifier error → CommsReviewItem
  → run_connector: content-hash dedupe + IngestionRun audit (reused)
```

The connector overrides `load()` to route to evidence-layer records instead of `VenueOperationalEvent` metrics — the same escape hatch `NycOpenDataConnector` uses to upsert `Venue` rows. Everything else (`extract`→`transform`→watermark→dedupe→run-log, with retry/backoff) comes from `run_connector`.

## 4. Components

All new code under `app/ingestion/comms/` unless noted. Each unit is independently testable.

| Unit | Responsibility | Key interface |
|---|---|---|
| `types.py` | Shared dataclasses | `CommsItem(source, venue_id, external_id, author, text, occurred_at, metadata)`; `CommsClassification(kind: Literal["incident","compliance","noise"], confidence: float, fields: dict, rationale: str, model_version: str)` |
| `sources.py` | Pull raw items per source, behind the MCP seam | `class CommsSource(ABC): def list_items(self, *, since: datetime \| None) -> list[CommsItem]`; concrete `SlackSource`/`TicketSource`/`TextSource` (v1 simulated, deterministic-per-window like `PosConnector`) |
| `classifier.py` | AI classify one item | `classify_comms_item(item: CommsItem, *, provider) -> CommsClassification` — uses the existing provider abstraction (deterministic in tests, LLM in prod) |
| `connector.py` | Tie source + classifier + router into a spine `Connector` | `class CommsConnector(Connector)`: `extract` via source, `transform` via classifier, `load` via router |
| `router.py` | Turn a classification into a record | `route(session, item, classification, *, gate, venues_index) -> RouteResult` (creates `IncidentRecord` / compliance follow-up / `CommsReviewItem`; returns what it did) |
| `app/evals/comms_classifier_eval.py` | Rubric + scorer + threshold | labeled fixtures (text → expected kind/fields); precision/recall per kind + calibration; exposes per-kind `auto_create_threshold` |
| `app/api/v1/comms.py` | HTTP surface | run trigger + review queue + resolve (see §6) |
| `frontend/src/app/comms-review/` | Web review queue | page + layout (operator/broker) |

## 5. Eval-gating & calibration

- The classifier is scored against `comms_classifier_eval` fixtures (representative messages → expected kind + fields), producing precision/recall per kind and a confidence-calibration curve, via the existing eval harness.
- Each kind has an `auto_create_threshold` chosen so auto-creates meet a target precision (default **≥ 0.90**). At load time: `kind != "noise"` **and** `confidence ≥ threshold[kind]` → auto-create the record; otherwise → `CommsReviewItem`. `noise` above threshold is dropped (counted); `noise` below threshold goes to review (so we don't silently discard a possible incident).
- A review resolution records the human's chosen kind as a new labeled example (`CommsReviewItem.resolved_kind`), so the rubric set grows. (Regenerating the rubric from these is deferred.)

## 6. Persistence & API

**Model** (`app/models.py`), new table `CommsReviewItem`:
`id` (pk), `venue_id` (fk venue.id, index), `source` (str), `external_id` (str), `raw_text` (str), `author` (str | None), `occurred_at` (datetime, `now_utc`), `proposed_kind` (str), `confidence` (float), `rationale` (str | None), `fields` (`Column(JSON)`), `status` (str: `pending|confirmed|corrected|dismissed`, default `pending`), `resolved_by` (str | None), `resolved_kind` (str | None), `created_at` (datetime, `now_utc`).
No `_COLUMN_MIGRATIONS` line is needed (fresh table created by `create_all`); the `fields` `Column(JSON)` is read through a coercion helper (`_as_dict`) per the Neon JSON-string lesson.

**Endpoints** (`app/api/v1/comms.py`, mounted `/api`):
- `POST /api/comms/ingest` — broker/admin only. Body `{source: "slack"|"tickets"|"sms"|"all"}`. Runs the connector(s) via the runner; returns `IngestionRun` summary (extracted/loaded/auto_created/review/noise/skipped).
- `GET /api/comms/review` — broker (all) / operator (own venue). Returns pending `CommsReviewItem`s with raw text, proposed kind, confidence, rationale.
- `POST /api/comms/review/{id}/resolve` — same gate. Body `{decision: "confirm"|"correct"|"dismiss", kind?: "incident"|"compliance"|"noise"}`. `confirm` uses `proposed_kind`; `correct` uses the supplied `kind`. On a non-noise resolution, creates the final `IncidentRecord`/compliance follow-up, sets `status`/`resolved_kind`/`resolved_by`, and emits an audit event.

Error mapping follows the existing convention (typed `CommsError` → 400; gate failures → 401/403).

## 7. Dedupe, idempotency, audit

- `content_hash` over `(source, external_id)` (a normalized identity), reusing the spine's content-hash dedupe so re-ingesting the same Slack message/ticket never double-creates.
- Each run logs an `IngestionRun` with `source_system` in `{slack, tickets, sms_comms}` and counts (extracted / auto-created / sent-to-review / noise / skipped-dupe), surfaced in the existing `/ingestion` runs view.
- Review resolutions emit an audit event (`comms_review.<decision>`).

## 8. MCP seam

`CommsSource.list_items(since)` is the seam. v1 concrete sources are simulated (network-free, deterministic per window — mirrors `PosConnector`). The real implementation is a thin **MCP client** (Nightline as MCP *client*) calling a source MCP server's list tool; swapping sim→real changes only the `CommsSource` subclass, never the connector/router/classifier. Real-source config is env-gated and documented in `backend/.env.example` (mirrors the `STORAGE_BACKEND` / `RESEND_API_KEY` pattern); absent config → simulated source.

## 9. Error handling

- Source pull failure → retry with exponential backoff (`_extract_with_retries`), run recorded `status=error`.
- Classifier failure (LLM/provider error) → the item is sent to the **review queue**, never silently dropped (fail-safe-to-human).
- Routing failure → logged; the item stays `pending` for retry. No partial commits (the connector load is one transaction per run, owned by the runner/API layer).

## 10. Web review queue (v1 surface)

Route `/comms-review` (operator + broker; venue-scoped for operators). Renders pending items as cards: source badge, raw message, proposed route + confidence chip (lime fill, ink text per the design system), rationale, and actions **Confirm · Correct (pick incident/compliance/noise) · Dismiss**. Resolving removes it from the queue and (for non-noise) links to the created incident/compliance item. Empty state when the queue is clear.

## 11. Testing

Deterministic provider + fixtures:
- incident-text → `IncidentRecord` created and flows to a packet; compliance-text → compliance follow-up; noise (high-conf) → dropped + counted.
- low-confidence (any kind) and classifier-error → `CommsReviewItem` created (not auto-created).
- re-running the same item → no duplicate (content-hash).
- `comms_classifier_eval` scorer meets the configured precision threshold on the fixture set.
- `POST /comms/review/{id}/resolve` with `confirm` and `correct` creates the right final record, sets status/resolved_kind, and stores the label; `dismiss` creates nothing.
- Auth gates: operator sees only own-venue review items; anonymous 401; cross-venue operator 403.

## 12. Conventions

Timestamps `now_utc`; new table via `create_all` (no migration line needed) but any future column needs a `_COLUMN_MIGRATIONS` entry; `fields` JSON read via `_as_dict`; state changes emit `_add_audit_event`; services don't commit (API/runner owns the transaction); typed `CommsError` mapped in the router.

## 13. Phasing

- **v1 (this spec):** backend pipeline (3 simulated sources behind the MCP seam) + eval-gated classifier + `CommsReviewItem` + review API + web review queue + tests.
- **Fast-follows:** mobile review queue (parity); one real MCP source wired end-to-end; rubric auto-grow from captured labels.

## 14. Success criteria

- A simulated batch across all three sources produces: incidents + compliance items auto-created above threshold, low-confidence items in the review queue, noise counted-and-dropped — all visible in an `IngestionRun` and idempotent on re-run.
- The eval scorer reports per-kind precision/recall on the fixture set and enforces the auto-create threshold.
- An operator/broker can clear the review queue on web, and a corrected item creates the right record and stores its label.
- Full backend suite green; web build green.
