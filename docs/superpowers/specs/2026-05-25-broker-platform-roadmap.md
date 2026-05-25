# Broker-platform roadmap — benchmarked, ranked by architectural coherence

**Date:** 2026-05-25
**Status:** Reference / planning doc (no commitment to build order beyond Tier 1 sequencing)

## Context

Nightline Risk is a **vertical placement-and-claims platform** for nightlife/venue insurance — not a generic agency management system (AMS). Judge it against that thesis, not against Applied Epic / AMS360.

Already built and deep:

- **Placement funnel:** submission → submit-to-market → multi-carrier quote comparison → select → bind → policy (`app/services/submissions.py`, `app/api/v1/placement.py`, indicative rating via `POST /quotes/{qid}/build-indicative`, carrier appetite + structured `out_of_appetite` handling).
- **Policy lifecycle:** endorsements, certificates (COIs), cancellation with pro-rata/short-rate refunds, **experience-rated renewals** (`app/services/policies.py`, `app/services/renewals.py`, `app/api/v1/{policies,renewals}.py`).
- **Claims:** FNOL → reserve history → indemnity/expense/recovery payments → close/reopen → defense-package PDF (`app/api/v1/claims.py`, `app/defense_package.py`).
- **Differentiator:** incident / evidence / risk-scoring layer (vertical-specific IP).
- **Regulatory-grade hygiene:** lifecycle state machines (`app/lifecycles.py`), snapshot hashing, audit events on every transition (`packet_core._add_audit_event`), Decimal money discipline, role/tenant gating. ACORD 125/126 previews exist.

This doc benchmarks against AMS incumbents (Applied Epic, Vertafore AMS360, EZLynx) and insurtech brokers (Newfront, Founder Shield, Broker Buddha), then ranks additions by **architectural coherence** — how cleanly each extends a pattern already in the codebase, so additions read as consistent design rather than feature sprawl.

## Benchmark — what a "complete" broker platform spans

Three buckets. We are deep in **A** and the claims half of **C**; thin/absent in **B** and the self-service half of **C** (much of B is deliberately outside the vertical thesis).

- **A — Placement & lifecycle (the deal):** submission, marketing to carriers, comparative rating across many carriers, app generation, e-sign, bind, issuance, endorsements, COIs, cancellation, renewals. *(We have most of this.)*
- **B — Agency operations:** CRM/pipeline, producer book management, **accounting** (trust, agency-bill vs direct-bill, commission reconciliation, invoicing, premium finance), **reporting** (production / retention / loss-ratio / aged receivables), **tasks / diary / suspense**, document management + e-sign, **carrier integrations** (IVANS download, real-time rates from 300+ carriers per EZLynx). *(Largely absent.)*
- **C — Client servicing:** insured **self-service portal**, instant **COI request/share**, **self-service renewal** (Founder Shield reports renewal time "reduced to zero — a few clicks"), paperless onboarding, payments, push notifications, claims FNOL & tracking. *(We have claims; self-service is the seam.)*

## Roadmap, ranked by architectural coherence

Each item: **benchmark answered** · **existing pattern it extends** (file) · **shape** · **effort**.

### Tier 1 — Direct extensions of an existing pattern (build first)

**1. Operator→broker service-request object** (renewal / cancellation / COI / coverage-change requests) · effort **M**
- Benchmark: insurtech self-service (Founder Shield, Broker Buddha) — insureds initiate renewals/COIs online.
- Extends the **`ClaimProposal` propose→decide pattern almost exactly**: `app/claim_proposals.py` + `POST /claim-proposals/{proposal_id}/broker-decision` (`app/api/v1/claim_proposals.py:103`). Reuse `app/lifecycles.py` (`TRANSITIONS`, `assert_valid_transition`, `_transition_*`) and `packet_core._add_audit_event`.
- Shape: new `PolicyRequest` entity (`type`, `policy_id`, `requested_by`, `status`, `payload`, decision fields); operator-gated create + broker-gated decide; lands in a broker queue. Closes the "how does an operator cancel/renew?" gap and makes the operator↔broker loop symmetric (claims *and* policy servicing both flow through propose→decide).

