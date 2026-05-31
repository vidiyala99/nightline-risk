# Per-persona IA — Phase 2 (Operator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator a slim, venue-centric nav and a home that answers "what's due from me?" and "what happened to my reports?" — adding a "needs you" strip and a report-status feed to the existing venue-health home.

**Architecture:** The operator dashboard already renders venue health (`OperatorFloor`: occupancy, infra, risk, coverage) + onboarding. Phase 2 adds (1) a venue-level incident-status **feed endpoint** (avoids an N+1 of per-incident `claim-status` calls), (2) a "needs you" strip + per-incident status stepper on the home, and (3) a slimmed operator nav spine. Broker surfaces are untouched.

**Tech Stack:** Python / FastAPI / SQLModel (backend), Next.js / React / TS (web). pytest TDD; `tsc --noEmit` + `node scripts/design-lint.mjs` gate web.

**Spec:** `docs/superpowers/specs/2026-05-31-per-persona-ia-homes-and-nav-design.md` (Phase 2 = §D operator home, §E operator nav). Builds on Plan 1 (`GET /api/incidents/{id}/claim-status`, the chain logic) and Phase 1 (the broker nav spine; operator branch was left unchanged).

**Key facts (verified):**
- The per-incident chain logic lives in `incident_claim_status` (`backend/app/api/v1/incidents.py`): incident → latest `UnderwritingPacket` by `incident_id` (`order_by(generated_at.desc())`) → latest `ClaimProposal` by `packet_id` (`order_by(proposed_at.desc())`) → `Claim` by `proposal_id`, else by `incident_id`. Imports already present: `select, IncidentRecord, require_venue_access, error_response, Header, Depends, get_session`; models `UnderwritingPacket, ClaimProposal, Claim`.
- `ClaimProposal.state`: `pending_broker_review → approved → filed_with_carrier → paid|denied`, `→ rejected_by_broker`, `→ needs_more_info`. `Claim.status` terminals: `closed_paid|closed_denied|closed_dropped`.
- The stepper lit/unlit logic already exists in `frontend/src/app/incidents/[id]/page.tsx` (Reported→Sent→Approved→Filed→Resolved) — reuse the same booleans.
- Operator dashboard (`frontend/src/app/dashboard/page.tsx`): `tenantId` = the operator's venue id; it already fetches `/api/venues/{id}/live` (`liveState`, with `compliance_queue?: Array<unknown>`), `/risk-score`, `/quote`, `/incidents?status=open`. `OperatorFloor` renders the venue-health hero. `useRole()`/`useTenantId()` available. `authHeaders()` on every fetch.
- Operator nav today (`AppShell.tsx` non-broker branch): Portfolio[Dashboard(`/dashboard?venue=`), Venues, Coverage, Live Terminal(if `contextVenueId`)] + Operations[Incidents, Compliance, Alerts]. The render maps groups with `key={group.label}` and guards empty labels with `group.label && ...`.
- The e2e `DashboardPage.dashboardNavItem` regex already accepts `Home|The Book|Dashboard` (from the Phase-1 e2e fix), so renaming the operator nav label to "Home" won't break it. `venues.spec.ts` has an operator Venues test — see Task 4.

---

## File Structure

**Backend — modify:**
- `backend/app/api/v1/incidents.py` — add `GET /venues/{venue_id}/incident-status-feed`.
- `backend/tests/test_claim_routes.py` — feed-endpoint tests.

**Web — modify:**
- `frontend/src/components/layout/AppShell.tsx` — slim the operator nav branch.
- `frontend/src/app/dashboard/page.tsx` — operator "needs you" strip + report-status feed.
- `frontend/e2e/venues.spec.ts` — operator path to /venues (Venues no longer in nav).

---

## Task 1: Venue incident-status feed endpoint

**Files:**
- Modify: `backend/app/api/v1/incidents.py`
- Test: `backend/tests/test_claim_routes.py`

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_claim_routes.py`; it has `TestClient(app)`, `_op_headers()`, `get_session`, and seed helpers). Reuse the Plan-1 `_seed_approved_proposal_routes(session, sfx)` helper (seeds incident `in-<sfx>` + packet + approved proposal at `elsewhere-brooklyn`):

```python
def test_incident_status_feed_for_venue():
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "feed")  # incident in-feed, proposal approved
        with TestClient(app) as client:
            r = client.get("/api/venues/elsewhere-brooklyn/incident-status-feed", headers=_op_headers())
        assert r.status_code == 200, r.text
        rows = r.json()
        row = next((x for x in rows if x["incident_id"] == "in-feed"), None)
        assert row is not None
        assert row["proposal_state"] == "approved"
        assert row["claim_status"] is None
        assert "summary" in row and "occurred_at" in row and "status" in row
    finally:
        session.close()


