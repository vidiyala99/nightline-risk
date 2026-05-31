# FNOL Bridge Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a broker approves a claim proposal, let them confirm a pre-filled FNOL and create the carrier `Claim` — and feed the claim's eventual close back to the proposal's terminal state.

**Architecture:** A small `services/fnol.py` resolves FNOL defaults (policy/line/date + blockers) from a proposal's incident. Two new claim-proposal endpoints (`fnol-draft`, `file-fnol`) drive a pre-filled confirm form on the broker decision page. `file_fnol` (existing) creates the `Claim`; the proposal advances `approved → filed_with_carrier`; `close_claim` (existing) advances the proposal `→ paid|denied`.

**Tech Stack:** Python / FastAPI / SQLModel (backend), Next.js / React / TS (web). pytest TDD.

**Spec:** `docs/superpowers/specs/2026-05-31-persona-correct-claim-loop-design.md` (Part A). Plans 2 (operator surfaces) and 3 (broker pipeline IA) follow.

---

## File Structure

**Backend — create:**
- `backend/app/services/fnol.py` — `resolve_fnol_defaults` + `RISK_TYPE_TO_COVERAGE` + `ACTIVE_POLICY_STATUSES`.
- `backend/tests/test_fnol.py` — resolver + endpoint + feedback tests.

**Backend — modify:**
- `backend/app/claim_proposals.py` — `mark_proposal_filed` + `settle_proposal_from_claim` transitions.
- `backend/app/api/v1/claim_proposals.py` — `GET .../fnol-draft` + `POST .../file-fnol`.
- `backend/app/services/claims.py` — `close_claim` feeds the linked proposal.

**Web — modify:**
- `frontend/src/app/underwriter/[id]/page.tsx` — the pre-filled FNOL confirm form after Approve.

---

## Task 1: `resolve_fnol_defaults` resolver

**Files:**
- Create: `backend/app/services/fnol.py`
- Test: `backend/tests/test_fnol.py`

- [ ] **Step 1: Write the failing test** (`backend/tests/test_fnol.py`). Uses a fresh in-memory DB like `test_claim_routing.py`'s `_db_session` — copy that helper pattern (engine `sqlite://`, `SQLModel.metadata.create_all`, seed a `Venue`).

```python
from datetime import date
from decimal import Decimal
from sqlmodel import Session, SQLModel, create_engine
from app.models import Venue, Policy, IncidentRecord, UnderwritingPacket, ClaimProposal
from app.services.fnol import resolve_fnol_defaults


def _session() -> Session:
    eng = create_engine("sqlite://", connect_args={"check_same_thread": False})
    SQLModel.metadata.create_all(eng)
    s = Session(eng)
    s.add(Venue(id="elsewhere-brooklyn", name="Elsewhere"))
    s.commit()
    return s


def _proposal(s, *, risk_type="premises_liability", with_policy=True) -> ClaimProposal:
    s.add(IncidentRecord(id="inc-1", venue_id="elsewhere-brooklyn",
        occurred_at="2026-05-17T00:46:00Z", location="bar", summary="x",
        reported_by="mgr", injury_observed=True, police_called=False, ems_called=False, status="open"))
    s.add(UnderwritingPacket(id="pkt-1", venue_id="elsewhere-brooklyn", incident_id="inc-1",
        rubric_version_id="demo-rubric-v1", status="needs_review", snapshot_hash="h",
        risk_signals={"type": risk_type, "severity": "high", "confidence": 0.9}))
    if with_policy:
        s.add(Policy(id="pol-1", submission_id="sub-1", bound_quote_id="q-1",
            venue_id="elsewhere-brooklyn", carrier_id="markel-specialty", status="bound",
            effective_date=date(2026,1,1), expiration_date=date(2027,1,1),
            annual_premium=Decimal("5000.00"), commission_amount=Decimal("750.00"),
            commission_rate=Decimal("0.15"), coverage_lines=["general_liability"],
            terms_snapshot={}, snapshot_hash="ph"))
    prop = ClaimProposal(id="prop-1", packet_id="pkt-1", venue_id="elsewhere-brooklyn",
        proposed_by="auto-router", state="approved")
    s.add(prop); s.flush()
    return prop


def test_resolves_policy_line_date():
    s = _session(); p = _proposal(s)
    d = resolve_fnol_defaults(s, p)
    assert d["policy_id"] == "pol-1"
    assert d["coverage_line"] == "general_liability"   # premises_liability -> GL
    assert d["date_of_loss"] == date(2026, 5, 17)
    assert d["blockers"] == []


def test_blocks_when_no_active_policy():
    s = _session(); p = _proposal(s, with_policy=False)
    d = resolve_fnol_defaults(s, p)
    assert "no_active_policy" in d["blockers"]
    assert d["policy_id"] is None
```

