# Nightline Risk OS

[![CI](https://github.com/vidiyala99/nightline-risk/actions/workflows/ci.yml/badge.svg)](https://github.com/vidiyala99/nightline-risk/actions/workflows/ci.yml)
[![E2E](https://github.com/vidiyala99/nightline-risk/actions/workflows/e2e.yml/badge.svg)](https://github.com/vidiyala99/nightline-risk/actions/workflows/e2e.yml)

Evidence-first underwriting infrastructure for nightlife venues. Built as a working prototype of what Nightline's core platform could look like.

**Live demo:** https://frontend-mu-ebon-n3x8uw2rpx.vercel.app  
**Mobile walkthrough:** https://drive.google.com/file/d/1UaMGv5HxK811FAFx8cNE9l1x2IPFVuuI/view?usp=sharing  
**Eval dashboard:** [`/evals`](https://frontend-mu-ebon-n3x8uw2rpx.vercel.app/evals) — committed baseline, scorer breakdown, stack signature  
**Architecture:**
- [Agent pipeline, LLM integration points, and roadmap](docs/superpowers/specs/2026-05-07-architecture-v2.md) — evidence layer (incidents → packets → claim proposals)
- [Broker platform — Phases 1–3](docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md) — placement, policy lifecycle, carrier-side claims
- [ADR-0004 — Claim vs. ClaimProposal vocabulary split](docs/adr/0004-broker-platform-and-claim-vocabulary-split.md)

---

## What It Does

A venue operator logs an incident. AI agents analyze it instantly and produce a citation-backed underwriting packet. An underwriter opens their queue, reviews the report, and makes a decision — all traceable back to source evidence.

```
Operator logs incident
        │
        ▼
Agent pipeline runs (~200ms)
  → Retrieval agent pulls policy docs + stream events
  → Risk evaluator scores severity + confidence
  → Claims timeline reconstructed
  → Underwriting memo drafted with open questions
        │
        ▼
Underwriting packet created (Phase 1)
        │
        ├── Vision pipeline runs async (Phase 2)
        │     → Image/video analyzed by vision agent
        │     → Corroboration agent compares vs written report
        │     → Packet updated with visual findings
        │
        ▼
Underwriter reviews report → Approve / Block / Request More Info

Live camera feed (Phase 3)
  → RTSP sampler captures 1 frame / 8s per zone
  → Gemini 2.5 Flash classifies event type + severity
  → 3-gate filter (confidence ≥ 0.75 + 3 consecutive frames + critical/high severity)
  → 20-min cooldown per zone prevents spam
  → PWA push notification → operator mobile alert
  → Operator marks Confirmed / False Alarm → threshold self-calibrates
```

---

## Demo Logins

| Role | Email | Password |
|------|-------|----------|
| Broker | broker@nightline.risk | demo123 |
| Venue Operator | venue@elsewhere.com | demo123 |

Or create a new account via **Sign Up / Create Account** on the login screen (web + mobile). New venue operators get a blank dashboard and walk through venue setup on first login.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16.2 (App Router), DM Sans + Cormorant Garamond + JetBrains Mono |
| Mobile | React Native (Expo SDK 54), expo-secure-store, React Navigation |
| Backend | FastAPI + SQLModel (Postgres on Railway, SQLite locally) |
| Agents | Deterministic stubs with LLM-ready interfaces |
| Auth | HMAC-signed JWT tokens (role-aware: broker, venue_operator) |
| Deployment | Vercel (frontend) + Railway (backend) |

---

## Key Features

- **Dual portal** — operator terminal and broker workbench with role-aware navigation
- **Agent pipeline** — retrieval, risk evaluation, claims timeline, memo drafting (~200ms synchronous)
- **Two-phase packets** — instant text analysis + async vision processing for uploaded evidence
- **Vision corroboration** — visual findings flagged CONSISTENT / PARTIAL / CONTRADICTED against the written report
- **Claims v1 — operator proposes, broker decides** — structured 4-tag override vocabulary, full state machine (pending → approved | rejected → filed), shipped on web and mobile with EV breakdown and lifecycle timeline
- **Override calibration** — per-venue and cross-portfolio stats on which override reasons hold up under broker scrutiny; the training signal for v2 rubric calibration
- **Reports queue** — severity-sorted packet list with role-scoped views (broker "Reports Portfolio" / operator "My Reports") and full audit trail
- **Risk Profile + Compliance pages** — factor breakdowns, premium impact, role-aware compliance views
- **Self-serve registration + venue management** — sign up on web or mobile, add/edit multiple venues
- **Mobile app** — full iOS/Android app with role-aware tabs (now including a Claims tab) and the same typography system as the web
- **Pluggable provider matrix** — `MemoProvider`, `RiskClassifierProvider`, `TranscriptionProvider`, `EmbeddingProvider` interfaces with deterministic stubs + Anthropic/Gemini/OpenAI implementations; swap providers without touching agent code
- **Live camera monitoring + PWA alerts** — RTSP frame sampler per venue zone feeds Gemini 2.5 Flash; a 3-gate filter (confidence, temporal persistence, severity) suppresses false positives; qualifying events push mobile notifications via Web Push to subscribed operators; operators confirm or flag as false alarm to self-calibrate per-venue thresholds
- **Broker platform — Placement, Policy lifecycle, Carrier-side claims** — Phases 1–3 of the broker workflow shipped end-to-end on the backend (frontend through Phase 2):
  - **Placement (Phase 1):** `Submission` → `CarrierQuote` lifecycle with appetite-checked carrier targeting, per-carrier multipliers on top of shared base rates, surplus-lines tax for E&S, and a kanban UI at `/submissions` with drag-to-transition gates pulled from the lifecycle matrix
  - **Policy lifecycle (Phase 2):** atomic `bind_quote` (6-effect savepoint), endorsements with Pydantic-validated `terms_diff` discriminated unions, pro-rata vs. short-rate cancellation refund math, and Certificates of Insurance with audit-preserving superseding to the same holder
  - **Claims integration (Phase 3, backend only):** carrier-side `Claim` with FNOL → reserved → settling → closed lifecycle, `ClaimPayment` ledger across indemnity/expense/recovery, `ReserveChange` audit rows, `ON DELETE RESTRICT` FK from claim to its frozen defense packet — distinct from the `ClaimProposal` recommendation surface ([see ADR-0004](docs/adr/0004-broker-platform-and-claim-vocabulary-split.md))
  - All money is `Decimal`/`Numeric(12,2)`, all timestamps UTC via `app.time.now_utc`, all lifecycle transitions go through `app.lifecycles.assert_valid_transition`, all state changes emit `AuditEvent` rows, and `Policy`/`Claim` carry SHA-256 `snapshot_hash` columns so archived defense packages keep their referent
- **Load-bearing eval harness** — 15 research-grounded scenarios across 7 exposure classes + adversarial gold set, 5 scorers (structural, severity_match, citation_coverage, review_status_match, factor_recognition) plus retrieval and safety scorers, signature-keyed `baseline.json` regression gate wired into CI, nightly LLM provider matrix; see [`/evals` dashboard](https://frontend-mu-ebon-n3x8uw2rpx.vercel.app/evals) and [`docs/evals/README.md`](docs/evals/README.md)

---

## Local Development

**Backend:**
```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Required env vars in `backend/.env`:
```
GEMINI_API_KEY=...          # vision analysis
ANTHROPIC_API_KEY=...       # memo drafting
VAPID_PRIVATE_KEY=...       # Web Push alerts (generate with: npx web-push generate-vapid-keys)
```

**Frontend:**
```powershell
cd frontend
npm run dev -- --hostname 127.0.0.1 --port 3000
```

Required env vars in `frontend/.env.local`:
```
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...   # matching public key from above
```

**Live camera monitoring** (optional — sampler skips gracefully if opencv missing):
```powershell
pip install opencv-python   # in backend venv
```
Register cameras via `POST /api/venues/{venue_id}/cameras` with the RTSP URL, then start sampling via `POST /api/cameras/{camera_id}/start`.

Open `http://localhost:3000`

**Mobile (Expo Go):**
```powershell
cd mobile
# Create .env.local with your backend URL:
# EXPO_PUBLIC_API_URL=https://your-railway-backend.up.railway.app
npm start
```

Scan the QR code with [Expo Go](https://expo.dev/go) on your device. Log in with `venue@elsewhere.com / demo123`.

---

## Architecture

See `docs/superpowers/specs/2026-05-07-architecture-v2.md` for the full system design, data contracts, LLM integration points, and phased roadmap.

---

## Seed Data

5 venues across Brooklyn/NYC with 10 diverse incidents (brawls, medical emergencies, property damage, liquor liability, crowd management). Packets generated automatically on startup. Demo accounts pre-configured.

To populate the broker-platform surface (`/submissions`, `/policies`) with realistic rows across all lifecycle states, run the idempotent seed script:

```powershell
cd backend
python -m scripts.seed_demo_placements
```

This produces four submissions (`open`, `in_market`, `quoting`, `bound`) and one active policy. See [the broker-platform spec](docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md#6-demo-data) for the venue/carrier choices and the case-sensitivity note on `check_appetite`.