def test_incident_status_feed_rejects_cross_venue():
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "feedx")
        with TestClient(app) as client:
            # token scoped to a different venue
            from app.auth import create_token
            other = {"Authorization": f"Bearer {create_token('u-x','x@x.com','venue_operator','house-of-yes')}"}
            r = client.get("/api/venues/elsewhere-brooklyn/incident-status-feed", headers=other)
        assert r.status_code == 403
    finally:
        session.close()
```
(Match the file's actual cross-venue rejection pattern — mirror `test_claim_status_rejects_cross_venue` from Plan 1 if its helper differs.)

- [ ] **Step 2: Run to verify fail** — `cd backend && python -m pytest tests/test_claim_routes.py -q -p no:cacheprovider -k incident_status_feed` → 404 (route missing).

- [ ] **Step 3: Implement** — add to `backend/app/api/v1/incidents.py`:

```python
@router.get("/venues/{venue_id}/incident-status-feed")
def venue_incident_status_feed(
    venue_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> list[dict]:
    """Per-incident status chain for a venue's incidents, newest first.
    Resolves incident -> latest packet -> latest proposal -> claim in one call so
    the operator home renders a report feed without an N+1 of /claim-status hits.
    Venue-gated (operators see only their own venue)."""
    require_venue_access(venue_id, authorization, session)
    from app.models import UnderwritingPacket, ClaimProposal, Claim
    incidents = session.exec(
        select(IncidentRecord)
        .where(IncidentRecord.venue_id == venue_id)
        .order_by(IncidentRecord.occurred_at.desc())
    ).all()
    feed: list[dict] = []
    for inc in incidents:
        packet = session.exec(
            select(UnderwritingPacket)
            .where(UnderwritingPacket.incident_id == inc.id)
            .order_by(UnderwritingPacket.generated_at.desc())
        ).first()
        proposal = None
        if packet is not None:
            proposal = session.exec(
                select(ClaimProposal)
                .where(ClaimProposal.packet_id == packet.id)
                .order_by(ClaimProposal.proposed_at.desc())
            ).first()
        claim = None
        if proposal is not None:
            claim = session.exec(select(Claim).where(Claim.proposal_id == proposal.id)).first()
        if claim is None:
            claim = session.exec(select(Claim).where(Claim.incident_id == inc.id)).first()
        feed.append({
            "incident_id": inc.id,
            "summary": inc.summary,
            "occurred_at": inc.occurred_at.isoformat() if hasattr(inc.occurred_at, "isoformat") else str(inc.occurred_at),
            "status": inc.status,
            "proposal_state": proposal.state if proposal else None,
            "claim_status": claim.status if claim else None,
        })
    return feed
```

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_claim_routes.py -q -p no:cacheprovider` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/incidents.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(incidents): GET /venues/{id}/incident-status-feed (venue report feed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Slim operator nav spine

**Files:**
- Modify: `frontend/src/components/layout/AppShell.tsx` (`NavLinks`, non-broker branch)

- [ ] **Step 1:** Replace the operator (non-`isBrokerNav`) branch of the `groups` array with the slim venue-centric spine. The home item is labelled "Home"; Venues is dropped from nav (reachable from the home header — Task 3); Alerts moves to a "System" group:

```tsx
    : [
        { label: "", items: [
          { href: `/dashboard${venueQuery}`, label: "Home", icon: LayoutDashboard },
        ] },
        { label: "My venue", items: [
          { href: `/incidents${venueQuery}`, label: "Incidents", icon: AlertTriangle },
          { href: `/compliance${venueQuery}`, label: "Compliance", icon: CheckSquare },
          { href: "/coverage", label: "Coverage", icon: ShieldCheck },
          ...(contextVenueId ? [{ href: `/terminal/${contextVenueId}`, label: "Live Terminal", icon: Activity } as Item] : []),
        ] },
        { label: "System", items: [
          { href: `/alerts${venueQuery}`, label: "Alerts", icon: Bell },
        ] },
      ]
```

- [ ] **Step 2:** The render maps `key={group.label}`. The operator branch now has ONE empty-label group ("Home") — same as the broker branch, so no duplicate-key collision. Confirm the existing `key={group.label}` is still safe (only one `""` label per persona). If a future group also uses `""`, change the map key to `key={group.label || `g${idx}`}` — but for now it is safe; do NOT change it unless tsc/console warns.

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → no new errors. All icons (`LayoutDashboard, AlertTriangle, CheckSquare, ShieldCheck, Activity, Bell`) are already imported.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/layout/AppShell.tsx
git commit -F- <<'EOF'
feat(web): slim operator nav — Home + My venue (Incidents/Compliance/Coverage/Terminal) + Alerts

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Operator home — "needs you" strip + report-status feed

**Files:**
- Modify: `frontend/src/app/dashboard/page.tsx`

The venue-health hero already exists (`OperatorFloor`). Add, above it (in the operator branch), a "needs you" strip and a report-status feed. Reuse the stepper lit/unlit logic from `incidents/[id]/page.tsx`.

- [ ] **Step 1: Add types + a hoisted stepper + the feed component** near the other dashboard components (module scope, not inside a component):

```tsx
interface FeedRow {
  incident_id: string;
  summary: string;
  occurred_at: string;
  status: string;
  proposal_state: string | null;
  claim_status: string | null;
}

function reportSteps(r: FeedRow) {
  const ps = r.proposal_state ?? "";
  return [
    { label: "Reported", lit: true },
    { label: "Sent", lit: !!r.proposal_state },
    { label: "Approved", lit: ["approved", "filed_with_carrier", "paid", "denied"].includes(ps) },
    { label: "Filed", lit: ["filed_with_carrier", "paid", "denied"].includes(ps) || !!r.claim_status },
    { label: "Resolved", lit: ["paid", "denied"].includes(ps) || ["closed_paid", "closed_denied", "closed_dropped"].includes(r.claim_status ?? "") },
  ];
}

function ReportFeedRow({ r }: { r: FeedRow }) {
  const steps = reportSteps(r);
  const branch = r.proposal_state === "rejected_by_broker" ? "Declined by broker"
    : r.proposal_state === "needs_more_info" ? "Info requested" : null;
  return (
    <Link href={`/incidents/${r.incident_id}`} className="lc-card" style={{ textDecoration: "none", display: "block" }}>
      <div className="lc-card__inner" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="text-sm" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {r.summary}
        </span>
        <div className="flex items-center" style={{ gap: 8, flexWrap: "wrap" }}>
          {steps.map((s) => (
            <span key={s.label} className="text-xs" style={{ color: s.lit ? "var(--accent-ink)" : "var(--text-muted)" }}>
              {s.lit ? "● " : "○ "}{s.label}
            </span>
          ))}
          {branch && <span className="text-xs" style={{ color: branch === "Info requested" ? "var(--state-warning)" : "var(--state-error)" }}>· {branch}</span>}
        </div>
      </div>
    </Link>
  );
}

function OperatorReportFeed({ venueId, complianceDue }: { venueId: string; complianceDue: number }) {
  const [rows, setRows] = useState<FeedRow[]>([]);
  useEffect(() => {
    if (!venueId) return;
    let cancelled = false;
    (async () => {
      const res = await fetch(`${API_URL}/api/venues/${venueId}/incident-status-feed`, { headers: authHeaders() });
      if (res.ok && !cancelled) { const d = await res.json(); setRows(Array.isArray(d) ? d : []); }
    })();
    return () => { cancelled = true; };
  }, [venueId]);

  const infoRequested = rows.filter((r) => r.proposal_state === "needs_more_info").length;
  const needsYou = complianceDue + infoRequested;

  return (
    <>
      {needsYou > 0 && (
        <section className="mb-lg" aria-label="Needs you">
          <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Needs you · {needsYou}</div>
          <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
            {complianceDue > 0 && (
              <Link href="/compliance" className="lc-card" style={{ flex: 1, minWidth: 150, textDecoration: "none", display: "block" }}>
                <div className="lc-card__inner">
                  <div className="font-mono" style={{ fontSize: "1.25rem", color: "var(--accent-ink)" }}>{complianceDue}</div>
                  <div className="text-xs text-muted">compliance items due</div>
                </div>
              </Link>
            )}
            {infoRequested > 0 && (
              <Link href="/incidents" className="lc-card" style={{ flex: 1, minWidth: 150, textDecoration: "none", display: "block" }}>
                <div className="lc-card__inner">
                  <div className="font-mono" style={{ fontSize: "1.25rem", color: "var(--state-warning)" }}>{infoRequested}</div>
                  <div className="text-xs text-muted">incidents need info</div>
                </div>
              </Link>
            )}
          </div>
        </section>
      )}
      {rows.length > 0 && (
        <section className="mb-lg" aria-label="Your reports">
          <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Your reports — what happened next</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
            {rows.slice(0, 8).map((r) => <ReportFeedRow key={r.incident_id} r={r} />)}
          </div>
        </section>
      )}
    </>
  );
}
```
Confirm `.lc-card`/`.lc-card__inner` are the dashboard's card classes (they are — used by the broker triage strip). Use `var(--accent-ink)` for lit text (never raw lime). The `●/○` glyphs make lit-state non-color-only.

- [ ] **Step 2:** Render it in the operator branch, above `OperatorFloor`. Compliance-due is read from the already-fetched `liveState.compliance_queue` (no new fetch). Insert just before the `{!isBroker && (riskScore || quote || liveState) && (<OperatorFloor .../>)}` block:

```tsx
{!isBroker && tenantId && (
  <OperatorReportFeed
    venueId={(selectedVenueId ?? tenantId)!}
    complianceDue={liveState?.compliance_queue?.length ?? 0}
  />
)}
```
(`selectedVenueId`, `tenantId`, `liveState`, `isBroker` all already exist in the component.)

- [ ] **Step 3:** Since Venues left the nav (Task 2), add a "View venue profile" link in the operator home so the venue page stays reachable. In `OperatorFloor`'s header (or just above the report feed), add:
```tsx
<Link href="/venues" className="lc-link text-xs">View venue profile <ArrowUpRight size={12} aria-hidden="true" /></Link>
```
(`ArrowUpRight` is already imported in the dashboard.)

- [ ] **Step 4: Typecheck + design-lint**
```bash
cd frontend && npx tsc --noEmit
cd "C:/Users/aakas/Documents/JobHunt/ThirdSpaceRisk" && node scripts/design-lint.mjs
```
Expected: no new tsc errors; design-lint `0 error(s)`.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/app/dashboard/page.tsx
git commit -F- <<'EOF'
feat(web): operator home — needs-you strip + report-status feed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: e2e alignment + verify + push

**Files:**
- Modify: `frontend/e2e/venues.spec.ts` (operator Venues path)

- [ ] **Step 1: Grep e2e for operator-nav selectors BEFORE pushing** (the lesson from Phase 1):
```bash
cd "C:/Users/aakas/Documents/JobHunt/ThirdSpaceRisk" && grep -rnE "Venues|Dashboard|sidebar-nav-item" frontend/e2e
```
The operator `venues.spec.ts:19` test reaches the venues page. If it clicks a "Venues" sidebar item (now removed for operators), repoint it to navigate directly: `await page.goto("/venues")` instead of clicking the nav item, then keep the existing assertions (Elsewhere Brooklyn visible, Add Venue button). The broker venues test (`venues.spec.ts:46`) is unaffected (brokers still have Venues in the Book group). Read the spec and make the minimal change.

- [ ] **Step 2: Backend gate** — `cd backend && rm -f database.db && python -m pytest -q -p no:cacheprovider` → all pass.

- [ ] **Step 3: Web gates** — `cd frontend && npx tsc --noEmit` (no new errors) and `node scripts/design-lint.mjs` (0 errors).

- [ ] **Step 4: e2e against deployed prod** (after the push deploys) — `cd frontend && npx playwright test e2e/auth.spec.ts e2e/venues.spec.ts e2e/coverage.spec.ts --project=chromium --reporter=line`. Operator login + venues + coverage must pass. (Coverage/Incidents/Compliance remain in the operator nav, so those nav-click tests still work.)

- [ ] **Step 5: Manual smoke** (local, `project_local_browser_verify_recipe`): as the operator, the sidebar shows Home · [My venue: Incidents/Compliance/Coverage/Live Terminal] · Alerts (no Venues, no Submissions/Policies/Claims/Work Queue); the home shows the venue-health hero + "needs you" strip (when due) + a report-status feed whose steppers light correctly; "View venue profile" reaches /venues.

- [ ] **Step 6: Push** — `git push origin main`. Then confirm the CI e2e run goes green (`gh run list --workflow=e2e.yml`).

---

## Out of scope (later phases)
- Shared-screen persona-branch audit for Compliance/Alerts (spec §F) — Phase 3.
- Mobile parity incl. MobileMoreSheet link/nav repoints — Phase 4.
- Multi-venue operators — out of scope by data model (`tenant_id == venue_id`).
- A dedicated compliance-due list endpoint — Phase 2 sources the count from the already-fetched `liveState.compliance_queue`; if that proves insufficient, add `GET /venues/{id}/compliance` in a follow-up.