- [ ] **Step 2: Run to verify fail** — `cd backend && python -m pytest tests/test_fnol.py -q` → ImportError (`app.services.fnol` missing).

- [ ] **Step 3: Implement** `backend/app/services/fnol.py`:

```python
"""Resolve the FNOL defaults for an approved claim proposal.

A First Notice of Loss needs a policy, a coverage line, and a date of loss.
All three are derivable from the proposal's incident; this surfaces them
(plus any blockers) so the broker confirms rather than types.
"""
from datetime import date, datetime
from typing import Optional

from sqlmodel import Session, select

from app.models import ClaimProposal, IncidentRecord, Policy, UnderwritingPacket

# Active = a bound policy we can file against. "bound_pending_number" is a
# freshly-bound policy awaiting its carrier number; both are fileable.
ACTIVE_POLICY_STATUSES = {"bound", "bound_pending_number"}

# Map the risk classifier's type to a policy coverage line. Default to GL.
RISK_TYPE_TO_COVERAGE = {
    "premises_liability": "general_liability",
    "altercation_event": "general_liability",
    "medical_emergency": "general_liability",
    "crowd_management": "general_liability",
    "property_damage": "general_liability",
    "liquor_liability": "liquor_liability",
}


def _date_of_loss(occurred_at: str) -> Optional[date]:
    try:
        return datetime.fromisoformat(occurred_at.replace("Z", "+00:00")).date()
    except (ValueError, AttributeError):
        return None


def resolve_fnol_defaults(session: Session, proposal: ClaimProposal) -> dict:
    blockers: list[str] = []
    notes: list[str] = []

    packet = session.get(UnderwritingPacket, proposal.packet_id)
    incident = session.get(IncidentRecord, packet.incident_id) if packet else None
    venue_id = proposal.venue_id

    policies = session.exec(
        select(Policy).where(Policy.venue_id == venue_id)
    ).all()
    active = [p for p in policies if p.status in ACTIVE_POLICY_STATUSES]
    if not active:
        blockers.append("no_active_policy")
        policy_id = None
    else:
        active.sort(key=lambda p: p.effective_date, reverse=True)
        policy_id = active[0].id
        if len(active) > 1:
            notes.append("multiple_policies")

    risk_type = (packet.risk_signals or {}).get("type", "") if packet else ""
    coverage_line = RISK_TYPE_TO_COVERAGE.get(risk_type, "general_liability")

    dol = _date_of_loss(incident.occurred_at) if incident else None
    if dol is None:
        blockers.append("no_date_of_loss")

    return {"policy_id": policy_id, "coverage_line": coverage_line,
            "date_of_loss": dol, "blockers": blockers, "notes": notes}
```

