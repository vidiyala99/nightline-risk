# Defense Package — Exportable, Evidence-Authenticated A&B Defense Artifact (design)

**Date:** 2026-05-24
**Status:** Design approved in conversation; pending written-spec review → plan.

## Context

Validated (industry research + Third Space's own a16z framing): the nightlife insurance cost crisis is **lawsuit-driven** — liquor-liability / assault-&-battery claims amplified by social inflation / nuclear verdicts. The lever isn't *quantifying* the pain (operators know they overpay); it's **reducing lawsuit cost by making incidents defensible.** The repo already turns incidents → packets with citations, a corroboration verdict, `snapshot_hash` tamper-evidence, and an `AuditEvent` trail. A gap analysis found three Tier-1 holes that stop that packet from being *usable* in an actual defense:

1. **No exportable artifact** — packets are JSON-in-app only; an adjuster/attorney can't use them.
2. **Evidence isn't authenticatable** — `EvidenceFile` stores path + uploader + upload-time, **no content hash, no capture time**.
3. **Thin A&B intake** — `IncidentCreate` is a free-text summary + 3 booleans; the facts that decide A&B liability (parties, witnesses, security response, over-service) aren't captured.

This build closes all three. It pulls forward the "defense package + reportlab PDF" item already named in the broker-platform Phase 5 roadmap.

## Scope (three parts) + deferred

**Part A — Defense Package PDF export.** Render a packet → a defense-grade PDF.
**Part B — Evidence authentication.** `content_hash` + `captured_at` on `EvidenceFile`, computed at upload, surfaced in the PDF.
**Part C — A&B structured intake.** Extend incident intake with the structured A&B facts, surfaced through the flow → packet → PDF.

**Deferred (explicit):** preserving alert-trigger camera frames from the RTSP sampler (biggest infra change — separate slice); e-signature / notarization. Noted as the next gap.

---

## Part A — Defense Package PDF

- **New module `backend/app/defense_package.py`** — `render_defense_pdf(session, packet_id) -> bytes`. Pure-ish: loads the `UnderwritingPacket`, its `CitationRecord`s/`SourceRecord`s, the `IncidentRecord`, `EvidenceFile`/`EvidenceAnalysis` rows, and the `AuditEvent` trail for the packet; lays them out with **reportlab** (new dependency in `backend/requirements.txt`).
- **Sections** (all from existing data):
  1. **Cover** — venue, incident id, claim ref (if the packet is attached to a `Claim`), `generated_at`, the packet `snapshot_hash` + a "tamper-evident: verify the packet body against this SHA-256" statement.
  2. **Incident facts** — from `IncidentRecord` (+ Part C structured fields).
  3. **Claims timeline** — `claims_timeline` events (at / label / source) + response actions.
  4. **Corroboration verdict** — CONSISTENT / PARTIAL / CONTRADICTED / INCONCLUSIVE + flags (from the corroboration result; see Part C note on persisting it structurally).
  5. **Evidence inventory** — each `EvidenceFile`: filename, type, `captured_at`, `content_hash`, and its `EvidenceAnalysis` finding.
  6. **Citations / sources** — every `CitationRecord` excerpt + `SourceRecord` provenance + `content_hash`.
  7. **Audit trail** — `AuditEvent`s for the packet (actor / event / timestamp) as the chain-of-custody log.
- **Endpoint:** `GET /api/packets/{packet_id}/defense-package.pdf` in `backend/app/api/v1/packets.py` → `Response(content=pdf_bytes, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="defense-{packet_id}.pdf"'})`. Broker/admin gated (mirrors the other packet routes); 404 if packet missing.
- **Frontend:** a "Download defense package (PDF)" link on the packet/claim detail view (the claim that carries `defense_package_id`). Small.

## Part B — Evidence authentication

- **`EvidenceFile` gains** `content_hash: Optional[str]` (SHA-256 of the file bytes) and `captured_at: Optional[str]` (client-supplied capture time if provided at upload, else falls back to `uploaded_at`).
- **Computed at upload** in the evidence upload handler (`backend/app/api/v1/evidence.py`): hash the bytes as they're written; read `captured_at` from the multipart form / EXIF-if-present (EXIF optional — fallback to upload time is acceptable and documented).
- **Schema change:** add the two model fields **and** two `_COLUMN_MIGRATIONS` rows in `backend/app/database.py`: `("evidencefile","content_hash","TEXT","")`, `("evidencefile","captured_at","TEXT","")`. (Idempotent ALTER, the repo's established pattern.)
- Surface both in the evidence API response and the PDF evidence inventory.

## Part C — A&B structured intake

- **Extend `IncidentCreate` (schemas/domain.py) + `IncidentRecord` (models.py)** with **all-optional, defaulted** structured fields so existing intake/tests stay green:
  - `incident_category: Optional[str]` (e.g. "assault_battery" | "liquor" | "crowd" | "medical" | "property" — free/Literal, default None)
  - `parties: list` (JSON; each `{role: "involved"|"aggressor"|"injured"|"staff", description}`)
  - `witnesses: list` (JSON; `{name_or_role, statement}`)
  - `security_response: list` (JSON; `{action, at}` — timestamped, e.g. "ejected at 23:14", "EMS called 23:18")
  - `weapon_involved: Optional[bool]`
  - `refused_service_or_overserved: Optional[str]` (dram-shop note)
  - `injury_detail: Optional[str]` (beyond the existing `injury_observed` bool)
- **Migration:** model fields + matching `_COLUMN_MIGRATIONS` rows (TEXT for JSON-encoded lists / nullable scalars).
- **Backward compatibility is a hard requirement:** every new field optional with a safe default; the existing `create_brawl_incident_flow` and the ~600 existing tests must pass unchanged. New fields flow into the packet body (so they're in `snapshot_hash`) and render in the PDF's incident-facts + response-timeline sections.
- **Persist the corroboration verdict structurally** (small fix supporting Part A §4): store the aggregated corroboration `status` + `flags` on the packet (a field on `UnderwritingPacket`, migrated) rather than only as prose in `memo.summary`, so the PDF and future queries can read it cleanly.

---

## Conventions reused
- Audit every new state-affecting action via `app.packet_core._add_audit_event` (e.g. `packet.defense_pdf_exported`).
- New incident/evidence fields are part of the packet body → covered by `snapshot_hash`; no change to hashing logic.
- `reportlab` added to `backend/requirements.txt`.

## Data flow
```
Incident intake (now w/ A&B structured fields) → agent pipeline → packet
   (+ corroboration verdict persisted structurally)
Evidence uploaded → content_hash + captured_at stored
Claim attaches packet via defense_package_id (existing)
GET /api/packets/{id}/defense-package.pdf → render_defense_pdf() → PDF bytes
   (cover+hash, incident facts, timeline, corroboration, evidence inventory w/ hashes,
    citations/sources, audit trail)  → downloadable from claim/packet UI
```

## Error handling
- Missing packet → 404. Missing optional sections (no evidence, no claim link) → render gracefully ("none recorded"). PDF generation failure → 500 with structured error; never emit a partial/corrupt file.
- New incident fields tolerate absence (old incidents render without the A&B section).

## Testing
- `test_defense_package.py`: `render_defense_pdf` returns non-empty `application/pdf` bytes (starts with `%PDF`), contains the snapshot hash + key section headers (render to text and assert), handles a packet with no evidence and no claim link.
- Evidence: upload → `content_hash` is the SHA-256 of the bytes; `captured_at` falls back to upload time when not supplied.
- A&B intake: an incident created with the new fields round-trips into the packet body + hash; an incident created the **old** way (no new fields) still works (backward-compat test).
- Endpoint test: `GET …/defense-package.pdf` returns 200 + `application/pdf` for a broker; gated for operators per the route's convention.
- **Full backend suite stays green** (currently 597) + new tests.

## Out of scope (next slices)
- Preserving alert-trigger camera frames (RTSP sampler change) — the remaining half of evidence gap #2.
- Cryptographic e-signature / third-party notarization of the PDF.
- Auto-assembling operational corroboration (POS/door/staffing) into the timeline (Tier-2 gap #5).
