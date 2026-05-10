# Third Space Risk OS

Evidence-first underwriting infrastructure for nightlife venues. Built as a working prototype of what Third Space's core platform could look like.

**Live demo:** https://frontend-mu-ebon-n3x8uw2rpx.vercel.app  
**Mobile walkthrough:** https://drive.google.com/file/d/1UaMGv5HxK811FAFx8cNE9l1x2IPFVuuI/view?usp=sharing  
**Architecture:** [Agent pipeline, LLM integration points, and roadmap](docs/superpowers/specs/2026-05-07-architecture-v2.md)

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
```

---

## Demo Logins

| Role | Email | Password |
|------|-------|----------|
| Broker | broker@thirdspace.risk | demo123 |
| Venue Operator | venue@elsewhere.com | demo123 |

Or create a new account via **Sign Up / Create Account** on the login screen (web + mobile). New venue operators get a blank dashboard and walk through venue setup on first login.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16.2 (App Router), DM Sans + Cormorant Garamond + JetBrains Mono |
| Mobile | React Native (Expo SDK 54), expo-secure-store, React Navigation |
| Backend | FastAPI + SQLModel + SQLite |
| Agents | Deterministic stubs with LLM-ready interfaces |
| Auth | HMAC-signed JWT tokens (role-aware: broker, venue_operator) |
| Deployment | Vercel (frontend) + Railway (backend) |

---

## Key Features

- **Dual portal** — operator terminal and broker workbench with role-aware navigation
- **Agent pipeline** — retrieval, risk evaluation, claims timeline, memo drafting (~200ms synchronous)
- **Two-phase packets** — instant text analysis + async vision processing for uploaded evidence
- **Vision corroboration** — visual findings flagged CONSISTENT / PARTIAL / CONTRADICTED against the written report
- **Reports queue** — severity-sorted packet list with review decisions and full audit trail
- **Risk Profile + Compliance pages** — factor breakdowns, premium impact, role-aware compliance views
- **Self-serve registration + venue management** — sign up on web or mobile, add/edit multiple venues
- **Mobile app** — full iOS/Android app with role-aware tabs and the same typography system as the web

---

## Local Development

**Backend:**
```powershell
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

**Frontend:**
```powershell
cd frontend
npm run dev -- --hostname 127.0.0.1 --port 3000
```

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