- [ ] **Step 4: Run to verify pass** — `cd backend && python -m pytest tests/test_fnol.py -q` → 2 passed. (If `Policy`/`Venue` need more non-null columns, copy the factory from `tests/test_policies_api.py`.)

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/fnol.py backend/tests/test_fnol.py
git commit -F- <<'EOF'
feat(fnol): resolve_fnol_defaults (policy/line/date + blockers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 2: Proposal transitions — filed & settled

**Files:**
- Modify: `backend/app/claim_proposals.py`
- Test: `backend/tests/test_fnol.py`

`claim_proposals.py` sets `proposal.state` directly and emits `_add_audit_event`. Mirror that.

- [ ] **Step 1: Write the failing test** (append to `test_fnol.py`):

```python
from app.claim_proposals import mark_proposal_filed, settle_proposal_from_claim
from app.models import ClaimProposal


def test_mark_proposal_filed_requires_approved():
    s = _session(); p = _proposal(s)              # state == "approved"
    mark_proposal_filed(session=s, proposal_id="prop-1", broker_id="bk")
    assert s.get(ClaimProposal, "prop-1").state == "filed_with_carrier"


def test_settle_proposal_from_claim_maps_disposition():
    s = _session(); p = _proposal(s)
    p.state = "filed_with_carrier"; s.add(p); s.flush()
    settle_proposal_from_claim(session=s, proposal=p, disposition="paid")
    assert p.state == "paid"
    p.state = "filed_with_carrier"
    settle_proposal_from_claim(session=s, proposal=p, disposition="dropped")
    assert p.state == "denied"     # denied|dropped -> denied
```

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_fnol.py::test_mark_proposal_filed_requires_approved -q` → ImportError.

- [ ] **Step 3: Implement** — add to `backend/app/claim_proposals.py` (reuse the module's `_add_audit_event`):

```python
def mark_proposal_filed(*, session: Session, proposal_id: str, broker_id: str) -> ClaimProposal:
    """approved -> filed_with_carrier, after a Claim (FNOL) is created."""
    proposal = session.get(ClaimProposal, proposal_id)
    if proposal is None:
        raise ClaimProposalValidationError(f"Proposal not found: {proposal_id}")
    if proposal.state != "approved":
        raise ClaimProposalValidationError(
            f"Proposal {proposal_id} must be 'approved' to file (state={proposal.state})")
    proposal.state = "filed_with_carrier"
    session.add(proposal)
    _add_audit_event(session=session, actor_id=broker_id, actor_type="broker",
        entity_id=proposal.id, event_type="claim.filed_with_carrier",
        event_metadata={"packet_id": proposal.packet_id, "venue_id": proposal.venue_id})
    session.commit(); session.refresh(proposal)
    return proposal


def settle_proposal_from_claim(*, session: Session, proposal: ClaimProposal, disposition: str) -> None:
    """Claim close -> proposal terminal. paid -> paid; denied|dropped -> denied.
    No-op if the proposal isn't filed_with_carrier (defensive)."""
    if proposal.state != "filed_with_carrier":
        return
    proposal.state = "paid" if disposition == "paid" else "denied"
    session.add(proposal)
    _add_audit_event(session=session, actor_id="system", actor_type="system",
        entity_id=proposal.id, event_type=f"claim.{proposal.state}",
        event_metadata={"disposition": disposition, "venue_id": proposal.venue_id})
```

- [ ] **Step 4: Run** — `python -m pytest tests/test_fnol.py -q` → all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/claim_proposals.py backend/tests/test_fnol.py
git commit -F- <<'EOF'
feat(proposals): mark_proposal_filed + settle_proposal_from_claim transitions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 3: `GET /claim-proposals/{id}/fnol-draft`

**Files:**
- Modify: `backend/app/api/v1/claim_proposals.py`
- Test: `backend/tests/test_claim_routes.py`

- [ ] **Step 1: Write the failing test** (append to `test_claim_routes.py`; it has `_op_headers`/`_broker_headers`, `get_session`, `ClaimProposal`):

```python
def test_fnol_draft_returns_resolved_defaults(client, broker_headers, session):
    from app.models import UnderwritingPacket, IncidentRecord, Policy
    from datetime import date as _d
    from decimal import Decimal as _D
    session.add(IncidentRecord(id="in-fd", venue_id="elsewhere-brooklyn",
        occurred_at="2026-05-17T00:46:00Z", location="bar", summary="x", reported_by="m",
        injury_observed=True, police_called=False, ems_called=False, status="open"))
    session.add(UnderwritingPacket(id="pk-fd", venue_id="elsewhere-brooklyn", incident_id="in-fd",
        rubric_version_id="demo-rubric-v1", status="needs_review", snapshot_hash="h",
        risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9}))
    session.add(Policy(id="po-fd", submission_id="s", bound_quote_id="q", venue_id="elsewhere-brooklyn",
        carrier_id="markel-specialty", status="bound", effective_date=_d(2026,1,1),
        expiration_date=_d(2027,1,1), annual_premium=_D("5000"), commission_amount=_D("750"),
        commission_rate=_D("0.15"), coverage_lines=["general_liability"], terms_snapshot={}, snapshot_hash="ph"))
    session.add(ClaimProposal(id="pr-fd", packet_id="pk-fd", venue_id="elsewhere-brooklyn",
        proposed_by="auto-router", state="approved"))
    session.commit()
    r = client.get("/api/claim-proposals/pr-fd/fnol-draft", headers=broker_headers)
    assert r.status_code == 200, r.text
    assert r.json()["policy_id"] == "po-fd"
    assert r.json()["coverage_line"] == "general_liability"
    assert r.json()["date_of_loss"] == "2026-05-17"
