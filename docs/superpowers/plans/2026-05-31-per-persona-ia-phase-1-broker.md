# Per-persona IA — Phase 1 (Broker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the broker a single decision surface (Work Queue) with a value+urgency sort, a task-oriented nav spine, and a home triage strip — collapsing today's four-item decision scatter.

**Architecture:** Reuse the existing `/api/claim-proposals` list endpoint (it already supports `status=` + `sort=priority`). Add a time-decay term to the priority function. Add one new web route `/work-queue` that groups proposals by state; redirect the two duplicate decision pages to the canonical surfaces. Branch `AppShell` navigation by persona (broker spine now; operator nav unchanged until Phase 2). Add a counts-only triage strip to the broker dashboard.

**Tech Stack:** Python / FastAPI / SQLModel (backend), Next.js (App Router) / React / TypeScript (web). pytest TDD backend; `tsc --noEmit` + `node scripts/design-lint.mjs` gate web.

**Spec:** `docs/superpowers/specs/2026-05-31-per-persona-ia-homes-and-nav-design.md` (Phase 1 = A broker home triage strip, B nav spine, C Work Queue, D1 redirects).

**Key facts (verified):**
- `_proposal_priority(p)` and `list_claim_proposals(...)` live in `backend/app/api/v1/claim_proposals.py`. The list endpoint already does `if sort == "priority": proposals = sorted(proposals, key=_proposal_priority, reverse=True)`.
- `ClaimProposal` (`app/models.py:188`) fields: `id, packet_id, venue_id, proposed_by, proposed_at: datetime(default utcnow), state(default "pending_broker_review"), recommendation_snapshot: Optional[dict]`. States: `pending_broker_review → approved → filed_with_carrier → paid|denied`, `→ rejected_by_broker`, `→ needs_more_info → pending_broker_review`.
- The canonical broker decision surface is `/underwriter/[id]` (id = **packet id**). The existing inbox already routes rows with `router.push(\`/underwriter/${p.packet_id}\`)`. The duplicate is `/claim-proposals/[packetId]`.
- Per-page layout pattern: each top-level route dir has its own `layout.tsx` wrapping `<AppShell>` (e.g. `frontend/src/app/submissions/layout.tsx`). A new route renders bare without one.
- Web auth: every `fetch` must pass `headers: authHeaders()` from `@/lib/authFetch` (uploads omit Content-Type; JSON GETs just send authHeaders()).
- Design-lint bans raw lime/dark hex in components — use tokens (`var(--accent-ink)`, `var(--border-subtle)`, `badge-*`, etc.).

---

## File Structure

**Backend — modify:**
- `backend/app/api/v1/claim_proposals.py` — add a time-decay term to `_proposal_priority`.
- `backend/tests/test_claim_routes.py` — priority unit tests.

**Web — create:**
- `frontend/src/app/work-queue/layout.tsx` — `AppShell` wrapper (copy of `submissions/layout.tsx`).
- `frontend/src/app/work-queue/page.tsx` — the Work Queue (three state-grouped buckets).

**Web — modify:**
- `frontend/src/app/claim-proposals/page.tsx` — redirect → `/work-queue`.
- `frontend/src/app/claim-proposals/[packetId]/page.tsx` — redirect → `/underwriter/[packetId]`.
- `frontend/src/app/underwriter/page.tsx` — redirect → `/work-queue` (the index only; `[id]` stays).
- `frontend/src/components/layout/AppShell.tsx` — broker nav spine (operator nav unchanged).
- `frontend/src/app/dashboard/page.tsx` — broker home triage strip.

---

## Task 1: Value + urgency priority sort

**Files:**
- Modify: `backend/app/api/v1/claim_proposals.py` (`_proposal_priority`)
- Test: `backend/tests/test_claim_routes.py`

- [ ] **Step 1: Write the failing tests** (append to `backend/tests/test_claim_routes.py`):

