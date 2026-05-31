# Nightline Risk OS

[![CI](https://github.com/vidiyala99/nightline-risk/actions/workflows/ci.yml/badge.svg)](https://github.com/vidiyala99/nightline-risk/actions/workflows/ci.yml)
[![E2E](https://github.com/vidiyala99/nightline-risk/actions/workflows/e2e.yml/badge.svg)](https://github.com/vidiyala99/nightline-risk/actions/workflows/e2e.yml)

**Evidence-first underwriting infrastructure for nightlife venues.**

A venue operator logs an incident; AI agents turn it into a citation-backed underwriting packet in ~200ms; a broker reviews, decides, and — when it's worth filing — routes it to a carrier claim. Every step traces back to source evidence.

**[Live demo](https://nightline-app.vercel.app)** · **[Eval dashboard](https://nightline-app.vercel.app/evals)** · **[Mobile walkthrough](https://drive.google.com/file/d/1UaMGv5HxK811FAFx8cNE9l1x2IPFVuuI/view?usp=sharing)**

Demo logins (password `demo123`): `broker@nightline.risk` · `venue@elsewhere.com`

---

## What it does

```
Operator logs an incident
      │
      ▼
Agent pipeline (~200ms)   retrieval · risk scoring · claims timeline · underwriter memo
      │
      ▼
Citation-backed underwriting packet      (+ async vision corroboration on uploaded media)
      │
      ▼
"Worth filing?" recommendation   →   auto-routed to the broker's inbox
      │
      ▼
Broker reviews → Approve / Reject / Request info   →   confirm & file FNOL → carrier Claim
```

---

## Highlights

- **Evidence layer** — incident → multi-agent packet (retrieval, risk eval, timeline, memo) → broker decision. A vision agent corroborates uploaded photos/video against the written report.
- **Recommendation + routing** — a deterministic "worth filing?" engine (net EV, confidence) auto-routes high-confidence incidents to a prioritized broker inbox.
- **Broker platform** — full placement → policy → claims lifecycle: submissions, multi-carrier quotes, bind, endorsements, COIs, cancellation refunds, and carrier-side claims (FNOL → reserve → settle → close). On **web and mobile**.
- **Eval harness** — 21 scenarios across 7 exposure classes × 10 scorers, with a signature-keyed baseline regression gate wired into CI and a live scoreboard at [`/evals`](https://nightline-app.vercel.app/evals).
- **Ingestion spine** — extract → transform → quality-gate → idempotent-load pipeline (POS / ID-scanner / staffing / NY State open data) that moves venue risk scores from real signals.
- **Live monitoring** — per-zone RTSP frame sampler → Gemini classification → a 3-gate false-positive filter → self-calibrating PWA push alerts.
- **Engineering discipline** — `Decimal` money, UTC timestamps, lifecycle state machines with `assert_valid_transition`, an `AuditEvent` on every state change, SHA-256 snapshot hashes, and a pluggable provider matrix (deterministic stubs + Anthropic / Gemini / OpenAI, key-gated).

---

## Stack

| Layer | Technology |
|---|---|
| Web | Next.js 16 (App Router) |
| Mobile | React Native (Expo SDK 54) |
| Backend | FastAPI + SQLModel (Postgres in prod, SQLite locally) |
| Agents | Deterministic stubs + Anthropic / Gemini / OpenAI (key-gated) |
| Deploy | Vercel (web) + Railway (backend) |

---

## Run locally

**Backend** (from `backend/`):
```bash
python -m uvicorn app.main:app --port 8000
```

**Frontend** (from `frontend/`):
```bash
npm run dev          # → http://localhost:3000
```
Set `NEXT_PUBLIC_API_URL=http://localhost:8000` in `frontend/.env.local`. Backend env is all optional except `APP_SECRET` in production — see [`backend/.env.example`](backend/.env.example). Unset LLM keys fall back to deterministic stubs, so it runs with no keys.

**Mobile** (from `mobile/`): set `EXPO_PUBLIC_API_URL`, run `npm start`, scan the QR with [Expo Go](https://expo.dev/go).

---

## Seed data

Idempotent; auto-seeds on startup — 5 demo venues with diverse incidents, plus ~286 real NYC nightlife licensees as scored prospects (NY State open data). Optional scripts, from `backend/`:

```bash
python -m scripts.seed_demo_placements   # 4 submissions + 1 bound policy
python -m scripts.seed_prospects         # ~286 NYC prospects
python -m scripts.seed_defense_demo      # incident → packet → claim (exportable defense PDF)
```

---

## Docs

- [Architecture v2](docs/superpowers/specs/2026-05-07-architecture-v2.md) — the evidence layer (incidents → packets → claim proposals)
- [Broker platform, Phases 1–3](docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md) — placement, policy lifecycle, carrier claims
- [ADR-0004](docs/adr/0004-broker-platform-and-claim-vocabulary-split.md) — why `Claim` ≠ `ClaimProposal`
- More design specs in [`docs/superpowers/specs/`](docs/superpowers/specs).
