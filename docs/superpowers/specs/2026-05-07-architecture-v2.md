# Third Space Risk Engine: Architecture v2

**Date:** 2026-05-07
**Last Updated:** 2026-05-07 (afternoon session)
**Version:** v2.2
**Status:** Current system + near-term roadmap
**Audience:** Engineering, interview review

> **Live demo:** https://frontend-mu-ebon-n3x8uw2rpx.vercel.app  
> Broker login: `broker@thirdspace.risk` / `demo123` — Venue operator: `venue@elsewhere.com` / `demo123`

---

## 1. What This System Does

Third Space is an AI-powered insurance broker for nightlife venues. The Risk Engine turns venue operational data — incident reports, photos, video footage, POS logs, staffing records — into cited underwriting packets that help underwriters make faster, evidence-backed decisions.

The core loop:

1. A venue operator reports an incident (text + optional media)
2. Agents analyze the incident and produce a risk packet instantly
3. If media was uploaded, a vision pipeline processes it in the background and updates the packet
4. An underwriter reviews the packet, sees the AI analysis + evidence, and makes a decision
5. Every decision is auditable and traceable back to source evidence

---

## 2. Current System (as of 2026-05-07)

### 2.1 Stack

| Layer | Technology |
|-------|-----------|
| Backend | FastAPI + SQLModel + SQLite |
| Frontend | Next.js 16.2 (App Router), DM Sans + Cormorant Garamond + JetBrains Mono |
| Mobile | React Native (Expo managed), expo-secure-store, React Navigation bottom tabs |
| Auth | Custom HMAC-signed JWT (role-aware: broker, venue_operator, admin) |
| File storage | Local disk (`evidence_uploads/`) |
| Agent runtime | Deterministic Python stubs (LLM-ready interfaces) |
| Deployment | Vercel (frontend) + Railway (backend) |

### 2.2 Data Models

```
Venue
  └── IncidentRecord
        ├── IncidentEvaluation       (agent output, legacy)
        ├── EvidenceFile             (uploaded photos/video/docs)
        │     └── EvidenceAnalysis   (vision agent output per file)
        ├── UnderwritingPacket       (versioned risk packet)
        │     ├── CitationRecord     (source → claim links)
        │     ├── ReviewDecision     (underwriter decision)
        │     └── AuditEvent        (immutable event log)
        └── SourceRecord             (normalized evidence registry)
              └── venue_id="*"       (shared policy sources, all venues)

RubricVersion                        (versioned scoring rules)
```

### 2.3 API Surface

| Resource | Endpoints |
|----------|-----------|
| Venues | GET/POST /api/venues, GET /api/venues/{id}, GET /api/portfolio |
| Incidents | GET/POST /api/venues/{id}/incidents, GET /api/incidents, GET /api/incidents/{id}, PATCH /api/incidents/{id}/status |
| Evidence | POST/GET /api/incidents/{id}/evidence, GET /api/evidence/{id}/file, GET /api/incidents/{id}/evidence-analysis |
| Packets | GET /api/packets, GET /api/packets/{id}, GET /api/incidents/{id}/packets |
| Review | POST /api/packets/{id}/review-decisions, GET /api/packets/{id}/audit-events |
| Live state | GET /api/venues/{id}/live, GET /api/venues/{id}/risk-score, GET /api/venues/{id}/quote |

### 2.4 Agent Pipeline (current)

All agents run synchronously on incident submission. They are deterministic stubs with LLM-ready interfaces — swapping in real model calls requires no architectural change.

```
IncidentCreate
      │
      ▼
RetrievalAgent          ← queries knowledge base (policy docs, staffing, stream events)
      │
      ▼
RiskEvaluatorAgent      ← maps incident facts + citations → severity, confidence, type
      │                   (varies by injury_observed, police_called, ems_called, keywords)
      ▼
CustomerActionAgent     ← produces evidence preservation tasks for venue operator
      │
      ▼
ClaimsTimelineAgent     ← reconstructs chronology from stream events + incident
      │
      ▼
UnderwriterMemoAgent    ← drafts human-readable memo with open questions
      │
      ▼
PacketSnapshot          ← immutable snapshot with hash, citations, rubric version
```

### 2.5 User Roles

| Role | Portal Access |
|------|--------------|
| Venue Operator | Live Terminal, Incidents, Compliance |
| Broker / Third Space | Portfolio, Reports queue, Venues, Incidents |