**2. Real COI PDF generation** · effort **S–M**
- Benchmark: every platform issues certificates; insurtechs share them instantly.
- Extends the **reportlab renderer already built for defense packages**: `build_defense_sections` (`app/defense_package.py:35`) + `render_defense_pdf` (`:160`). The `CertificateOfInsurance` model + `pdf_path` field exist (`app/models.py:492`, `:510`). `GET /certificates/{coi_id}/pdf` is currently an explicit **stub** returning a JSON envelope with `pdf_pending` (`app/api/v1/policies.py:361`, docstring: "Actual PDF rendering ships in Phase 5").
- Shape: a `render_coi_pdf(...)` sections-builder mirroring the defense renderer; flip the stub to stream a real PDF using the same `Response(media_type="application/pdf")` pattern as `app/api/v1/packets.py:102`.

**3. Renewal reminders / task-diary (push, not pull)** · effort **M**
- Benchmark: AMS suspense/diary; automated 90/60/30-day renewal workflows.
- Extends `GET /renewals/due` (`app/api/v1/renewals.py`), currently pull-only, plus the audit-event emission shape for due-date triggers.
- Shape: lightweight `BrokerTask` entity (`due_date`, `kind`, `ref_id`, `status`) seeded from expiring policies + open requests (#1); a broker "to-do" read endpoint. Foundation for later notifications.

### Tier 2 — Extends read/render patterns, more new surface

**4. Reporting & analytics** (book of business, retention/hit-ratio, loss-ratio, production by producer) · effort **M**
- Benchmark: AMS360's reporting strength.
- Extends existing aggregate reads `GET /portfolio` and `/override-stats` (`app/api/v1/venues.py`) and `compute_loss_experience` (`app/services/renewals.py:38`). Read-only aggregation endpoints + dashboard cards; no new write-path risk.

**5. Document delivery + e-signature hooks** · effort **M–L**
- Benchmark: app-generation → e-sign → welcome-packet pipeline.
- Extends the `policy_docs` route group + the reportlab renderer (#2). Add a per-policy documents index and a pluggable e-sign hook (stub provider first).

### Tier 3 — Net-new architecture (deliberate scope boundaries, not a backlog)

These do **not** extend current patterns and largely sit outside the vertical thesis. State them explicitly as "intentionally out of scope" in the pitch.

**6. Accounting / billing / commission ledger** — commission *fields* exist on `Policy` (`commission_amount`, `commission_rate`, `commission_paid_at`, `app/models.py:446`) but there is no ledger, statements, trust accounting, agency-bill vs direct-bill, or premium finance. The single biggest real-world gap; a net-new subsystem.
**7. Real carrier integrations (IVANS / API download / live rating)** — quotes come from the indicative engine, not real carriers. Net-new integration layer.
**8. CRM / pipeline / accounts-contacts hierarchy** — no client object above the venue, no opportunity pipeline.
**9. Full insured self-service portal** — Tier-1 #1 is the seed; payments, doc access, onboarding are a larger surface.

## Recommended sequence

Build Tier 1 in order (1 → 2 → 3): each is a near-mechanical extension of an existing pattern and each closes a gap already identified. Treat Tier 3 as explicit scope boundaries to cite ("intentionally out of scope: accounting, carrier EDI, CRM"), not work to grind through.

## Sources

- ASNOA, *The Independent Agent's Toolkit* (2025) — https://asnoa.com/2025/the-independent-agents-toolkit-must-have-platforms-for-modern-insurance-agencies/
- SelectHub, *EZLynx vs AMS360* — https://www.selecthub.com/insurance-agency-management-systems/ezlynx-vs-ams360/
- QuoteSweep, *AMS Comparison 2026* — https://www.quotesweep.com/blog/ams-comparison-2026
- US Tech Automations, *Quote-to-Bind Pipeline 2026* — https://ustechautomations.com/resources/blog/automate-insurance-quote-to-bind-policy-pipeline-2026
- Founder Shield — https://foundershield.com/
- Newfront — https://www.newfront.com/
- Broker Buddha, *Friction-free renewals* — https://www.brokerbuddha.com/simplicity/taking-the-friction-out-of-insurance-policy-renewals
