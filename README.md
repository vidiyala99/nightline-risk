# Nightline Risk OS

[![CI](https://github.com/vidiyala99/nightline-risk/actions/workflows/ci.yml/badge.svg)](https://github.com/vidiyala99/nightline-risk/actions/workflows/ci.yml)
[![E2E](https://github.com/vidiyala99/nightline-risk/actions/workflows/e2e.yml/badge.svg)](https://github.com/vidiyala99/nightline-risk/actions/workflows/e2e.yml)

**Evidence-first insurance for nightlife — rebuilt as software, end to end.**

Nightline runs the full value chain. A venue logs an incident; AI agents turn it into a citation-backed underwriting packet in ~200ms; a broker places coverage; and the **carrier** underwrites its own submissions and adjudicates its own claims — coverage decision → reserve → payment → close. The first AI-native carrier, in miniature. Every step traces back to source evidence.

**[Live demo](https://nightline-app.vercel.app)** · **[Eval dashboard](https://nightline-app.vercel.app/evals)** · **[Mobile walkthrough](https://drive.google.com/file/d/1UaMGv5HxK811FAFx8cNE9l1x2IPFVuuI/view?usp=sharing)**

One-click demo personas on the landing page, or sign in (password `demo123`): `venue@elsewhere.com` (operator) · `broker@nightline.risk` (broker) · `underwriter@nightline.risk` (carrier desk)

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
      │
      ▼
Carrier desk   underwrite submission (suggested terms / decline)  ·  adjudicate claim
               coverage decision → reserve → payment → close   (+ advisory AI underwriting memo)
```

---

## Highlights

- **Evidence layer** — incident → multi-agent packet (retrieval, risk eval, timeline, memo) → broker decision. A vision agent corroborates uploaded photos/video against the written report.
- **Recommendation + routing** — a deterministic "worth filing?" engine (net EV, confidence) auto-routes high-confidence incidents to a prioritized broker inbox.
- **Broker platform** — full placement → policy → claims lifecycle: submissions, multi-carrier quotes, bind, endorsements, COIs, cancellation refunds, and carrier-side claims. On **web and mobile**.
- **Carrier desk** — Nightline's own underwriting + claims authority (the "AI-native carrier" rung): a carrier underwrites submissions at engine-suggested terms or declines, and an adjuster adjudicates claims end to end — coverage decision → reserve → payment → close, with an indemnity gate and a full audit trail. Web and mobile.
- **AI underwriting memo** — an advisory, eval-gated recommendation on the carrier's quote dossier: posture (quote / quote-with-conditions / decline), subjectivities, and a rate-adequacy read, grounded in the venue's risk + loss history (the pricing engine still owns the premium). Deterministic-first, so it runs with no keys.
- **Eval harness** — 21 incident scenarios (7 exposure classes) × 10 scorers, plus 12 underwriting scenarios × 3 scorers (posture **0.917** / rate-adequacy **0.917** / faithfulness **1.0**, including boundary cases where the model's call is a documented, defensible disagreement). Signature-keyed baseline regression gate in CI; live scoreboard at [`/evals`](https://nightline-app.vercel.app/evals).
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
python -m scripts.seed_adjuster_demo     # 8 carrier claims across every adjudication state
```

---

## Docs

- [Architecture v2](docs/superpowers/specs/2026-05-07-architecture-v2.md) — the evidence layer (incidents → packets → claim proposals)
- [Broker platform, Phases 1–3](docs/superpowers/specs/2026-05-21-broker-platform-phases-1-3.md) — placement, policy lifecycle, carrier claims
- [ADR-0004](docs/adr/0004-broker-platform-and-claim-vocabulary-split.md) — why `Claim` ≠ `ClaimProposal`
- [Carrier claims adjudication](docs/superpowers/specs/2026-06-02-carrier-claims-adjudication-design.md) + [AI underwriting memo](docs/superpowers/specs/2026-06-03-carrier-ai-underwriting-memo-design.md) — the carrier rung
- More design specs in [`docs/superpowers/specs/`](docs/superpowers/specs).