In v1 the broker role doubles as underwriter — the same login accesses both the portfolio view and the reports queue. A dedicated underwriter role with narrower permissions is a Phase 3 item.

---

## 3. Two-Phase Packet with Vision Pipeline (Shipped)

### 3.1 Overview

When a venue operator submits an incident with photos or video, the system:
- Generates a text-based packet instantly (Phase 1) ✓
- Stores the uploaded files on disk ✓
- Processes images/video asynchronously via vision agents (Phase 2) ✓
- Updates the packet with visual findings and corroboration status ✓

The vision content corroborates or contradicts the written report and gives underwriters concrete evidence to act on.

### 3.2 Two-Phase Architecture

```
Incident Submitted (text + files)
         │
         ├──────────────────────────────────┐
         │                                  │
         ▼                                  ▼
  Phase 1 (synchronous)            Phase 2 (async queue)
  ─────────────────────            ──────────────────────
  Text agents run immediately      Files queued for processing
  Packet created: status=          │
  "needs_review"                   ├── VisionAgent (images)
  Underwriter sees it              │     └── Claude Vision / stub
  immediately                      │         → injury indicators
                                   │         → crowd density
                                   │         → altercation markers
                                   │         → timestamp corroboration
                                   │         → operator description match
                                   │
                                   ├── VideoAgent (video files)
                                   │     └── keyframe extraction (ffmpeg)
                                   │         → analyze frames at 5s intervals
                                   │         → reconstruct visual timeline
                                   │
                                   └── AudioAgent (video audio track)
                                         └── Whisper transcription
                                             → what was said during incident
                                             → timeline of audio events

         After all files processed:
         ─────────────────────────
         CorroborationAgent runs
           → compares visual findings vs written report
           → flags discrepancies (CONSISTENT / PARTIAL / CONTRADICTED)
           → boosts or reduces confidence score

         Packet regenerated (v2):
           → new confidence score
           → visual citations added
           → status updated
           → underwriter notified
```

### 3.3 VisionAgent Output Contract

```json
{
  "file_id": "ev-abc123",
  "analysis_type": "image",
  "findings": {
    "incident_indicators": ["physical altercation", "injury visible"],
    "injury_detail": "Laceration visible on right side of face, patron 1",
    "crowd_density": "moderate",
    "security_present": true,
    "security_response_seconds": 8,
    "environmental_hazards": [],
    "timestamp_in_exif": "2026-05-02T23:14:32",
    "timestamp_matches_report": true
  },
  "corroboration": "CONSISTENT",
  "confidence_delta": +0.06,
  "raw_description": "Two individuals in physical contact near bar counter. Security staff visible in frame background. One patron has visible facial injury."
}
```

### 3.4 Corroboration States

| State | Meaning | Effect on packet |
|-------|---------|-----------------|
| `CONSISTENT` | Visual evidence matches written report | Confidence increases |
| `PARTIAL` | Some elements match, some missing | No change |
| `CONTRADICTED` | Visual evidence conflicts with report | Confidence decreases, flags for review |
| `INCONCLUSIVE` | Cannot determine from footage | Noted, no scoring effect |

### 3.5 Processing Queue

For v1, the queue is an in-process `asyncio` task — no Redis, no Celery. Simple and zero-dependency.

```python
# On evidence upload:
background_tasks.add_task(process_evidence_async, evidence_id, incident_id)

# Worker:
async def process_evidence_async(evidence_id, incident_id):
    result = await vision_agent.analyze(evidence_id)
    store_analysis(result)
    if all_files_processed(incident_id):
        regenerate_packet(incident_id)  # Phase 2 packet update
```

When a real provider key is available, `vision_agent.analyze()` calls Claude Vision. Until then, the stub returns realistic structured output based on the incident type.

---

## 4. Data Flow: Full Incident Lifecycle

```
1. Operator submits incident form
   → POST /api/venues/{id}/incidents
   → Phase 1 agents run (synchronous, ~200ms)
   → Packet created, status: needs_review
   → Evidence files queued for async processing

2. Underwriter opens Reports queue
   → GET /api/packets?limit=50
   → Sees packet with Phase 1 analysis
   → Status: "Needs Review"

3. Vision pipeline completes (background, seconds to minutes)
   → VisionAgent analyzes each image/video keyframe
   → CorroborationAgent compares vs written report
   → Packet regenerated with visual citations
   → Confidence score updated

4. Underwriter reviews updated packet
   → Sees: risk signal, memo, citations, visual findings, corroboration status
   → Makes decision: Approve / Block / Request More Info
   → POST /api/packets/{id}/review-decisions

5. Audit trail captures everything
   → packet.generated, packet.opened, packet.evidence_analyzed, decision.recorded
```

