# Carrier Adjudication Desk Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the carrier adjuster desk correct for a risk-bearer — reserve at FNOL, carrier-framed exposure, decoupled deny/close, and a Postgres-safe AI panel.

**Architecture:** Seven findings across backend (`app/api/v1/adjusting.py`, `app/services/adjusting.py`) and frontend (`adjusting/[cid]/page.tsx`, `lib/adjusting.ts`, `lib/claim-tokens.ts`, `components/layout/AppShell.tsx`). Backend behavior + a pure frontend helper are TDD; display changes are verified by build + existing green tests.

**Tech Stack:** FastAPI + SQLModel (pytest), Next.js + React (vitest), Decimal/string money convention.

## Global Constraints

- Money is `Decimal` server-side, **strings** in JSON. Display via `claim-tokens.ts` formatters. (CLAUDE.md)
- Timestamps via `app.time.now_utc`; never `datetime.utcnow`.
- Services never commit — the API layer/test owns commit. (CLAUDE.md)
- Do not break the 62 `test_phase_1.py` pricing characterization tests or the claim-status SoT.
- Backend tests run from `backend/`: `python -m pytest -q`.
- Push directly to `main` (solo repo); commit messages via `git commit -F` (apostrophes break `-m`).
- Indemnity payments require coverage ∈ {covered, reservation_of_rights} — already enforced at `app/services/adjusting.py:126`. Do not remove.

---

### Task 1: F-7 — Postgres JSON-string coercion in the AI incident report

**Files:**
- Modify: `backend/app/api/v1/adjusting.py:29-63` (`_incident_report`) + add helpers near top
- Test: `backend/tests/test_adjusting_report.py` (create)

**Interfaces:**
- Produces: `_as_dict(value) -> dict`, `_as_list(value) -> list` (module-level in `app/api/v1/adjusting.py`); `_incident_report(session, claim) -> dict | None` (behavior change only).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_adjusting_report.py`:

```python
"""F-7 — _incident_report must survive Postgres' JSON-as-string round-trip.
On Postgres, Column(JSON) fields can come back as JSON strings; the unguarded
.get()/len() previously raised and the blanket except swallowed it to None,
silently hiding the entire AI panel."""
import json
from datetime import date

from sqlmodel import Session, SQLModel, create_engine

from app.api.v1.adjusting import _as_dict, _as_list, _incident_report
from app.models import Claim, Policy, UnderwritingPacket, UserRecord, Venue
from app.services.claims import file_fnol

VENUE_ID = "elsewhere-brooklyn"
USER_ID = "u-brk"


def _session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(engine)
    s = Session(engine)
    s.add(Venue(id=VENUE_ID, name="Elsewhere"))
    s.add(UserRecord(id=USER_ID, email="b@x.com", password_hash="x", name="B", role="broker"))
    s.commit()
    return s


def _claim_with_packet(s: Session) -> str:
    s.add(Policy(
        id="pol-1", policy_number="POL-1", submission_id="sub-1", bound_quote_id="q-1",
        venue_id=VENUE_ID, carrier_id="markel-specialty", status="active",
        effective_date=date(2026, 1, 1), expiration_date=date(2027, 1, 1),
        annual_premium="5000.00", commission_amount="750.00", commission_rate="0.15",
        coverage_lines=["gl"], terms_snapshot={}, snapshot_hash="h",
    ))
    s.commit()
    claim = file_fnol(s, policy_id="pol-1", coverage_line="gl",
                      date_of_loss=date(2026, 3, 1), filed_by=USER_ID)
    s.add(UnderwritingPacket(
        id="pkt-1", venue_id=VENUE_ID, incident_id="inc-1", rubric_version_id="rv-1",
        status="reviewed", snapshot_hash="h",
        risk_signals={"severity": "high", "confidence": 0.85},
        memo={"summary": "Documented A&B."}, citation_ids=["cit-1"],
    ))
    claim.defense_package_id = "pkt-1"
    s.add(claim)
    s.commit()
    return claim.id


def test_as_dict_and_as_list_coerce_json_strings():
    assert _as_dict('{"severity": "high"}') == {"severity": "high"}
    assert _as_dict({"a": 1}) == {"a": 1}
    assert _as_dict("not json") == {} and _as_dict(None) == {}
    assert _as_list('["a", "b"]') == ["a", "b"]
    assert _as_list(["x"]) == ["x"]
    assert _as_list("nope") == [] and _as_list(None) == []


