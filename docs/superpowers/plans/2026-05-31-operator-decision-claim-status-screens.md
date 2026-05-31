# Operator Decision + Claim-Status Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the operator incident hub: move the inline "Worth filing?" two-path card to a dedicated `/incidents/[id]/decision` screen and the inline claim-status stepper to `/incidents/[id]/claim-status`, leaving the hub with two compact entry links.

**Architecture:** Two new operator-facing nested routes under the incident (venue-gated via the incident, each with its own `layout.tsx` wrapping `AppShell`). Both reuse existing data — no new backend. The current operator JSX blocks are relocated into the new pages; the broker branch of the incident detail is untouched.

**Tech Stack:** Next.js (App Router) / React / TS. Gates: `npx tsc --noEmit` (ignore `.next/dev/types` + `risk-profile` noise) + `node scripts/design-lint.mjs` (must be 0).

**Spec:** `docs/superpowers/specs/2026-05-31-operator-decision-and-claim-status-screens-design.md`.

**Key facts (verified, in `frontend/src/app/incidents/[id]/page.tsx`):**
- `rec` (packet `claim_recommendation`) type at lines 247–251: `{ should_file, net_expected_value_usd, confidence, reasons[], carrier_payout, deductible: number|null, pay_out_of_pocket_cost, expected_premium_impact: { annual_delta_usd, duration_years, cumulative_usd } }`. `primaryPacket = packets[0]`; `routingStatus = primaryPacket.routing_status` ("auto_routed"|"borderline"|"not_routed").
- The operator **two-path card** JSX is lines **477–559** (the `{isOperator && (() => {...})()}` block), its **verdict badge** 471–475, **reasons** 580–586, **venue-risk snapshot** 589–603, and the **operator routing footer** 621–640 (`sendToBroker` defined at 258–264).
- The **claim-status stepper** JSX is lines **646–703** (`{isOperator && claimStatus && (() => {...})()}`); `ClaimStatusResponse = { incident_status, proposal: {exists, state}, claim: {exists, status} }`.
- `IncidentClaim` fields (line ~135): `{ id, incident_id, carrier_claim_number, coverage_line, status, current_reserve }`; the hub finds the venue's claim via `GET /api/venues/{venueId}/claims` then `rows.find(c => c.incident_id === id)`.
- Auth/data: `authHeaders()` from `@/lib/authFetch` on every fetch; `useRole()`/`useAuth()` from `@/contexts/AuthContext`; `API_URL` pattern `process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000"`. Per-page layout pattern: `frontend/src/app/risk-profile/layout.tsx` (AppShell + Suspense + skeleton).
- Hub hover/focus row class `.wq-row` exists in `styles.css` (reuse for the entry links).

---

## File Structure

**Create:**
- `frontend/src/app/incidents/[id]/decision/layout.tsx` — AppShell wrapper.
- `frontend/src/app/incidents/[id]/decision/page.tsx` — decision screen.
- `frontend/src/app/incidents/[id]/claim-status/layout.tsx` — AppShell wrapper.
- `frontend/src/app/incidents/[id]/claim-status/page.tsx` — claim-status screen.

**Modify:**
- `frontend/src/app/incidents/[id]/page.tsx` — operator branch only: replace the inline two-path card + stepper with two compact entry links. Broker branch unchanged.
- `frontend/e2e/` — only if a spec pins the removed inline blocks (Task 4 greps first).

---

## Task 1: Decision screen

**Files:**
- Create: `frontend/src/app/incidents/[id]/decision/layout.tsx`
- Create: `frontend/src/app/incidents/[id]/decision/page.tsx`

- [ ] **Step 1: Create the layout** — `frontend/src/app/incidents/[id]/decision/layout.tsx` (mirror `risk-profile/layout.tsx`):

```tsx
import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";

export default function DecisionLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense fallback={<div className="page-loading"><div className="loading-spinner" /></div>}>{children}</Suspense>
    </AppShell>
  );
}
```

- [ ] **Step 2: Create the page** — `frontend/src/app/incidents/[id]/decision/page.tsx`. It fetches the incident (for `venue_id` + summary), its packets (for `rec` + `routing_status`), and the venue risk score; renders the hero + the two-path comparison (the SAME markup currently in the hub) + reasons + risk snapshot + send-to-broker footer. Operator-only (redirect others to the incident hub).

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Rec {
  should_file: boolean;
  net_expected_value_usd: number;
  confidence: number;
  reasons: string[];
  carrier_payout: number;
  deductible: number | null;
  pay_out_of_pocket_cost: number;
  expected_premium_impact: { annual_delta_usd: number; duration_years: number; cumulative_usd: number };
}