```python
from datetime import datetime, timezone, timedelta
from app.api.v1.claim_proposals import _proposal_priority
from app.models import ClaimProposal as _CP

_NOW = datetime(2026, 6, 1, tzinfo=timezone.utc)

def _prop(median, conf, age_days):
    return _CP(
        id=f"wq-{median}-{age_days}", packet_id="pk", venue_id="v", proposed_by="x",
        state="pending_broker_review",
        recommendation_snapshot={"confidence": conf, "expected_payout": {"median_usd": median}},
        proposed_at=_NOW - timedelta(days=age_days),
    )

def test_priority_value_first_when_both_fresh():
    assert _proposal_priority(_prop(90000, 0.9, 0), _NOW) > _proposal_priority(_prop(10000, 0.7, 0), _NOW)

def test_priority_urgency_lifts_aged_over_fresh_same_value():
    assert _proposal_priority(_prop(10000, 0.7, 30), _NOW) > _proposal_priority(_prop(10000, 0.7, 0), _NOW)

def test_priority_no_boost_within_three_day_grace():
    assert _proposal_priority(_prop(10000, 0.7, 2), _NOW) == _proposal_priority(_prop(10000, 0.7, 0), _NOW)

def test_priority_missing_snapshot_sorts_last():
    p = _CP(id="wq-none", packet_id="pk", venue_id="v", proposed_by="x",
            state="pending_broker_review", proposed_at=_NOW)
    assert _proposal_priority(p, _NOW) == 0.0
```

- [ ] **Step 2: Run to verify fail** — `cd backend && python -m pytest tests/test_claim_routes.py -q -p no:cacheprovider -k priority` → FAIL: `_proposal_priority()` takes 1 positional arg (the `_NOW` arg) / no urgency boost.

- [ ] **Step 3: Implement** — replace `_proposal_priority` in `backend/app/api/v1/claim_proposals.py`:

```python
from datetime import datetime, timezone

def _proposal_priority(p: ClaimProposal, now: "datetime | None" = None) -> float:
    """Value (confidence x median payout), boosted as the item ages past a 3-day
    grace so a high-value item ranks first immediately AND an aging item
    eventually surfaces. Missing snapshot sorts last (0). Constants are tunable.
    """
    snap = p.recommendation_snapshot or {}
    median = (snap.get("expected_payout") or {}).get("median_usd", 0)
    base_value = float(snap.get("confidence", 0.0)) * float(median)
    if base_value == 0.0:
        return 0.0
    if now is None:
        now = datetime.now(timezone.utc)
    proposed = p.proposed_at
    if proposed is not None and proposed.tzinfo is None:
        proposed = proposed.replace(tzinfo=timezone.utc)   # SQLite stores naive UTC
    age_days = ((now - proposed).total_seconds() / 86400.0) if proposed else 0.0
    urgency_factor = 1.0 + 0.15 * max(0.0, age_days - 3.0)
    return base_value * urgency_factor
```

The call site `sorted(proposals, key=_proposal_priority, reverse=True)` is unchanged — `now` defaults inside.

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_claim_routes.py -q -p no:cacheprovider` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/claim_proposals.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(inbox): value+urgency priority — aging proposals surface, not just high-value

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Work Queue page (canonical decision surface)

**Files:**
- Create: `frontend/src/app/work-queue/layout.tsx`
- Create: `frontend/src/app/work-queue/page.tsx`

- [ ] **Step 1: Create the layout** (`frontend/src/app/work-queue/layout.tsx`) — identical to `submissions/layout.tsx`:

```tsx
import { Suspense } from "react";
import { AppShell } from "@/components/layout/AppShell";

export default function WorkQueueLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
    </AppShell>
  );
}
```

- [ ] **Step 2: Create the page** (`frontend/src/app/work-queue/page.tsx`). Three state buckets; each row opens the canonical decision surface `/underwriter/{packet_id}`. "Awaiting info" is reversed to oldest-first.

```tsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useRole } from "@/contexts/AuthContext";
import { authHeaders } from "@/lib/authFetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

interface Proposal {
  id: string;
  packet_id: string;
  venue_id: string;
  state: string;
  proposed_at: string;
  recommendation_snapshot?: {
    should_file?: boolean;
    confidence?: number;
    expected_payout?: { median_usd?: number };
  } | null;
}