---

## 5. Evidence Handling

### 5.1 Current
- Files stored on local disk under `evidence_uploads/`
- Metadata in `EvidenceFile` DB table
- Served via `GET /api/evidence/{id}/file`

### 5.2 Production Path
- Move to object storage (S3/GCS) — same DB contract, swap storage backend
- Signed URLs for time-limited access
- Retention policy per source type (claims defense evidence: 7 years)
- Content hash stored for tamper detection

---

## 6. LLM Integration Points

The system is built to be LLM-ready without requiring LLM calls to function. Each agent interface accepts the same inputs and returns the same output schema whether the implementation is a stub or a real model call.

| Agent | Stub (current) | LLM version |
|-------|---------------|-------------|
| RiskEvaluatorAgent | Keyword + flag heuristics, severity varies by incident type + flags | Claude claude-sonnet-4-6 with policy context |
| UnderwriterMemoAgent | Risk-type-specific analytical templates with open questions | Claude claude-sonnet-4-6 drafting from citations |
| VisionAgent | Realistic stub — varies confidence delta by injury/police/EMS flags | Claude Vision API |
| VideoAgent | Stub keyframe analysis with timeline reconstruction | ffmpeg → Claude Vision per frame |
| AudioAgent | Not implemented | Whisper transcription → text agent |
| CorroborationAgent | Deterministic — compares vision findings vs incident flags, returns CONSISTENT/PARTIAL/CONTRADICTED | Full LLM semantic comparison |

Provider switching requires changing one function per agent, not the architecture.

---

## 7. What's Not In Scope (v1)

- Real-time camera feed processing
- POS system connectors
- Autonomous underwriting decisions
- Actuarial scoring
- Multi-tenant data isolation (single-tenant demo today)
- Kafka / Redis / Temporal / Kubernetes

---

## 8. Phased Roadmap

### Phase 1 (current) — Demo-grade, production-shaped
- ✅ Incident reporting with evidence upload (files + footage links)
- ✅ Two-role portal (operator + broker/underwriter)
- ✅ Agent pipeline with deterministic stubs
- ✅ Reports queue with review decisions
- ✅ Audit trail and packet versioning
- ✅ Vision pipeline — two-phase packet (text instant, vision async)
- ✅ Corroboration agent — CONSISTENT / PARTIAL / CONTRADICTED
- ✅ Shared knowledge sources (venue_id="*") for cross-venue citations
- ✅ Venue creation API with full onboarding form
- ✅ Risk-type-specific analytical memos
- ✅ Dynamic confidence scoring by incident severity + flags
- ✅ Startup backfill — all incidents get packets on boot
- ✅ Incident status management (open → under_review → closed), role-filtered views
- ✅ Footage link evidence — alternative to direct upload for large video files
- ✅ Live terminal with real-time venue state polling (capacity, infrastructure, compliance)
- ✅ Portfolio dashboard for brokers (venue grid, risk tiers, live capacity)
- ✅ Mobile responsive UI — viewport meta tag, adaptive layouts, hamburger nav
- ✅ Atmospheric dark SaaS UI: Cormorant Garamond + DM Sans + JetBrains Mono, grain texture, ambient glow, stagger animations
- ✅ Accessibility: prefers-reduced-motion, touch-action: manipulation, inputMode attributes
- ✅ **Mobile operator app** — Expo React Native, 4-tab bottom nav (Dashboard, Incidents, Report, Live), haptic feedback, camera evidence upload, SecureStore auth

### Phase 2 — LLM-backed agents
- Wire real Claude API calls behind existing interfaces
- Vision analysis for uploaded images
- Video keyframe extraction + analysis
- Audio transcription via Whisper
- Memo drafting with real LLM prose
- Evaluation set to validate agent outputs

### Phase 3 — Production infrastructure
- Postgres migration
- Object storage for evidence files
- Background worker (Celery or arq)
- Role-based access enforcement
- EAS Build + OTA updates for mobile app

### Phase 4 — Claims defense vault
- Evidence export for legal proceedings
- Immutable packet snapshots with stronger hash guarantees
- Expanded retention policies
- Legal/claims reviewer role