def test_incident_report_survives_json_strings():
    s = _session()
    cid = _claim_with_packet(s)
    # Force the Postgres shape: JSON columns come back as STRINGS. Reassign on
    # the identity-mapped instance; _incident_report re-gets the same object.
    pkt = s.get(UnderwritingPacket, "pkt-1")
    pkt.risk_signals = json.dumps({"severity": "high", "confidence": 0.85})
    pkt.memo = json.dumps({"summary": "Documented A&B."})
    pkt.citation_ids = json.dumps(["cit-1"])
    s.add(pkt)
    s.flush()

    rep = _incident_report(s, s.get(Claim, cid))
    assert rep is not None                      # pre-fix: None (swallowed)
    assert rep["severity"] == "high"
    assert rep["memo_summary"] == "Documented A&B."
    assert rep["citation_count"] == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_adjusting_report.py -v`
Expected: `test_as_dict_and_as_list_coerce_json_strings` FAILS at import (`cannot import name '_as_dict'`); after helpers exist, `test_incident_report_survives_json_strings` FAILS (`rep is None`).

- [ ] **Step 3: Add coercion helpers**

In `backend/app/api/v1/adjusting.py`, add `import json` to the imports and insert near the top (after the existing imports, before `router = APIRouter()`):

```python
def _as_dict(value) -> dict:
    """Coerce a JSON dict column to a real dict. Postgres can return Column(JSON)
    fields as JSON-encoded strings where SQLite returns parsed dicts."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (ValueError, TypeError):
            return {}
    return {}


def _as_list(value) -> list:
    """Coerce a JSON list column to a real list (see _as_dict)."""
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except (ValueError, TypeError):
            return []
    return []
```

- [ ] **Step 4: Wire coercion into `_incident_report`**

In `_incident_report`, replace the three unguarded reads:

```python
        rs = packet.risk_signals or {}
```
with
```python
        rs = _as_dict(packet.risk_signals)
```

and in the returned dict change:
```python
            "memo_summary": (packet.memo or {}).get("summary"),
```
to
```python
            "memo_summary": _as_dict(packet.memo).get("summary"),
```
and
```python
            "citation_count": len(packet.citation_ids or []),
```
to
```python
            "citation_count": len(_as_list(packet.citation_ids)),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `python -m pytest tests/test_adjusting_report.py -v`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/api/v1/adjusting.py backend/tests/test_adjusting_report.py
git commit -F - <<'EOF'
fix(carrier): coerce packet JSON at read boundary (F-7)

- _as_dict/_as_list guard risk_signals/memo/citation_ids
- AI incident panel no longer silently vanishes on Postgres
EOF
```

---

### Task 2: F-4 — Decouple deny from auto-close

**Files:**
- Modify: `backend/app/services/adjusting.py:95-101` (`decide_coverage` denied branch) + docstring `:33-42`
- Test: `backend/tests/test_adjusting.py:1-8` (docstring), `:89-94` (rewrite the deny test)

**Interfaces:**
- Consumes: `decide_coverage(session, claim_id, *, decision, rationale, adjuster_id) -> Claim`.
- Produces: `decide_coverage(decision="denied")` now leaves status `under_investigation` and `coverage_decision == "denied"`; does NOT close.

- [ ] **Step 1: Rewrite the failing test**

In `backend/tests/test_adjusting.py`, replace `test_denied_closes_the_claim` (lines 89-94) with:

```python
def test_denied_records_decision_but_does_not_close(make_claim_session):
    # F-4: denying coverage stamps the decision and advances to
    # under_investigation, but the claim stays OPEN (closing is a separate,
    # explicit action — matches dispute/appeal reality).
    s, claim = make_claim_session
    out = decide_coverage(s, claim.id, decision="denied", rationale="A&B exclusion applies", adjuster_id="u-carrier")
    s.commit()
    assert out.coverage_decision == "denied"
    assert out.status == "under_investigation"
    assert not out.status.startswith("closed")
```

Also update the module docstring line 5 from:
```
  - decide_coverage("denied"):  stamps decision fields + closes claim as closed_denied
```
to:
```
  - decide_coverage("denied"):  stamps decision fields + advances notified→under_investigation (claim stays open)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_adjusting.py::test_denied_records_decision_but_does_not_close -v`
Expected: FAIL — `assert out.status == "under_investigation"` (current code closes it to `closed_denied`).

- [ ] **Step 3: Remove the auto-close branch**

In `backend/app/services/adjusting.py`, delete the trailing denied branch (lines 95-101):

```python
    if decision == "denied":
        return close_claim(
            session, claim.id,
            disposition="denied",
            closed_by=adjuster_id,
            decision_source="carrier_desk",
        )
    return claim
```

replacing it with just:

```python
    return claim
```

Then update the function docstring (lines 33-42) — change the `denied` line from:
```
    denied                            — same implicit transitions then close_claim
                                       with disposition='denied' → closed_denied.
```
to:
```
    denied                            — same implicit transitions; stamps the denial
                                       and leaves the claim open. Closing is a
                                       separate explicit action (close_claim_as_carrier).
```

Remove the now-unused `close_claim` import only if no longer referenced — it IS still used by `close_claim_as_carrier` (line 138), so leave the import.

- [ ] **Step 4: Run the adjusting suites to verify green**

Run: `python -m pytest tests/test_adjusting.py tests/test_adjusting_api.py -v`
Expected: all PASS (the rewritten deny test passes; `test_close_claim_as_carrier` still passes — it closes explicitly).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/adjusting.py backend/tests/test_adjusting.py
git commit -F - <<'EOF'
fix(carrier): decouple deny from close (F-4)

- decide_coverage(denied) records decision, leaves claim open
- closing a denied claim is now an explicit close_claim action
EOF
```

---

### Task 3: F-8 + F-9 — Client hint type + context-aware adequacy helper

**Files:**
- Modify: `frontend/src/lib/adjusting.ts:24-29` (`ReserveHint` type)
- Modify: `frontend/src/lib/claim-tokens.ts` (add `reserveAdequacy` after `formatReserveDelta`, ~line 309)
- Test: `frontend/src/lib/claim-tokens.test.ts` (create)

**Interfaces:**
- Produces: `reserveAdequacy(reserve, incurred, hint?) -> { label: string; tone: "success" | "danger" | "neutral" } | null`, where `hint?: { low: string; high: string; chain_ladder_mean?: string } | null`.
- Consumed by: Task 7 (hero adequacy cell).

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/claim-tokens.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { reserveAdequacy } from "./claim-tokens";

const hint = { low: "3000", high: "8000", chain_ladder_mean: "5500" };

describe("reserveAdequacy", () => {
  it("flags below-advisory as danger when no money paid", () => {
    expect(reserveAdequacy("1000", "0", hint)).toEqual({
      label: expect.stringContaining("Below advisory"),
      tone: "danger",
    });
  });

  it("flags within-advisory as neutral", () => {
    expect(reserveAdequacy("5000", "0", hint)?.tone).toBe("neutral");
  });

  it("flags above-advisory as success", () => {
    expect(reserveAdequacy("9000", "0", hint)?.tone).toBe("success");
  });

  it("switches to incurred-delta once money is paid", () => {
    // reserve 10000 vs incurred 4000 -> over-reserved headroom (success)
    expect(reserveAdequacy("10000", "4000", hint)?.tone).toBe("success");
    // reserve 3000 vs incurred 5000 -> gap (danger)
    expect(reserveAdequacy("3000", "5000", hint)?.tone).toBe("danger");
  });

  it("returns null with no hint and no money paid", () => {
    expect(reserveAdequacy("1000", "0", null)).toBeNull();
    expect(reserveAdequacy("1000", "0", undefined)).toBeNull();
  });

  it("returns null on unparseable reserve", () => {
    expect(reserveAdequacy("", "0", hint)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/lib/claim-tokens.test.ts`
Expected: FAIL — `reserveAdequacy` is not exported.

- [ ] **Step 3: Implement the helper**

Append to `frontend/src/lib/claim-tokens.ts` (after `formatReserveDelta`):

```ts
/**
 * Context-aware reserve adequacy (F-9). Before any money is paid, the model is
 * the only benchmark: compare the reserve to the advisory low–high band. Once
 * payments accrue, switch to reserve-vs-incurred headroom/gap. Returns null
 * when there is no usable benchmark.
 */
export function reserveAdequacy(
  reserve: string | number,
  incurred: string | number,
  hint?: { low: string; high: string; chain_ladder_mean?: string } | null,
): { label: string; tone: "success" | "danger" | "neutral" } | null {
  const r = typeof reserve === "number" ? reserve : parseFloat(reserve);
  const i = typeof incurred === "number" ? incurred : parseFloat(incurred);
  if (Number.isNaN(r)) return null;

  // Money has moved → reserve vs incurred (same epsilon as formatReserveDelta).
  if (!Number.isNaN(i) && i >= 0.005) {
    return formatReserveDelta(r, i);
  }

  // FNOL / no money paid → reserve vs advisory band.
  if (!hint) return null;
  const low = parseFloat(hint.low);
  const high = parseFloat(hint.high);
  if (Number.isNaN(low) || Number.isNaN(high)) return null;
  const band = `${formatLedgerMoney(low)}–${formatLedgerMoney(high)}`;
  if (r < low) return { label: `Below advisory (${band})`, tone: "danger" };
  if (r > high) return { label: `Above advisory (${band})`, tone: "success" };
  return { label: `Within advisory (${band})`, tone: "neutral" };
}
```

- [ ] **Step 4: Add `chain_ladder_mean` to the client hint type**

In `frontend/src/lib/adjusting.ts`, extend `ReserveHint` (lines 24-29):

```ts
export interface ReserveHint {
  low: string;
  high: string;
  severity_band: string;
  basis: string;
  chain_ladder_mean?: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/lib/claim-tokens.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/claim-tokens.ts frontend/src/lib/claim-tokens.test.ts frontend/src/lib/adjusting.ts
git commit -F - <<'EOF'
feat(carrier): reserve adequacy helper + chain-ladder hint type (F-8, F-9)

- reserveAdequacy: advisory band pre-payment, incurred delta after
- ReserveHint carries chain_ladder_mean the backend already returns
EOF
```

---

### Task 4: F-2 — Reframe the recommendation for a risk-bearer

**Files:**
- Modify: `frontend/src/app/adjusting/[cid]/page.tsx:841-848` (netEv computation), `:1018-1048` (Net EV row + memo label)

**Interfaces:**
- Consumes: `incidentReport.recommendation` (`net_expected_value_usd`, `probability`), `incidentReport.memo_summary`.

- [ ] **Step 1: Reframe the Net EV computation**

In `page.tsx`, replace the netEv block (lines 841-847):

```tsx
        const netEvRaw = rec?.net_expected_value_usd ?? 0;
        const netEvStr =
          rec != null
            ? (netEvRaw >= 0 ? "+" : "−") +
              "$" +
              Math.abs(netEvRaw).toLocaleString()
            : null;
```

with (carrier framing — exposure is a cost, not a gain; no `+`):

```tsx
        const exposureRaw = rec?.net_expected_value_usd ?? 0;
        const exposureStr =
          rec != null ? "$" + Math.abs(exposureRaw).toLocaleString() : null;
        // Carrier semantics: higher exposure = more loss = warning/error tone.
        const exposureColor =
          exposureRaw > 0 ? "var(--state-error)" : "var(--state-warning)";
```

- [ ] **Step 2: Relabel and recolor the Net EV row**

In the Net EV row (lines 1018-1033), change the label text `Net EV` to `Indemnity exposure (EV)`, and replace the value span's `color` and content:

```tsx
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontVariantNumeric: "tabular-nums",
                        fontSize: "var(--text-sm)",
                        fontWeight: 700,
                        color: exposureColor,
                      }}
                    >
                      {exposureStr}
                    </span>
```

(Delete the old `netEvRaw >= 0 ? success : error` ternary and the `{netEvStr}` reference.)

- [ ] **Step 3: Relabel the probability + memo**

Change the paid-out probability line (line 1047) to read carrier-side:

```tsx
                  {Math.round(rec.probability * 100)}% pay-out likelihood
```

And above the memo paragraph (before line 917's `{incidentReport.memo_summary}`), add a label so the defense framing is explicit:

```tsx
              {incidentReport.memo_summary && (
                <p
                  style={{
                    fontSize: "var(--text-xs)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: "var(--text-secondary)",
                    margin: "0 0 var(--space-xs) 0",
                  }}
                >
                  Insured&apos;s defense posture
                </p>
              )}
```

- [ ] **Step 4: Verify the build compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (no remaining references to `netEvStr` / `netEvRaw`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/adjusting/[cid]/page.tsx
git commit -F - <<'EOF'
fix(carrier): reframe recommendation as carrier exposure (F-2)

- Net EV -> Indemnity exposure (EV); tone by magnitude not sign
- memo labelled Insured's defense posture; pay-out likelihood wording
EOF
```

---

### Task 5: F-1 — Contextual carrier persona label

**Files:**
- Modify: `frontend/src/components/layout/AppShell.tsx:35-40` (ROLE_LABELS), `:265` (label render)

**Interfaces:**
- Consumes: `user.role`, `pathname` (already available at line 193).

- [ ] **Step 1: Make the carrier label route-aware**

In `AppShell.tsx`, leave `ROLE_LABELS` for the non-carrier roles but drop the carrier entry's static "Underwriting" suffix to a base:

```ts
const ROLE_LABELS: Record<string, string> = {
  broker: "Broker",
  admin: "Admin",
  venue_operator: "Venue Operator",
  carrier: "Carrier · Underwriting",
};
```
Keep this as-is (it's the default). Then at the render site (line 265), replace:

```tsx
        <span className="user-role">{ROLE_LABELS[user?.role ?? ""] ?? user?.role}</span>
```

with a route-aware override for the carrier persona (the adjuster desk lives under `/adjusting`):

```tsx
        <span className="user-role">
          {user?.role === "carrier" && pathname?.startsWith("/adjusting")
            ? "Carrier · Claims"
            : ROLE_LABELS[user?.role ?? ""] ?? user?.role}
        </span>
```

- [ ] **Step 2: Verify the build compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (`pathname` is in scope at line 193).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/layout/AppShell.tsx
git commit -F - <<'EOF'
fix(carrier): label persona Claims on the adjuster desk (F-1)

- sidebar reads Carrier · Claims under /adjusting, Underwriting elsewhere
EOF
```

---

### Task 6: F-3 — Ungate reserve at FNOL

**Files:**
- Modify: `frontend/src/app/adjusting/[cid]/page.tsx:1124-1126` (coverage card heading), `:1321-1366` (lock banner + action-grid gate)

**Interfaces:**
- Consumes: `hasCoverageDecision`, `indemnityGated` (both already computed).

- [ ] **Step 1: Reframe the coverage-determination heading**

Change line 1124-1126 from:

```tsx
            <h2 style={cardLabel}>
              Coverage determination — required before adjudication
            </h2>
```
to:
```tsx
            <h2 style={cardLabel}>Coverage determination</h2>
```

- [ ] **Step 2: Remove the lock banner and ungate the action grid**

Delete the entire lock-banner block (lines 1326-1355, the `{!hasCoverageDecision && ( <div ... Lock ... )}` card). Then change the action-grid wrapper (lines 1356-1366) from:

```tsx
          <div
            inert={!hasCoverageDecision || undefined}
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "var(--space-md)",
              marginBottom: "var(--space-xl)",
              opacity: hasCoverageDecision ? 1 : 0.45,
              pointerEvents: hasCoverageDecision ? undefined : "none",
              transition: "opacity 150ms",
            }}
          >
```
to (no coverage gate — only indemnity payment-type stays gated, which the payment card already handles via `indemnityGated`):

```tsx
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: "var(--space-md)",
              marginBottom: "var(--space-xl)",
            }}
          >
```

- [ ] **Step 3: Verify build + existing adjusting API tests still green**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.
Run: `cd backend && python -m pytest tests/test_adjusting_api.py -q`
Expected: PASS (server-side indemnity gate unchanged; reserve still works from any open state).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/adjusting/[cid]/page.tsx
git commit -F - <<'EOF'
fix(carrier): allow reserve at FNOL, ungate adjudication grid (F-3)

- remove coverage-first lock; reserve/close/expense/recovery live at notified
- only indemnity payment stays coverage-gated (backend-enforced)
EOF
```

---

### Task 7: F-8 + F-9 render — chain-ladder line + hero adequacy cell

**Files:**
- Modify: `frontend/src/app/adjusting/[cid]/page.tsx:152-180` (`ReserveHintBanner`), `:807-821` (hero KPI band), import `reserveAdequacy`

**Interfaces:**
- Consumes: `reserveAdequacy` (Task 3), `ReserveHint.chain_ladder_mean` (Task 3), `claim.current_reserve`, `totalIncurred`, `reserveHint`.

- [ ] **Step 1: Import the helper**

In `page.tsx`, add `reserveAdequacy` to the existing `claim-tokens` import (lines 18-23):

```tsx
import {
  CLAIM_STATUS_LABEL,
  PAYMENT_TYPE_LABEL,
  PAYMENT_TYPE_TONE,
  formatLedgerMoney,
  reserveAdequacy,
} from "@/lib/claim-tokens";
```

- [ ] **Step 2: Render the chain-ladder line in the hint banner**

In `ReserveHintBanner` (lines 152-180), add a second line after the advisory `<span>` when `hint.chain_ladder_mean` is present:

```tsx
      <span>
        <strong style={{ color: "var(--text-primary)" }}>Advisory suggestion</strong>{" "}
        {formatLedgerMoney(hint.low)}–{formatLedgerMoney(hint.high)} ·{" "}
        <em>{hint.severity_band}</em> · {hint.basis} — does not auto-fill.
        {hint.chain_ladder_mean && (
          <>
            {" "}
            <strong style={{ color: "var(--text-primary)" }}>
              Chain-ladder estimate
            </strong>{" "}
            {formatLedgerMoney(hint.chain_ladder_mean)} (IBNR-aware).
          </>
        )}
      </span>
```

- [ ] **Step 3: Add the adequacy cell to the hero KPI band**

After the "Current reserve" meta-cell (lines 808-813) compute and render adequacy. First, just above the `return` block's KPI band — near where `totalIncurred` is computed (line 713) — add:

```tsx
  const adequacy = reserveAdequacy(
    claim.current_reserve,
    String(totalIncurred),
    reserveHint,
  );
```

Then add a meta-cell after "Total incurred" (after line 820):

```tsx
          {adequacy && (
            <div className="lc-meta-cell">
              <span className="lc-stat-label">Reserve adequacy</span>
              <strong
                style={{
                  fontSize: "var(--text-sm)",
                  color:
                    adequacy.tone === "danger"
                      ? "var(--state-error)"
                      : adequacy.tone === "success"
                      ? "var(--state-success)"
                      : "var(--text-secondary)",
                }}
              >
                {adequacy.label}
              </strong>
            </div>
          )}
```

- [ ] **Step 4: Verify the build compiles**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full frontend unit suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (including `claim-tokens.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/adjusting/[cid]/page.tsx
git commit -F - <<'EOF'
feat(carrier): surface chain-ladder estimate + reserve adequacy (F-8, F-9)

- hint banner shows IBNR-aware chain-ladder mean
- hero shows Below/Within/Above advisory, then headroom/gap once paid
EOF
```

---

## Final verification

- [ ] Run full backend suite: `cd backend && python -m pytest -q` — all green.
- [ ] Run full frontend unit suite: `cd frontend && npx vitest run` — all green.
- [ ] `cd frontend && npx tsc --noEmit` — clean.
- [ ] Push: `git push origin main`.

## Self-review notes

- **Spec coverage:** F-1→Task 5, F-2→Task 4, F-3→Task 6, F-4→Task 2, F-7→Task 1, F-8→Tasks 3+7, F-9→Tasks 3+7. All covered. F-5/F-10/F-11 explicitly out of scope per spec.
- **Type consistency:** `reserveAdequacy(reserve, incurred, hint?)` signature is identical in Task 3 (def), the test, and Task 7 (call). `ReserveHint.chain_ladder_mean?` added in Task 3, consumed in Task 7. `_as_dict`/`_as_list` defined and imported by name in Task 1.
- **Ordering:** backend (1,2) is independent; Task 3 (helper+type) precedes Task 7 (its only consumer); Tasks 4,5,6 are independent display changes.