async function fetchBucket(status: string, sort?: string): Promise<Proposal[]> {
  const q = new URLSearchParams({ status });
  if (sort) q.set("sort", sort);
  const res = await fetch(`${API_URL}/api/claim-proposals?${q.toString()}`, { headers: authHeaders() });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

function Row({ p, router }: { p: Proposal; router: ReturnType<typeof useRouter> }) {
  const s = p.recommendation_snapshot || {};
  const median = s.expected_payout?.median_usd ?? 0;
  return (
    <button
      onClick={() => router.push(`/underwriter/${p.packet_id}`)}
      className="card"
      style={{ display: "flex", alignItems: "center", gap: "var(--space-md)", width: "100%",
               textAlign: "left", cursor: "pointer", minHeight: 44 }}
      aria-label={`Open decision surface for ${p.venue_id}`}
    >
      <span style={{ flex: 1, minWidth: 0 }} className="text-sm">{p.venue_id}</span>
      <span className={`badge ${s.should_file ? "badge-success" : "badge-warning"}`}>
        {s.should_file ? "FILE" : "review"}
      </span>
      <span className="font-mono text-xs text-muted">conf {Math.round((s.confidence ?? 0) * 100)}%</span>
      <span className="font-mono text-xs">${Number(median).toLocaleString()} median</span>
    </button>
  );
}

export default function WorkQueuePage() {
  const router = useRouter();
  const { isSignedIn, isLoaded } = useAuth();
  const role = useRole();
  const [toDecide, setToDecide] = useState<Proposal[]>([]);
  const [awaiting, setAwaiting] = useState<Proposal[]>([]);
  const [ready, setReady] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.push("/login");
  }, [isLoaded, isSignedIn, router]);

  useEffect(() => {
    (async () => {
      const [decide, info, appr] = await Promise.all([
        fetchBucket("pending_broker_review", "priority"),
        fetchBucket("needs_more_info"),
        fetchBucket("approved"),
      ]);
      setToDecide(decide);
      // endpoint returns proposed_at desc; awaiting-info wants oldest-first.
      setAwaiting([...info].reverse());
      setReady(appr);
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="page-loading"><div className="loading-spinner" /></div>;

  const Section = ({ title, hint, rows }: { title: string; hint: string; rows: Proposal[] }) => (
    <section className="mb-xl">
      <div className="flex items-center gap-sm mb-md">
        <h2 className="text-sm font-semibold text-secondary" style={{ margin: 0 }}>{title}</h2>
        <span className="text-xs text-muted">{hint}</span>
        {rows.length > 0 && <span className="text-xs" style={{ color: "var(--accent-ink)" }}>{rows.length}</span>}
      </div>
      {rows.length === 0
        ? <div className="text-xs text-muted">Nothing here.</div>
        : <div className="flex flex-col gap-sm">{rows.map((p) => <Row key={p.id} p={p} router={router} />)}</div>}
    </section>
  );

  return (
    <div className="theme-broker min-h-screen p-xl">
      <header className="mb-xl">
        <h1 className="glow-text mb-xs">Work Queue</h1>
        <p className="text-sm text-secondary">Triage and decide — highest priority first; aging items surface automatically.</p>
      </header>
      <Section title="To decide" hint="pending broker review · value + urgency" rows={toDecide} />
      <Section title="Awaiting info" hint="you asked the operator · oldest first" rows={awaiting} />
      <Section title="Ready to file" hint="approved · confirm FNOL" rows={ready} />
    </div>
  );
}
```

(`theme-broker`, `.card`, `.badge-*`, `.font-mono`, `.text-muted`, `.glow-text`, `.page-loading`, `.loading-spinner` are all existing classes — confirm against `frontend/src/app/styles.css` and an existing page like `claim-proposals/page.tsx`; adjust class names to match if any differ.)

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → no new errors in `work-queue/`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/work-queue
git commit -F- <<'EOF'
feat(web): broker Work Queue — one decision surface, grouped by state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: D1 redirects — collapse the duplicate decision surfaces

**Files:**
- Modify: `frontend/src/app/claim-proposals/page.tsx`
- Modify: `frontend/src/app/claim-proposals/[packetId]/page.tsx`
- Modify: `frontend/src/app/underwriter/page.tsx`

- [ ] **Step 1: Redirect the claim-proposals index** — replace the entire body of `frontend/src/app/claim-proposals/page.tsx` with:

```tsx
import { redirect } from "next/navigation";

// D1: the broker inbox is now the Work Queue. This route 301s there.
export default function ClaimProposalsIndexRedirect() {
  redirect("/work-queue");
}
```

- [ ] **Step 2: Redirect the duplicate decision page** — replace the entire body of `frontend/src/app/claim-proposals/[packetId]/page.tsx` with:

```tsx
import { redirect } from "next/navigation";

// D1: the canonical decision surface is /underwriter/[id] (packet-keyed).
export default function ClaimProposalDecisionRedirect({
  params,
}: {
  params: { packetId: string };
}) {
  redirect(`/underwriter/${params.packetId}`);
}
```

(If the project's Next version types `params` as a Promise, match the signature already used by `underwriter/[id]/page.tsx` — read it and mirror.)

- [ ] **Step 3: Redirect the underwriter index** — replace the entire body of `frontend/src/app/underwriter/page.tsx` with:

```tsx
import { redirect } from "next/navigation";

// D1: the broker's queue entry point is the Work Queue; the bare /underwriter
// index is no longer a destination. /underwriter/[id] (a specific packet) stays.
export default function UnderwriterIndexRedirect() {
  redirect("/work-queue");
}
```

- [ ] **Step 4: Repoint the incident-detail proposal badge link.** In `frontend/src/app/incidents/[id]/page.tsx`, the packet `PROPOSAL_BADGE` link targets `/claim-proposals/${pkt.id}`. Since that now redirects, point it straight at the canonical surface to avoid a double hop. Change the `href` from `` `/claim-proposals/${pkt.id}` `` to `` `/underwriter/${pkt.id}` ``.

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && npx tsc --noEmit
git add "frontend/src/app/claim-proposals/page.tsx" "frontend/src/app/claim-proposals/[packetId]/page.tsx" frontend/src/app/underwriter/page.tsx "frontend/src/app/incidents/[id]/page.tsx"
git commit -F- <<'EOF'
feat(web): collapse duplicate decision pages into Work Queue / underwriter (D1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Broker nav spine

**Files:**
- Modify: `frontend/src/components/layout/AppShell.tsx` (`NavLinks`)

The current `NavLinks` builds one role-filtered list (`portfolioItems` / `operationsItems` / `underwritingItems` + `filterByRole`). Replace the **group assembly** so brokers/admins get the workflow spine; operators keep today's items (operator slim nav is Phase 2).

- [ ] **Step 1:** In `NavLinks`, after the existing `Item`/`Group` type declarations and the `venueQuery`/`contextVenueId` derivation, replace the `portfolioItems` / `operationsItems` / `underwritingItems` / `filterByRole` / `groups` block with persona-branched groups:

```tsx
  const isBrokerNav = role === "broker" || role === "admin";

  const groups: Group[] = isBrokerNav
    ? [
        { label: "", items: [{ href: "/dashboard", label: "Home", icon: LayoutDashboard }] },
        { label: "Claims pipeline", items: [
          { href: "/work-queue", label: "Work Queue", icon: Inbox },
          { href: "/claims", label: "Claims", icon: FileSpreadsheet },
        ] },
        { label: "Placement", items: [
          { href: "/submissions", label: "Submissions", icon: FileSearch },
          { href: "/policies", label: "Policies", icon: FileSpreadsheet },
          { href: "/renewals", label: "Renewals", icon: RefreshCw },
        ] },
        { label: "Book", items: [
          { href: "/venues", label: "Venues", icon: Building2 },
          { href: "/policy-requests", label: "Requests", icon: Inbox },
        ] },
        { label: "System", items: [
          { href: "/ingestion", label: "Ingestion", icon: Database },
          { href: `/alerts${venueQuery}`, label: "Alerts", icon: Bell },
        ] },
      ]
    : [
        { label: "Portfolio", items: [
          { href: `/dashboard${venueQuery}`, label: "Dashboard", icon: LayoutDashboard },
          { href: "/venues", label: "Venues", icon: Building2 },
          { href: "/coverage", label: "Coverage", icon: ShieldCheck },
          ...(contextVenueId ? [{ href: `/terminal/${contextVenueId}`, label: "Live Terminal", icon: Activity } as Item] : []),
        ] },
        { label: "Operations", items: [
          { href: `/incidents${venueQuery}`, label: "Incidents", icon: AlertTriangle },
          { href: `/compliance${venueQuery}`, label: "Compliance", icon: CheckSquare },
          { href: `/alerts${venueQuery}`, label: "Alerts", icon: Bell },
        ] },
      ].filter((g) => g.items.length > 0);
```

This removes `Tasks`, `Reports` (`/underwriter` index — now a redirect), and the standalone broker `Incidents`/`Compliance` from the broker spine. All icons used (`LayoutDashboard, Inbox, FileSpreadsheet, FileSearch, RefreshCw, Building2, Database, Bell, ShieldCheck, Activity, AlertTriangle, CheckSquare`) are already imported in `AppShell.tsx` — confirm and add any missing to the lucide import.

- [ ] **Step 2:** The render loop already maps `groups → group.items`. Confirm a group with `label: ""` renders without a header label (the existing `{variant !== "rail" && <div className="sidebar-nav__group-label">{group.label}</div>}` will render an empty label div — guard it: change to `{variant !== "rail" && group.label && <div className="sidebar-nav__group-label">{group.label}</div>}`).

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/layout/AppShell.tsx
git commit -F- <<'EOF'
feat(web): task-oriented broker nav spine (Work Queue + grouped clusters)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Broker home triage strip

**Files:**
- Modify: `frontend/src/app/dashboard/page.tsx`

Add a counts-only "⚡ Needs you" strip above the existing Book content, broker-only. Counts: pending proposals (API), expiring renewals (from the portfolio the dashboard already fetches — venues with `renewal_date` within 60 days), open requests (API).

- [ ] **Step 1:** Add a self-contained component at the bottom of `dashboard/page.tsx` (before the default export, or in the same file):

```tsx
function BrokerTriageStrip({ expiringRenewals }: { expiringRenewals: number }) {
  const [pending, setPending] = useState(0);
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    (async () => {
      const [p, r] = await Promise.all([
        fetch(`${API_URL}/api/claim-proposals?status=pending_broker_review`, { headers: authHeaders() }),
        fetch(`${API_URL}/api/policy-requests`, { headers: authHeaders() }),
      ]);
      if (p.ok) { const d = await p.json(); setPending(Array.isArray(d) ? d.length : 0); }
      if (r.ok) {
        const d = await r.json();
        const open = Array.isArray(d) ? d.filter((x: any) => ["requested", "pending", "open"].includes(x.status)).length : 0;
        setRequests(open);
      }
    })();
  }, []);
  const total = pending + expiringRenewals + requests;
  if (total === 0) return null;
  const Cell = ({ n, label, href }: { n: number; label: string; href: string }) =>
    n > 0 ? (
      <Link href={href} className="card" style={{ flex: 1, minWidth: 150, textDecoration: "none", minHeight: 44 }}>
        <div className="font-mono" style={{ fontSize: "1.25rem", color: "var(--accent-ink)" }}>{n}</div>
        <div className="text-xs text-muted">{label}</div>
      </Link>
    ) : null;
  return (
    <section className="mb-lg" aria-label="Needs you">
      <div className="text-xs uppercase tracking-wide text-secondary mb-sm">⚡ Needs you · {total}</div>
      <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
        <Cell n={pending} label="proposals to decide" href="/work-queue" />
        <Cell n={expiringRenewals} label="renewals expiring (60d)" href="/renewals" />
        <Cell n={requests} label="open requests" href="/policy-requests" />
      </div>
    </section>
  );
}
```

- [ ] **Step 2:** Where the dashboard computes the broker portfolio (the `PortfolioVenue[]` it already fetches), derive the expiring count and render the strip at the top of the broker view. Compute:

```tsx
const expiringRenewals = portfolio.filter((v) => {
  if (!v.renewal_date) return false;
  const d = new Date(v.renewal_date).getTime() - Date.now();
  return d >= 0 && d <= 60 * 24 * 60 * 60 * 1000;
}).length;
```

and render `{(role === "broker" || role === "admin") && <BrokerTriageStrip expiringRenewals={expiringRenewals} />}` immediately inside the main return, above the existing stat strip / venue grid. (Match the variable name the dashboard uses for its venue list — read the file; it may be `venues`, `portfolio`, or similar. `role` comes from the existing `useRole()`.)

- [ ] **Step 3: Typecheck + design-lint**

```bash
cd frontend && npx tsc --noEmit
cd "C:/Users/aakas/Documents/JobHunt/ThirdSpaceRisk" && node scripts/design-lint.mjs
```
Expected: no new tsc errors; design-lint `0 error(s)`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/dashboard/page.tsx
git commit -F- <<'EOF'
feat(web): broker home triage strip (proposals / renewals / requests)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Verify + push

- [ ] **Step 1: Backend gate** — `cd backend && rm -f database.db && python -m pytest -q -p no:cacheprovider` → all pass.
- [ ] **Step 2: Web gate** — `cd frontend && npx tsc --noEmit` (no new errors) and `node scripts/design-lint.mjs` (0 errors).
- [ ] **Step 3: Manual smoke** (local stack, see `project_local_browser_verify_recipe`): as a broker, the sidebar shows Home · Work Queue · Claims · Submissions/Policies/Renewals · Venues/Requests · Ingestion/Alerts; `/work-queue` lists pending proposals priority-ordered and a row opens `/underwriter/{packet_id}`; `/claim-proposals` and `/claim-proposals/{packetId}` and `/underwriter` (index) redirect correctly; the dashboard shows the triage strip with non-zero counts. As an operator, the nav is unchanged.
- [ ] **Step 4: Push** — `git push origin main`.

---

## Out of scope (Phase 2+)
- Operator slim nav + operator home (spec §D/§E) — Phase 2.
- Shared-screen persona-branch audit for Compliance/Alerts (spec §F) — Phase 3.
- Mobile parity — Phase 4.
- Heavy visual polish of the Work Queue rows beyond existing tokens — fold into a `ui-ux-pro-max` pass during/after Task 2 if the rows read as too dense.