export default function DecisionPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [summary, setSummary] = useState<string>("");
  const [venueId, setVenueId] = useState<string | null>(null);
  const [rec, setRec] = useState<Rec | null>(null);
  const [packetId, setPacketId] = useState<string | null>(null);
  const [routingStatus, setRoutingStatus] = useState<string | undefined>(undefined);
  const [riskScore, setRiskScore] = useState<{ total_score: number; tier: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/login"); }, [isLoaded, isSignedIn, router]);
  // Operator-facing screen; brokers use /underwriter. Bounce non-operators to the hub.
  useEffect(() => { if (isLoaded && isSignedIn && !isOperator) router.replace(`/incidents/${id}`); }, [isLoaded, isSignedIn, isOperator, id, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isOperator) return;
    let cancelled = false;
    (async () => {
      const incRes = await fetch(`${API_URL}/api/incidents/${id}`, { headers: authHeaders() });
      const inc = incRes.ok ? await incRes.json() : null;
      const pkRes = await fetch(`${API_URL}/api/incidents/${id}/packets`, { headers: authHeaders() });
      const pkts = pkRes.ok ? await pkRes.json() : [];
      const primary = Array.isArray(pkts) ? pkts[0] : undefined;
      let rs = null;
      if (inc?.venue_id) {
        const rsRes = await fetch(`${API_URL}/api/venues/${inc.venue_id}/risk-score`, { headers: authHeaders() });
        if (rsRes.ok) rs = await rsRes.json();
      }
      if (cancelled) return;
      setSummary(inc?.summary ?? "");
      setVenueId(inc?.venue_id ?? null);
      setRec(primary?.claim_recommendation ?? null);
      setPacketId(primary?.id ?? null);
      setRoutingStatus(primary?.routing_status);
      setRiskScore(rs);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isLoaded, isSignedIn, isOperator]);

  const sendToBroker = async () => {
    if (!packetId) return;
    const res = await fetch(`${API_URL}/api/packets/${packetId}/claim-proposal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ operator_id: "operator", override_recommendation: false }),
    });
    if (res.ok) location.reload();
  };

  if (!isLoaded || loading || !isOperator) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <button onClick={() => router.push(`/incidents/${id}`)} className="flex items-center gap-xs text-secondary text-sm" style={{ background: "none", border: "none", cursor: "pointer", padding: "16px 0" }}>
        <ArrowLeft size={14} /> Back to incident
      </button>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">OPERATOR<span className="lc-eyebrow__sep" />DECISION</span>
          <h1 className="lc-display">File or <em>pay out of pocket?</em></h1>
          <p className="lc-sub">{summary}</p>
        </div>
      </section>

      {!rec ? (
        <div className="lc-card"><div className="lc-card__inner"><p className="text-sm text-muted" style={{ margin: 0 }}>No recommendation available for this incident yet.</p></div></div>
      ) : (
        <>
          {/* Verdict badge */}
          <div className="mb-md">
            {rec.should_file
              ? <span className="badge badge-success">Recommended: File</span>
              : <span className="badge badge-warning">{rec.deductible == null ? "No active policy" : "Recommended: pay out of pocket"}</span>}
          </div>

          {/* MOVE: the two-path comparison block from incidents/[id]/page.tsx lines 478–559
             (the `{isOperator && (() => { ... })()}` IIFE body). It references only
             rec.* fields — paste the IIFE body here, replacing `rec.` reads with this
             page's `rec` state (identical shape). Keep the no-active-policy branch. */}

          {/* Reasons (move from page.tsx 580–586) */}
          {rec.reasons.length > 0 && (
            <ul style={{ margin: "0 0 var(--space-md) var(--space-md)", padding: 0, fontSize: "0.82rem" }}>
              {rec.reasons.map((r, i) => <li key={i} className="text-muted" style={{ marginBottom: "var(--space-xs)" }}>{r}</li>)}
            </ul>
          )}

          {/* Venue risk snapshot (move from page.tsx 589–603) */}
          {riskScore && (
            <div className="text-muted mb-md" style={{ fontSize: "0.82rem" }}>
              Venue risk <span className="font-mono">{riskScore.total_score}/100</span>
              {" · "}tier <span className="font-mono" style={{ color: `var(--tier-${riskScore.tier.toLowerCase()})`, fontWeight: 700 }}>{riskScore.tier}</span>
              {venueId && <>{" · "}<a href={`/incidents?venue=${venueId}`}>recent incidents</a></>}
            </div>
          )}

          {/* Send-to-broker footer (move operator branch from page.tsx 621–640) */}
          {routingStatus === "borderline" && (
            <button className="btn btn-primary" onClick={sendToBroker} aria-label="Send this incident to the broker for review" style={{ minHeight: 44 }}>Send to broker</button>
          )}
          {routingStatus === "auto_routed" && <span className="badge badge-info">Sent to broker for review</span>}
          {routingStatus === "not_routed" && <span className="text-muted">Logged — below the filing threshold.</span>}
        </>
      )}
    </div>
  );
}
```

For the two-path block comment: copy the IIFE body verbatim from `incidents/[id]/page.tsx:478–559` (the `(() => { if (rec.deductible == null) {...} ... return (<div className="flex gap-md mb-md" ...>{filePanel}{popPanel}</div>); })()`). It already depends only on `rec.*`. Paste it where the comment is and wrap it as `{(() => { ... })()}`.

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → no new errors in `decision/`.

- [ ] **Step 4: Commit**

```bash
git add "frontend/src/app/incidents/[id]/decision"
git commit -F- <<'EOF'
feat(web): operator decision screen at /incidents/[id]/decision

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Claim-status screen

**Files:**
- Create: `frontend/src/app/incidents/[id]/claim-status/layout.tsx`
- Create: `frontend/src/app/incidents/[id]/claim-status/page.tsx`

- [ ] **Step 1: Create the layout** — identical to Task 1's layout but named `ClaimStatusLayout`.

- [ ] **Step 2: Create the page** — fetches claim-status + the venue claim row (for carrier #/reserve). Renders hero, the stepper (moved), branch tags, claim-detail block (when a claim exists), pre-claim empty state, back link. Operator-only.

```tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Circle, AlertTriangle, Clock } from "lucide-react";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface ClaimStatusResponse {
  incident_status: string;
  proposal: { exists: boolean; state: string | null };
  claim: { exists: boolean; status: string | null };
}
interface IncidentClaim {
  id: string; incident_id: string | null; carrier_claim_number: string | null;
  coverage_line: string; status: string; current_reserve: string;
}

export default function ClaimStatusPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const isOperator = role === "venue_operator";

  const [summary, setSummary] = useState("");
  const [cs, setCs] = useState<ClaimStatusResponse | null>(null);
  const [claim, setClaim] = useState<IncidentClaim | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { if (isLoaded && !isSignedIn) router.push("/login"); }, [isLoaded, isSignedIn, router]);
  useEffect(() => { if (isLoaded && isSignedIn && !isOperator) router.replace(`/incidents/${id}`); }, [isLoaded, isSignedIn, isOperator, id, router]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !isOperator) return;
    let cancelled = false;
    (async () => {
      const incRes = await fetch(`${API_URL}/api/incidents/${id}`, { headers: authHeaders() });
      const inc = incRes.ok ? await incRes.json() : null;
      const csRes = await fetch(`${API_URL}/api/incidents/${id}/claim-status`, { headers: authHeaders() });
      const csData = csRes.ok ? await csRes.json() : null;
      let matched: IncidentClaim | null = null;
      if (inc?.venue_id) {
        const clRes = await fetch(`${API_URL}/api/venues/${inc.venue_id}/claims`, { headers: authHeaders() });
        if (clRes.ok) {
          const rows: IncidentClaim[] = await clRes.json();
          matched = rows.find((c) => c.incident_id === id) ?? null;
        }
      }
      if (cancelled) return;
      setSummary(inc?.summary ?? "");
      setCs(csData);
      setClaim(matched);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [id, isLoaded, isSignedIn, isOperator]);

  if (!isLoaded || loading || !isOperator) {
    return <div className="page-loading"><div className="loading-spinner" /></div>;
  }

  const ps = cs?.proposal.state ?? null;
  const steps = [
    { label: "Reported", lit: true },
    { label: "Sent to broker", lit: !!cs?.proposal.exists },
    { label: "Approved", lit: !!ps && ["approved", "filed_with_carrier", "paid", "denied"].includes(ps) },
    { label: "Filed", lit: (!!ps && ["filed_with_carrier", "paid", "denied"].includes(ps)) || !!cs?.claim.exists },
    { label: "Resolved", lit: (!!ps && ["paid", "denied"].includes(ps)) || (!!cs?.claim.status && ["closed_paid", "closed_denied", "closed_dropped"].includes(cs.claim.status)) },
  ];
  const reserve = claim ? Number(claim.current_reserve) : 0;

  return (
    <div className="lc-shell min-h-screen" style={{ padding: "0 clamp(20px, 4vw, 56px) 64px" }}>
      <button onClick={() => router.push(`/incidents/${id}`)} className="flex items-center gap-xs text-secondary text-sm" style={{ background: "none", border: "none", cursor: "pointer", padding: "16px 0" }}>
        <ArrowLeft size={14} /> Back to incident
      </button>
      <section className="lc-hero">
        <div>
          <span className="lc-eyebrow">OPERATOR<span className="lc-eyebrow__sep" />CLAIM STATUS</span>
          <h1 className="lc-display">Claim <em>status</em></h1>
          <p className="lc-sub">{summary}</p>
        </div>
      </section>

      {!cs?.proposal.exists && !claim ? (
        <div className="lc-card"><div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p className="text-sm" style={{ margin: 0 }}>This incident hasn&apos;t been filed as a claim — it&apos;s a recommendation right now.</p>
          <Link href={`/incidents/${id}/decision`} className="text-sm" style={{ color: "var(--accent-ink)", textDecoration: "none" }}>View decision →</Link>
        </div></div>
      ) : (
        <>
          <div className="lc-card"><div className="lc-card__inner">
            <div role="list" aria-label="Claim status" className="flex gap-sm" style={{ flexWrap: "wrap", alignItems: "center" }}>
              {steps.map((step) => (
                <div key={step.label} role="listitem" className="flex items-center gap-xs" style={{ padding: "4px 10px", borderRadius: "var(--radius-sm)", background: "var(--bg-elevated)" }}>
                  {step.lit
                    ? <CheckCircle2 size={13} style={{ color: "var(--accent-ink)", flexShrink: 0 }} aria-hidden="true" />
                    : <Circle size={13} className="text-muted" style={{ flexShrink: 0 }} aria-hidden="true" />}
                  <span className="text-xs" style={{ color: step.lit ? "var(--accent-ink)" : undefined }}>{step.label}</span>
                </div>
              ))}
            </div>
            {ps === "rejected_by_broker" && <p className="text-xs mt-sm flex items-center gap-xs" style={{ color: "var(--state-error)" }}><AlertTriangle size={12} aria-hidden="true" />Declined by broker</p>}
            {ps === "needs_more_info" && <p className="text-xs mt-sm flex items-center gap-xs" style={{ color: "var(--state-warning)" }}><Clock size={12} aria-hidden="true" />Info requested</p>}
          </div></div>

          {claim && (
            <div className="lc-card mb-lg" style={{ marginTop: "var(--space-md)" }}><div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="text-xs uppercase tracking-wide text-secondary">Carrier claim</div>
              <div className="text-sm">
                {claim.carrier_claim_number ? `Claim ${claim.carrier_claim_number}` : "Claim opened"}
                {" · "}{claim.coverage_line.toUpperCase()}
                {" · "}<span style={{ textTransform: "capitalize" }}>{claim.status.replace(/_/g, " ")}</span>
                {reserve > 0 && <> · reserved <span className="font-mono">${reserve.toLocaleString()}</span></>}
              </div>
            </div></div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → no new errors in `claim-status/`.

- [ ] **Step 4: Commit**

```bash
git add "frontend/src/app/incidents/[id]/claim-status"
git commit -F- <<'EOF'
feat(web): operator claim-status screen at /incidents/[id]/claim-status

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Slim the incident hub (operator branch)

**Files:**
- Modify: `frontend/src/app/incidents/[id]/page.tsx`

Replace the operator inline two-path card and the inline stepper with two compact entry links. The broker branch stays exactly as-is.

- [ ] **Step 1:** In the recommendation card (`{rec && (<div className="card">...`), the verdict badge (471–475) stays. Replace the **operator** two-path IIFE (478–559), the operator reasons/risk that you want only on the decision screen, and the operator routing footer (621–640) with a single compact link. Concretely, wrap the existing operator-only pieces so that for `isOperator` the card body becomes:

```tsx
{isOperator && (
  <Link
    href={`/incidents/${id}/decision`}
    className="wq-row"
    aria-label="View filing decision"
    style={{ textDecoration: "none", marginTop: "var(--space-sm)" }}
  >
    <span style={{ flex: 1 }} className="text-sm">
      {rec.should_file ? "Worth filing" : rec.deductible == null ? "No active policy" : "Pay out of pocket"}
      {" · "}
      <span className="font-mono">net {rec.net_expected_value_usd >= 0 ? "+" : "−"}${Math.abs(rec.net_expected_value_usd).toLocaleString()}</span>
    </span>
    <span className="text-xs text-muted">View decision →</span>
  </Link>
)}
```

Leave the broker branches (the `{isBroker && (...two-stat...)}` block 562–577 and the broker routing footer 608–620) intact. The shared reasons (580–586) and risk snapshot (589–603) should now render **only for brokers** — gate them `{isBroker && rec.reasons.length > 0 && (...)}` and `{isBroker && riskScore && (...)}` (operators see them on the decision screen). The operator routing footer (623–639) is removed from the hub (it moved to the decision screen).

- [ ] **Step 2:** Replace the inline **stepper** block (646–703, the `{isOperator && claimStatus && (() => {...})()}`) with a compact one-line entry. Compute the current step label inline and link out:

```tsx
{isOperator && claimStatus && (() => {
  const ps = claimStatus.proposal.state;
  const filed = claimStatus.claim.exists || (!!ps && ["filed_with_carrier", "paid", "denied"].includes(ps));
  const resolved = (!!ps && ["paid", "denied"].includes(ps)) || (!!claimStatus.claim.status && ["closed_paid", "closed_denied", "closed_dropped"].includes(claimStatus.claim.status));
  const current = resolved ? "Resolved" : filed ? "Filed" : (!!ps && ["approved"].includes(ps)) ? "Approved" : claimStatus.proposal.exists ? "Sent to broker" : "Not filed";
  return (
    <Link href={`/incidents/${id}/claim-status`} className="wq-row" aria-label="View claim status" style={{ textDecoration: "none" }}>
      <span style={{ flex: 1 }} className="text-sm">Claim status: <span style={{ color: "var(--accent-ink)" }}>{current}</span></span>
      <span className="text-xs text-muted">View →</span>
    </Link>
  );
})()}
```

(`Link` is already imported in this file. `wq-row` already exists in styles.css.)

- [ ] **Step 3:** Remove now-unused symbols if the operator move orphaned them: if `sendToBroker` (258–264) is no longer referenced in this file (broker doesn't use it; operator moved it), delete it to avoid an unused-var lint. Verify `routingStatus` is still used by the broker branch (it is not — broker uses `proposalState`); if `routingStatus` (252–254) is now unreferenced after removing the operator footer, delete its derivation too. (Check with a grep before deleting; only remove what's truly unused.)

- [ ] **Step 4: Typecheck + design-lint**

```bash
cd frontend && npx tsc --noEmit
cd "C:/Users/aakas/Documents/JobHunt/ThirdSpaceRisk" && node scripts/design-lint.mjs
```
Expected: no new tsc errors in `incidents/[id]/page.tsx`; design-lint `0 error(s)`.

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/app/incidents/[id]/page.tsx"
git commit -F- <<'EOF'
feat(web): incident hub links to decision + claim-status screens (operator)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: e2e align + verify + push

- [ ] **Step 1: Grep e2e BEFORE pushing** (the lesson): `cd "C:/Users/aakas/Documents/JobHunt/ThirdSpaceRisk" && grep -rnE "Worth filing|Claim status|two-path|Send to broker|incident.*decision" frontend/e2e`. If any spec asserts the removed inline blocks on the incident detail, update it to either navigate to the new route or assert the new compact link. (There is no `incidents/[id]` e2e today, so likely zero hits — but verify.)
- [ ] **Step 2: Web gates** — `cd frontend && npx tsc --noEmit` (no new errors) + `node scripts/design-lint.mjs` (0). Backend unchanged, but run `cd backend && python -m pytest -q -p no:cacheprovider` once to confirm no incidental breakage.
- [ ] **Step 3: Push** — `git push origin main`.
- [ ] **Step 4: Confirm CI** — `gh run list --workflow=e2e.yml --limit 1` → wait for `success`.
- [ ] **Step 5: Manual smoke** (optional, local recipe): as the operator, open an incident → the hub shows the compact "Worth filing · net +$X — View decision →" link and "Claim status: <step> →" link (no big inline blocks); the decision link opens the two-path screen; the claim-status link opens the stepper (or pre-claim empty state); "← Back to incident" returns. Broker view unchanged.

---

## Out of scope
- No backend changes. No broker changes. No add/delete venues. No mobile (Phase 4).
- The top-of-page "Filed as a carrier claim" closed-loop banner stays as-is (separate element; not part of this split).
