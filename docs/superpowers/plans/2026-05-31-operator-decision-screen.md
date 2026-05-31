# Operator Decision Screen Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the operator's incident screen into a deductible-aware "File or pay out of pocket?" decision explainer, plus a status timeline and the ability to add evidence to an existing incident.

**Architecture:** Make the claim recommendation deductible-aware (it reads the venue's active-policy per-line deductible), expose the file-vs-pay breakdown in the payload, and render it as a two-path card. Add a venue-gated `claim-status` read for the status timeline, and a `409`-guarded evidence-append. Task 1 first fixes a latent Plan-1 bug: coverage lines are SHORT codes (`gl`/`liquor`), not the long forms the FNOL mapping used.

**Tech Stack:** Python / FastAPI / SQLModel (backend), Next.js / React / TS (web). pytest TDD.

**Spec:** `docs/superpowers/specs/2026-05-31-persona-correct-claim-loop-design.md` (Parts B + C).

**Key facts (verified):**
- Canonical coverage-line codes are SHORT: `gl`, `liquor`, `assault_battery`, `property`, `wc`, `epli`, `cyber`, `umbrella` (`app/seed_carriers.py::COVERAGE_LINES`). `Policy.coverage_lines` holds these; `file_fnol` rejects a `coverage_line ∉ policy.coverage_lines`.
- Per-line deductible path: `policy.terms_snapshot["premium_breakdown"]["lines"][<line_id>]["deductible"]` — a JSON money string; parse with `app.money.json_to_usd`.
- `recommend_claim_filing(*, risk_signal, incident, venue_prior_claim_count=0) -> ClaimRecommendation` and `recommendation_to_dict(rec)` live in `app/claim_recommendation.py`. `ClaimRecommendation` has `expected_payout` (PayoutRange low/median/high int usd), `expected_premium_impact` (annual/duration/cumulative), `net_expected_value_usd`, `probability`, `confidence`, `should_file`.

---

## File Structure

**Backend — modify:**
- `backend/app/services/fnol.py` — fix `RISK_TYPE_TO_COVERAGE` to short codes; add `venue_line_deductible`.
- `backend/app/claim_recommendation.py` — deductible-aware math + breakdown fields.
- `backend/app/claim_routing.py` — `recommendation_for_packet` passes the deductible.
- `backend/app/api/v1/incidents.py` — new `GET /incidents/{id}/claim-status`; `409` guard on evidence append (in `app/api/v1/evidence.py`).

**Web — modify:**
- `frontend/src/app/incidents/[id]/page.tsx` — decision explainer card (B2), status timeline (B3), add-evidence (C).

---

## Task 1: Fix coverage-line codes to short form (Plan-1 bug)

**Files:**
- Modify: `backend/app/services/fnol.py` (`RISK_TYPE_TO_COVERAGE`)
- Test: `backend/tests/test_fnol.py`

`resolve_fnol_defaults` maps risk type → coverage line, but used long forms (`general_liability`) while real policies use `gl`. `file_fnol` validates `coverage_line ∈ policy.coverage_lines`, so a real-policy FNOL would reject.

- [ ] **Step 1: Write the failing test** (append to `backend/tests/test_fnol.py`; it has `_session`/`_proposal`). NOTE: the existing `_proposal` seeds a policy with `coverage_lines=["general_liability"]` — update that helper's Policy `coverage_lines` to `["gl"]` so it matches reality, and any assertion expecting `"general_liability"` to `"gl"`.

```python
def test_coverage_line_is_short_code():
    s = _session(); p = _proposal(s)   # premises_liability incident
    d = resolve_fnol_defaults(s, p)
    assert d["coverage_line"] == "gl"   # short code, matches real Policy.coverage_lines
```

- [ ] **Step 2: Run to verify fail** — `cd backend && python -m pytest tests/test_fnol.py::test_coverage_line_is_short_code -q` → asserts `general_liability != gl`.

- [ ] **Step 3: Implement** — in `backend/app/services/fnol.py`, replace `RISK_TYPE_TO_COVERAGE`:

```python
RISK_TYPE_TO_COVERAGE = {
    "premises_liability": "gl",
    "altercation_event": "gl",
    "medical_emergency": "gl",
    "crowd_management": "gl",
    "property_damage": "property",
    "liquor_liability": "liquor",
}
```
Default stays `"gl"` (change the `.get(risk_type, "general_liability")` call in `resolve_fnol_defaults` to `.get(risk_type, "gl")`).

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_fnol.py tests/test_claim_routes.py -q -p no:cacheprovider`. Update any FNOL test that seeded long-form `coverage_lines`/asserted long-form lines to `"gl"`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/fnol.py backend/tests/test_fnol.py
git commit -F- <<'EOF'
fix(fnol): map risk types to SHORT coverage codes (gl/liquor) matching real policies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: `venue_line_deductible` resolver

**Files:**
- Modify: `backend/app/services/fnol.py`
- Test: `backend/tests/test_fnol.py`

- [ ] **Step 1: Write the failing test** (append to `test_fnol.py`):

```python
from decimal import Decimal
from app.services.fnol import venue_line_deductible


def test_venue_line_deductible_reads_terms_snapshot():
    s = _session()
    from app.models import Policy
    from datetime import date
    s.add(Policy(id="pol-d", submission_id="s", bound_quote_id="q", venue_id="elsewhere-brooklyn",
        carrier_id="markel-specialty", status="bound", effective_date=date(2026,1,1),
        expiration_date=date(2027,1,1), annual_premium=Decimal("5000"), commission_amount=Decimal("750"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
        terms_snapshot={"premium_breakdown": {"lines": {"gl": {"deductible": "2500.00"}}}}, snapshot_hash="h"))
    s.commit()
    assert venue_line_deductible(s, "elsewhere-brooklyn", "gl") == Decimal("2500.00")


def test_venue_line_deductible_none_when_no_policy():
    s = _session()
    assert venue_line_deductible(s, "no-such-venue", "gl") is None
```

- [ ] **Step 2: Run to verify fail** — ImportError (`venue_line_deductible` missing).

- [ ] **Step 3: Implement** — add to `backend/app/services/fnol.py`:

```python
from decimal import Decimal


def venue_line_deductible(session: Session, venue_id: str, line_id: str) -> "Decimal | None":
    """The per-line deductible on the venue's active policy, or None.

    Path: policy.terms_snapshot["premium_breakdown"]["lines"][line_id]["deductible"]
    (a JSON money string). line_id is a SHORT code (gl/liquor/...).
    """
    policies = session.exec(select(Policy).where(Policy.venue_id == venue_id)).all()
    active = [p for p in policies if p.status in ACTIVE_POLICY_STATUSES]
    if not active:
        return None
    active.sort(key=lambda p: p.effective_date, reverse=True)
    lines = (active[0].terms_snapshot or {}).get("premium_breakdown", {}).get("lines", {})
    raw = (lines.get(line_id) or {}).get("deductible")
    if raw is None:
        return None
    from app.money import json_to_usd
    return json_to_usd(raw)
```

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_fnol.py -q` → green. (Confirm `json_to_usd` is the right parser — grep `app/money.py`; it converts the JSON money string to `Decimal`.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/fnol.py backend/tests/test_fnol.py
git commit -F- <<'EOF'
feat(fnol): venue_line_deductible reads active-policy per-line deductible

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: Deductible-aware recommendation

**Files:**
- Modify: `backend/app/claim_recommendation.py`
- Test: `backend/tests/test_claim_recommendation.py` (create if absent; else append)

- [ ] **Step 1: Write the failing test**

```python
from decimal import Decimal
from app.claim_recommendation import recommend_claim_filing, recommendation_to_dict

RS = {"type": "premises_liability", "severity": "high", "confidence": 0.9}
INC = {"injury_observed": True, "police_called": True, "ems_called": True}


def test_deductible_reduces_carrier_payout_and_can_flip_to_dont_file():
    big = recommend_claim_filing(risk_signal=RS, incident=INC, deductible=None)
    d = recommendation_to_dict(big)
    assert d["carrier_payout"] == d["expected_payout"]["median_usd"]   # no deductible → full

    # A deductible above the median loss → carrier covers 0 → don't file (pay out of pocket)
    huge = recommend_claim_filing(risk_signal=RS, incident=INC,
                                  deductible=Decimal("10000000"))
    hd = recommendation_to_dict(huge)
    assert hd["carrier_payout"] == 0
    assert hd["should_file"] is False
    assert hd["pay_out_of_pocket_cost"] == hd["expected_payout"]["median_usd"]
```

- [ ] **Step 2: Run to verify fail** — `cd backend && python -m pytest tests/test_claim_recommendation.py -q` → `TypeError: unexpected keyword argument 'deductible'`.

- [ ] **Step 3: Implement** — in `backend/app/claim_recommendation.py`:

(a) add fields to the `ClaimRecommendation` dataclass (with defaults so existing construction still works):
```python
    deductible_usd: Optional[int] = None
    carrier_payout_usd: int = 0
    pay_out_of_pocket_cost_usd: int = 0
```
(b) change `recommend_claim_filing`'s signature to accept `deductible: "Decimal | None" = None` (import `Decimal`), and replace the payout/net-EV block:
```python
    payout = _estimate_payout(risk_type, severity)
    premium = _estimate_premium_impact(payout.median_usd)
    probability = _filing_probability(severity, injury, police, ems, risk_type)

    ded = int(deductible) if deductible is not None else None
    carrier_payout = payout.median_usd if ded is None else max(0, payout.median_usd - ded)
    expected_payout_value = int(carrier_payout * probability)
    net_ev = expected_payout_value - premium.cumulative_usd
    should_file = net_ev > 0 and carrier_payout > 0 and probability >= 0.45
```
and pass the new fields into the returned `ClaimRecommendation(...)`:
```python
        deductible_usd=ded,
        carrier_payout_usd=carrier_payout,
        pay_out_of_pocket_cost_usd=payout.median_usd,
```
(c) add the breakdown to `recommendation_to_dict`:
```python
        "deductible": rec.deductible_usd,
        "carrier_payout": rec.carrier_payout_usd,
        "pay_out_of_pocket_cost": rec.pay_out_of_pocket_cost_usd,
```

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_claim_recommendation.py tests/ -q -k "recommend or recommendation" -p no:cacheprovider` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_recommendation.py backend/tests/test_claim_recommendation.py
git commit -F- <<'EOF'
feat(recommendation): deductible-aware carrier_payout + pay-out-of-pocket breakdown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: Wire the deductible into `recommendation_for_packet`

**Files:**
- Modify: `backend/app/claim_routing.py`
- Test: `backend/tests/test_claim_routing.py`

- [ ] **Step 1: Write the failing test** (append to `test_claim_routing.py`; it has `_db_session`/`_packet`):

```python
from decimal import Decimal
from app.models import Policy
from datetime import date as _date

def test_recommendation_for_packet_applies_deductible():
    s = _db_session()
    s.add(IncidentRecord(id="inc-x", venue_id="elsewhere-brooklyn", occurred_at="2026-05-17T00:00:00Z",
        location="bar", summary="x", reported_by="m", injury_observed=True, police_called=True,
        ems_called=True, status="open"))
    _packet(s)  # pkt-routetest, premises_liability/medium/0.81 -> line "gl"
    s.add(Policy(id="po-x", submission_id="s", bound_quote_id="q", venue_id="elsewhere-brooklyn",
        carrier_id="markel-specialty", status="bound", effective_date=_date(2026,1,1),
        expiration_date=_date(2027,1,1), annual_premium=Decimal("5000"), commission_amount=Decimal("750"),
        commission_rate=Decimal("0.15"), coverage_lines=["gl"],
        terms_snapshot={"premium_breakdown": {"lines": {"gl": {"deductible": "999999"}}}}, snapshot_hash="h"))
    s.commit()
    rec = recommendation_for_packet(s, s.get(UnderwritingPacket, "pkt-routetest"))
    assert rec.carrier_payout_usd == 0    # huge deductible swallows the payout
```

- [ ] **Step 2: Run to verify fail** — `carrier_payout_usd` is the full median (deductible not applied).

- [ ] **Step 3: Implement** — in `recommendation_for_packet` (`claim_routing.py`), resolve the line + deductible and pass it:

```python
    from app.services.fnol import RISK_TYPE_TO_COVERAGE, venue_line_deductible
    risk_type = (packet.risk_signals or {}).get("type", "")
    line_id = RISK_TYPE_TO_COVERAGE.get(risk_type, "gl")
    deductible = venue_line_deductible(session, packet.venue_id, line_id)
    return recommend_claim_filing(
        risk_signal=packet.risk_signals or {},
        incident=incident_payload,
        venue_prior_claim_count=count_prior_claims(session, packet.venue_id),
        deductible=deductible,
    )
```

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_claim_routing.py -q` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_routing.py backend/tests/test_claim_routing.py
git commit -F- <<'EOF'
feat(routing): recommendation_for_packet applies the venue's per-line deductible

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: `GET /incidents/{id}/claim-status`

**Files:**
- Modify: `backend/app/api/v1/incidents.py`
- Test: `backend/tests/test_claim_routes.py`

- [ ] **Step 1: Write the failing test** (append to `test_claim_routes.py`, inline-TestClient style). Reuse `_seed_approved_proposal_routes` (from Plan-1 Task 4) which seeds incident `in-<sfx>` + packet `pk-<sfx>` + proposal `pr-<sfx>`:

```python
def test_claim_status_chain():
    session = next(get_session())
    try:
        _seed_approved_proposal_routes(session, "cs")  # incident in-cs, proposal pr-cs (approved)
        with TestClient(app) as client:
            r = client.get("/api/incidents/in-cs/claim-status", headers=_op_headers())
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["proposal"]["exists"] is True
        assert body["proposal"]["state"] == "approved"
        assert body["claim"]["exists"] is False
    finally:
        session.close()
```

- [ ] **Step 2: Run to verify fail** — 404 (route missing).

- [ ] **Step 3: Implement** — add to `backend/app/api/v1/incidents.py`:

```python
@router.get("/incidents/{incident_id}/claim-status")
def incident_claim_status(
    incident_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    record = session.get(IncidentRecord, incident_id)
    if record is None:
        raise error_response("incident_not_found", f"Incident {incident_id!r} not found", status_code=404)
    require_venue_access(record.venue_id, authorization, session)
    from app.models import UnderwritingPacket, ClaimProposal, Claim
    packet = session.exec(
        select(UnderwritingPacket).where(UnderwritingPacket.incident_id == incident_id)
    ).first()
    proposal = None
    if packet is not None:
        proposal = session.exec(
            select(ClaimProposal).where(ClaimProposal.packet_id == packet.id)
            .order_by(ClaimProposal.proposed_at.desc())
        ).first()
    claim = None
    if proposal is not None:
        claim = session.exec(select(Claim).where(Claim.proposal_id == proposal.id)).first()
    if claim is None:
        claim = session.exec(select(Claim).where(Claim.incident_id == incident_id)).first()
    return {
        "incident_status": record.status,
        "proposal": {"exists": proposal is not None, "state": proposal.state if proposal else None},
        "claim": {"exists": claim is not None, "status": claim.status if claim else None},
    }
```

Confirm the imports `select`, `IncidentRecord`, `require_venue_access`, `error_response`, `Header`, `Depends`, `get_session` exist at the top of `incidents.py` (the list/status routes use them); add `Header` if missing.

- [ ] **Step 4: Run** — `cd backend && python -m pytest tests/test_claim_routes.py -q -p no:cacheprovider` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/incidents.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(incidents): GET /incidents/{id}/claim-status (incident -> proposal -> claim chain)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Evidence-append guard on archived incidents

**Files:**
- Modify: `backend/app/api/v1/evidence.py`
- Test: `backend/tests/test_claim_routes.py` (or `test_evidence_*`)

- [ ] **Step 1: Write the failing test** — find where evidence-upload tests live (`grep -rl "/evidence" backend/tests`); append in that file's style. The test posts a small file to an incident whose status is `closed_archived` and expects `409`:

```python
def test_evidence_append_blocked_on_archived(client, op_headers, session):
    from app.models import IncidentRecord
    session.add(IncidentRecord(id="in-arch", venue_id="elsewhere-brooklyn", occurred_at="2026-05-01T00:00:00Z",
        location="x", summary="y", reported_by="m", injury_observed=False, police_called=False,
        ems_called=False, status="closed_archived"))
    session.commit()
    r = client.post("/api/incidents/in-arch/evidence",
                    files={"file": ("e.txt", b"bytes", "text/plain")}, headers=op_headers)
    assert r.status_code == 409
```
(Match the test file's actual fixture/style — inline `TestClient` + `_op_headers()` if that's the convention; use multipart `files=`.)

- [ ] **Step 2: Run to verify fail** — currently 201 (no guard).

- [ ] **Step 3: Implement** — in `backend/app/api/v1/evidence.py`, in the `POST /incidents/{id}/evidence` handler, after loading the incident + `require_venue_access`, before saving bytes:

```python
    if record.status == "closed_archived":
        raise error_response(
            "incident_archived",
            "This incident is archived; evidence can no longer be added.",
            status_code=409,
        )
```
(`record` is the loaded `IncidentRecord`; `error_response` is already imported in this file.)

- [ ] **Step 4: Run** — `cd backend && python -m pytest <that test file> -q -p no:cacheprovider` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/evidence.py backend/tests
git commit -F- <<'EOF'
feat(evidence): 409 when appending to a closed_archived incident

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Backend regression gate

- [ ] **Step 1:** `cd backend && rm -f database.db && python -m pytest -q -p no:cacheprovider` → all pass (was 982 + new tests). Fix any test that asserted exact recommendation/coverage-line dict shapes to be additive / short-code.
- [ ] **Step 2:** commit any touch-ups:
```bash
git add backend/tests
git commit -F- <<'EOF'
test: align recommendation/coverage-line assertions with deductible + short codes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Web — decision explainer card (B2)

**Files:**
- Modify: `frontend/src/app/incidents/[id]/page.tsx`

Replace the operator's "Worth filing?" card body with the two-path comparison. The packet's `claim_recommendation` now includes `carrier_payout`, `deductible`, `pay_out_of_pocket_cost`, `expected_premium_impact` (`{annual_delta_usd, cumulative_usd}`), `should_file`, `net_expected_value_usd`, `confidence`, `reasons`.

- [ ] **Step 1:** Extend the `rec` type derivation near the existing one:
```tsx
const rec = primaryPacket?.claim_recommendation as
  | { should_file: boolean; net_expected_value_usd: number; confidence: number; reasons: string[];
      carrier_payout: number; deductible: number | null; pay_out_of_pocket_cost: number;
      expected_premium_impact: { annual_delta_usd: number; cumulative_usd: number } }
  | undefined;
```

- [ ] **Step 2:** In the operator branch of the card (NOT the broker branch), replace the single net-EV stat with the two-path layout (use existing classes `.card`, `.font-mono`, `.text-muted`, `.badge`):
```tsx
{rec && (
  <div className="flex gap-md" style={{ flexWrap: "wrap" }}>
    <div className="card" style={{ flex: 1, minWidth: 220 }}>
      <div className="text-muted" style={{ fontSize: "0.75rem" }}>File the claim</div>
      <div className="font-mono">Carrier covers ~${rec.carrier_payout.toLocaleString()}</div>
      <div className="text-muted" style={{ fontSize: "0.78rem" }}>
        your cost: ${(rec.deductible ?? 0).toLocaleString()} deductible
        + ${rec.expected_premium_impact.cumulative_usd.toLocaleString()} premium / 3 yrs
      </div>
      <div className="font-mono" style={{ fontWeight: 600 }}>
        net {rec.net_expected_value_usd >= 0 ? "+" : ""}${rec.net_expected_value_usd.toLocaleString()}
      </div>
    </div>
    <div className="card" style={{ flex: 1, minWidth: 220 }}>
      <div className="text-muted" style={{ fontSize: "0.75rem" }}>Pay out of pocket</div>
      <div className="font-mono">Absorb ~${rec.pay_out_of_pocket_cost.toLocaleString()}</div>
      <div className="text-muted" style={{ fontSize: "0.78rem" }}>no premium hike · no loss-run mark</div>
    </div>
  </div>
)}
```
Keep the verdict badge above (`should_file` → "Recommended: File" / else "Recommended: pay out of pocket") and the reasons list below. Keep the existing `routingStatus` send-to-broker footer.

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → no new errors in `incidents/[id]/page.tsx`.

- [ ] **Step 4: Commit**
```bash
git add "frontend/src/app/incidents/[id]/page.tsx"
git commit -F- <<'EOF'
feat(web): file-vs-pay-out-of-pocket decision explainer on the incident screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 9: Web — status timeline (B3)

**Files:**
- Modify: `frontend/src/app/incidents/[id]/page.tsx`

- [ ] **Step 1:** Add state + fetch in the existing load effect (the page already knows the incident id):
```tsx
const [claimStatus, setClaimStatus] = useState<
  | { incident_status: string; proposal: { exists: boolean; state: string | null };
      claim: { exists: boolean; status: string | null } } | null>(null);
// in the effect:
const cs = await fetch(`${API_URL}/api/incidents/${id}/claim-status`, { headers: authHeaders() });
if (cs.ok) setClaimStatus(await cs.json());
```

- [ ] **Step 2:** Render a stepper (operator view), below the decision card:
```tsx
{claimStatus && (
  <section className="card">
    <div className="text-xs uppercase tracking-wide text-secondary mb-sm">Status</div>
    <div className="flex gap-sm" style={{ flexWrap: "wrap", alignItems: "center" }}>
      {[
        ["Reported", true],
        ["Sent to broker", claimStatus.proposal.exists],
        ["Approved", ["approved","filed_with_carrier","paid","denied"].includes(claimStatus.proposal.state ?? "")],
        ["Filed", ["filed_with_carrier","paid","denied"].includes(claimStatus.proposal.state ?? "") || claimStatus.claim.exists],
        ["Resolved", ["paid","denied"].includes(claimStatus.proposal.state ?? "") || ["closed_paid","closed_denied","closed_dropped"].includes(claimStatus.claim.status ?? "")],
      ].map(([label, on], i) => (
        <span key={i} className={on ? "badge badge-info" : "text-muted"} style={{ fontSize: "0.75rem" }}>
          {label as string}
        </span>
      ))}
    </div>
    {claimStatus.proposal.state === "rejected_by_broker" && (
      <p className="text-muted">Broker declined to file this one.</p>
    )}
  </section>
)}
```

- [ ] **Step 3: Typecheck + commit**
```bash
cd frontend && npx tsc --noEmit
git add "frontend/src/app/incidents/[id]/page.tsx"
git commit -F- <<'EOF'
feat(web): operator status timeline (incident -> proposal -> claim)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 10: Web — add-evidence control (C)

**Files:**
- Modify: `frontend/src/app/incidents/[id]/page.tsx`

- [ ] **Step 1:** Add an operator-only file input that POSTs to the existing evidence route (with `authHeaders()`, no Content-Type — browser sets the multipart boundary), then refreshes the evidence list:
```tsx
{isOperator && incident && incident.status !== "closed_archived" && (
  <label className="btn btn-secondary" style={{ minHeight: 44, cursor: "pointer" }}>
    Add evidence
    <input type="file" hidden onChange={async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const fd = new FormData(); fd.append("file", file);
      const r = await fetch(`${API_URL}/api/incidents/${id}/evidence`, {
        method: "POST", headers: authHeaders(), body: fd });
      if (r.ok) {
        const ev = await fetch(`${API_URL}/api/incidents/${id}/evidence`, { headers: authHeaders() });
        if (ev.ok) setEvidence(await ev.json());
      } else { toastError?.("Could not add evidence"); }
    }} />
  </label>
)}
```
(Use the page's real toast helper if present; `isOperator` already exists in the file; `setEvidence` is the existing evidence setter.)

- [ ] **Step 2: Typecheck + commit**
```bash
cd frontend && npx tsc --noEmit
git add "frontend/src/app/incidents/[id]/page.tsx"
git commit -F- <<'EOF'
feat(web): operator can add evidence to an existing incident

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 11: Manual verification + push

- [ ] As an operator, open an incident → the **two-path card** shows File vs Pay-out-of-pocket with the deductible; a small incident with a high deductible reads "pay out of pocket".
- [ ] The **status timeline** lights up as the proposal/claim advance.
- [ ] **Add evidence** to an open incident works; it's hidden/blocked on an archived one.
- [ ] `git push origin main`.

---

## Plan 3 (separate): broker pipeline IA — consolidate the duplicate decision surface (D1), continuous links (D2), persona-correct shared-screen audit (D3).