```

(Match the file's real fixture names; if it constructs its own `TestClient`/headers inline, follow that.)

- [ ] **Step 2: Run to verify fail** — `python -m pytest tests/test_claim_routes.py::test_fnol_draft_returns_resolved_defaults -q` → 404 (route missing).

- [ ] **Step 3: Implement** — add to `backend/app/api/v1/claim_proposals.py` (after the broker-decision route). The module already imports `ClaimProposal`, `session`, `require_venue_access`, `HTTPException`:

```python
@router.get("/claim-proposals/{proposal_id}/fnol-draft")
def fnol_draft(
    proposal_id: str,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    proposal = session.get(ClaimProposal, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    require_venue_access(proposal.venue_id, authorization, session)
    from app.services.fnol import resolve_fnol_defaults
    d = resolve_fnol_defaults(session, proposal)
    return {
        "policy_id": d["policy_id"],
        "coverage_line": d["coverage_line"],
        "date_of_loss": d["date_of_loss"].isoformat() if d["date_of_loss"] else None,
        "blockers": d["blockers"],
        "notes": d["notes"],
    }
```

(If `Header` isn't imported in this file yet, add it to the `fastapi` import.)

- [ ] **Step 4: Run** — `python -m pytest tests/test_claim_routes.py -q` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/claim_proposals.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(fnol): GET /claim-proposals/{id}/fnol-draft

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 4: `POST /claim-proposals/{id}/file-fnol`

**Files:**
- Modify: `backend/app/api/v1/claim_proposals.py`
- Test: `backend/tests/test_claim_routes.py`

- [ ] **Step 1: Write the failing test** (append to `test_claim_routes.py`). First add a module-level seeding helper (also usable by Task 3's test if you refactor it), then the two tests — fully self-contained, no cross-test references:

```python
from datetime import date as _d
from decimal import Decimal as _D
from app.models import IncidentRecord, UnderwritingPacket, Policy, ClaimProposal

def _seed_approved_proposal(session, sfx: str, *, with_policy=True, state="approved"):
    session.add(IncidentRecord(id=f"in-{sfx}", venue_id="elsewhere-brooklyn",
        occurred_at="2026-05-17T00:46:00Z", location="bar", summary="x", reported_by="m",
        injury_observed=True, police_called=False, ems_called=False, status="open"))
    session.add(UnderwritingPacket(id=f"pk-{sfx}", venue_id="elsewhere-brooklyn", incident_id=f"in-{sfx}",
        rubric_version_id="demo-rubric-v1", status="needs_review", snapshot_hash="h",
        risk_signals={"type": "premises_liability", "severity": "high", "confidence": 0.9}))
    if with_policy:
        session.add(Policy(id=f"po-{sfx}", submission_id="s", bound_quote_id="q",
            venue_id="elsewhere-brooklyn", carrier_id="markel-specialty", status="bound",
            effective_date=_d(2026,1,1), expiration_date=_d(2027,1,1), annual_premium=_D("5000"),
            commission_amount=_D("750"), commission_rate=_D("0.15"),
            coverage_lines=["general_liability"], terms_snapshot={}, snapshot_hash="ph"))
    session.add(ClaimProposal(id=f"pr-{sfx}", packet_id=f"pk-{sfx}", venue_id="elsewhere-brooklyn",
        proposed_by="auto-router", state=state))
    session.commit()


def test_file_fnol_creates_claim_and_advances_proposal(client, broker_headers, session):
    _seed_approved_proposal(session, "ff")
    r = client.post("/api/claim-proposals/pr-ff/file-fnol",
                    json={"policy_id": "po-ff", "coverage_line": "general_liability",
                          "date_of_loss": "2026-05-17", "broker_id": "bk"}, headers=broker_headers)
    assert r.status_code == 201, r.text
    assert r.json()["claim"]["proposal_id"] == "pr-ff"
    assert session.get(ClaimProposal, "pr-ff").state == "filed_with_carrier"


def test_file_fnol_requires_approved_state(client, broker_headers, session):
    _seed_approved_proposal(session, "pend", state="pending_broker_review")
    r = client.post("/api/claim-proposals/pr-pend/file-fnol",
                    json={"policy_id": "po-pend", "coverage_line": "general_liability",
                          "date_of_loss": "2026-05-17", "broker_id": "bk"}, headers=broker_headers)
    assert r.status_code == 422
```

- [ ] **Step 2: Run to verify fail** — route missing → 404/405.

- [ ] **Step 3: Implement** — add to `backend/app/api/v1/claim_proposals.py`:

```python
from datetime import date as _date

@router.post("/claim-proposals/{proposal_id}/file-fnol", status_code=201)
def file_fnol_for_proposal(
    proposal_id: str,
    payload: dict,
    authorization: str = Header(None),
    session: Session = Depends(get_session),
) -> dict:
    proposal = session.get(ClaimProposal, proposal_id)
    if proposal is None:
        raise HTTPException(status_code=404, detail="Proposal not found")
    require_venue_access(proposal.venue_id, authorization, session)
    if proposal.state != "approved":
        raise HTTPException(status_code=422, detail={
            "error": "not_approved",
            "message": f"Proposal must be 'approved' to file (state={proposal.state})"})
    packet = session.get(UnderwritingPacket, proposal.packet_id)
    from app.services.claims import file_fnol
    from app.claim_proposals import mark_proposal_filed
    try:
        claim = file_fnol(
            session,
            policy_id=payload["policy_id"],
            coverage_line=payload["coverage_line"],
            date_of_loss=_date.fromisoformat(payload["date_of_loss"]),
            filed_by=payload.get("broker_id", "broker"),
            incident_id=packet.incident_id if packet else None,
            proposal_id=proposal_id,
        )
    except Exception as e:  # service raises typed errors; map to 422
        raise HTTPException(status_code=422, detail={"error": "fnol_failed", "message": str(e)}) from e
    mark_proposal_filed(session=session, proposal_id=proposal_id,
                        broker_id=payload.get("broker_id", "broker"))
    from app.main import _claim_to_dict  # reuse the existing claim serializer
    return {"claim": _claim_to_dict(claim), "proposal_state": "filed_with_carrier"}
```

NOTE: confirm the claim serializer name (`_claim_to_dict` or similar) by grepping `app/main.py`/`app/api/v1/claims.py`; if a different helper exists, use it. `file_fnol` commits or the caller commits — check `file_fnol`'s body and add `session.commit()` here only if it doesn't.

- [ ] **Step 4: Run** — `python -m pytest tests/test_claim_routes.py -q` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/api/v1/claim_proposals.py backend/tests/test_claim_routes.py
git commit -F- <<'EOF'
feat(fnol): POST /claim-proposals/{id}/file-fnol creates Claim + advances proposal

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 5: Claim close feeds the proposal

**Files:**
- Modify: `backend/app/services/claims.py` (`close_claim`)
- Test: `backend/tests/test_fnol.py`

- [ ] **Step 1: Write the failing test** (append to `test_fnol.py`; build a filed claim linked to a proposal, close it, assert the proposal settles). Reuse `test_claims_service.py`'s claim factory if importable; otherwise construct `Claim` + `ClaimProposal` directly and call `close_claim`.

```python
def test_closing_a_paid_claim_settles_its_proposal():
    from app.services.claims import close_claim
    from app.models import Claim
    from decimal import Decimal
    from datetime import date
    s = _session(); p = _proposal(s)
    p.state = "filed_with_carrier"; s.add(p)
    s.add(Claim(id="clm-x", policy_id="pol-1", incident_id="inc-1", proposal_id="prop-1",
                coverage_line="general_liability", status="reserved", date_of_loss=date(2026,5,17),
                current_reserve=Decimal("10000.00")))
    s.commit()
    close_claim(s, "clm-x", disposition="paid", final_indemnity=Decimal("8000.00"), closed_by="bk")
    assert s.get(ClaimProposal, "prop-1").state == "paid"
```

- [ ] **Step 2: Run to verify fail** — proposal stays `filed_with_carrier`.

- [ ] **Step 3: Implement** — in `close_claim` (`services/claims.py`), AFTER the claim reaches its terminal status and BEFORE/with the final commit, add:

```python
    # Feed the linked proposal's terminal state (paid|denied) so the operator's
    # status spine reflects the real outcome.
    if claim.proposal_id:
        from app.claim_proposals import settle_proposal_from_claim
        from app.models import ClaimProposal
        prop = session.get(ClaimProposal, claim.proposal_id)
        if prop is not None:
            settle_proposal_from_claim(session=session, proposal=prop, disposition=disposition)
```

(Place it just before `close_claim`'s existing `session.commit()` so it's in the same transaction. Read the function to find that point.)

- [ ] **Step 4: Run** — `python -m pytest tests/test_fnol.py -q` → green.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/claims.py backend/tests/test_fnol.py
git commit -F- <<'EOF'
feat(claims): close_claim settles the linked claim proposal (paid|denied)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 6: Backend regression gate

- [ ] **Step 1: Run the whole suite** — `cd backend && rm -f database.db && python -m pytest -q -p no:cacheprovider` → all pass (was ~974). If a proposal/claim test asserts exact dict shapes, make assertions additive.

- [ ] **Step 2: Commit any test touch-ups**

```bash
git add backend/tests
git commit -F- <<'EOF'
test: align proposal/claim assertions with FNOL bridge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 7: Web — pre-filled FNOL confirm on the broker decision page

**Files:**
- Modify: `frontend/src/app/underwriter/[id]/page.tsx`

The page already has `submitBrokerDecision('approved')` and the proposal. After approval, show the FNOL confirm form.

- [ ] **Step 1: Add state + fetch the draft**

After the proposal is known, add:

```tsx
const [fnolDraft, setFnolDraft] = useState<
  | { policy_id: string | null; coverage_line: string; date_of_loss: string | null; blockers: string[] }
  | null>(null);
const [filing, setFiling] = useState(false);

async function loadFnolDraft() {
  const r = await fetch(`${API_URL}/api/claim-proposals/${proposal.id}/fnol-draft`, { headers: authHeaders() });
  if (r.ok) setFnolDraft(await r.json());
}
```
Call `loadFnolDraft()` right after a successful `submitBrokerDecision('approved')`, and on mount if `proposal.state === 'approved' || proposal.state === 'filed_with_carrier'`.

- [ ] **Step 2: Render the confirm form** (match the page's existing card/button classes — `.card`, `.btn .btn-primary`, `.input-field`):

```tsx
{proposal?.state === "approved" && fnolDraft && (
  <section className="card" style={{ marginTop: "var(--space-md)" }}>
    <h3 className="card-title">Confirm &amp; file FNOL</h3>
    {fnolDraft.blockers.length > 0 ? (
      <p className="text-error">Cannot file: {fnolDraft.blockers.join(", ")}. Resolve the policy first.</p>
    ) : (
      <>
        <p className="text-muted font-mono" style={{ fontSize: "0.85rem" }}>
          policy {fnolDraft.policy_id} · {fnolDraft.coverage_line} · loss {fnolDraft.date_of_loss}
        </p>
        <button className="btn btn-primary" disabled={filing} style={{ minHeight: 44 }}
          onClick={async () => {
            setFiling(true);
            const r = await fetch(`${API_URL}/api/claim-proposals/${proposal.id}/file-fnol`, {
              method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
              body: JSON.stringify({ policy_id: fnolDraft.policy_id, coverage_line: fnolDraft.coverage_line,
                date_of_loss: fnolDraft.date_of_loss, broker_id: user?.id ?? "broker" }),
            });
            setFiling(false);
            if (r.ok) location.reload(); // proposal now filed_with_carrier
          }}>
          {filing ? "Filing…" : "Confirm & file FNOL"}
        </button>
      </>
    )}
  </section>
)}
{proposal?.state === "filed_with_carrier" && (
  <span className="badge badge-info">Filed with carrier</span>
)}
```

(`API_URL`, `authHeaders`, `user`, `proposal` are already in the page — confirm names while editing. Keep an editable policy/line/date as a follow-up if `blockers`/`notes` warrant; the resolved values are correct for the happy path.)

- [ ] **Step 3: Typecheck** — `cd frontend && npx tsc --noEmit` → no NEW errors in `underwriter/[id]/page.tsx` (ignore `.next/dev/types` route noise).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/underwriter/[id]/page.tsx
git commit -F- <<'EOF'
feat(web): pre-filled FNOL confirm on the broker decision page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
```

---

## Task 8: Manual verification

- [ ] As a broker, open an `approved` proposal → confirm the **FNOL draft** shows policy/line/date → **Confirm & file FNOL** → proposal shows **Filed with carrier** and a `Claim` appears in `/claims`.
- [ ] Close that claim as `paid` (via the claims UI) → the proposal reads `paid`.
- [ ] Push: `git push origin main`.

---

## Plans 2 & 3 (separate)
- **Plan 2 — operator surfaces:** `GET /incidents/{id}/claim-status` + the status timeline (B) and evidence-append + `409`-on-archived (C).
- **Plan 3 — broker pipeline IA:** consolidate the duplicate decision surface (D1), continuous links (D2), persona-correct shared-screen audit (D3).
