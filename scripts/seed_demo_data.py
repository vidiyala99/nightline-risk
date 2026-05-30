"""Seed the production (or local) demo database with realistic claim proposals.

Produces a portfolio that makes the Override Calibration card meaningful:
  - Mix of recommender-supported proposals (no override) -> broker approves most
  - Mix of operator overrides (different reasons) -> broker approves some, rejects some
  - Resulting calibration: overrides ~65-70%, baseline ~85-90%

Usage:
  python scripts/seed_demo_data.py                          # production Railway
  python scripts/seed_demo_data.py http://127.0.0.1:8000   # local
"""

import json
import sys
import urllib.request
import urllib.error

BASE = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "https://nightline-risk-api.fly.dev"
VENUE = "elsewhere-brooklyn"
OP_EMAIL = "venue@elsewhere.com"
BR_EMAIL = "broker@thirdspace.risk"
PASS = "demo123"

# -- helpers ------------------------------------------------------------------

def post(path: str, body: dict, token: str | None = None) -> dict:
    data = json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        raise RuntimeError(f"POST {path} -> {e.code}: {body_text}") from e


def get(path: str, token: str | None = None) -> dict | list:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{BASE}{path}", headers=headers)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def login(email: str) -> str:
    result = post("/api/auth/login", {"email": email, "password": PASS})
    return result["access_token"]


# -- incident templates --------------------------------------------------------

# Each tuple: (summary, location, injury, police, ems, note)
# "note" is a comment to print (not sent to API)
INCIDENTS = [
    # --- Recommender should say FILE (high severity, hard signals) ---
    (
        "Patron suffered head laceration after altercation near rear bar during sold-out DJ night. EMS called, police on scene.",
        "rear bar",
        True, True, True,
        "medical+altercation, all hard signals -> recommender says FILE",
    ),
    (
        "Liquor liability incident: intoxicated patron injured leaving venue at 2am, fell on stairs. EMS transported to hospital.",
        "main entrance stairwell",
        True, False, True,
        "liquor + injury + EMS -> recommender says FILE",
    ),
    (
        "Premises liability: patron slipped on wet dance floor, reported knee injury. Staff filled out incident report, police not called.",
        "main dance floor",
        True, False, False,
        "premises liability + injury -> recommender says FILE",
    ),
    (
        "Altercation between two patrons in VIP section, security intervened. One patron detained by police, no EMS needed.",
        "VIP section",
        False, True, False,
        "altercation + police -> recommender says FILE",
    ),
    (
        "Medical emergency: patron experienced cardiac symptoms, EMS transported to NYU Langone. Staff administered AED per training.",
        "near DJ booth",
        True, False, True,
        "medical emergency -> recommender says FILE",
    ),
    # --- Recommender should say DON'T FILE (low severity, no hard signals) ---
    (
        "Minor crowd management issue at door — line got unruly around midnight, security managed without incident, no injuries.",
        "main entrance",
        False, False, False,
        "crowd management, no hard signals -> recommender says DON'T FILE",
    ),
    (
        "Property damage: patron broke a bar glass, minor cut on hand, declined EMS. Cleaned up, no police involvement.",
        "bar area",
        False, False, False,
        "property damage, low severity -> recommender says DON'T FILE",
    ),
    (
        "General incident: loud argument between two patrons, resolved by staff. No physical contact, no injuries, no authorities called.",
        "main floor",
        False, False, False,
        "general incident, no signals -> recommender says DON'T FILE",
    ),
]

print(f"\n{'-'*60}")
print(f"Seeding demo data against: {BASE}")
print(f"{'-'*60}\n")

# -- authenticate --------------------------------------------------------------

print("Logging in...")
op_token = login(OP_EMAIL)
br_token = login(BR_EMAIL)
print(f"  OK operator token obtained")
print(f"  OK broker token obtained\n")

# -- create incidents + get packet IDs ----------------------------------------

packet_ids = []
for i, (summary, location, injury, police, ems, note) in enumerate(INCIDENTS, 1):
    print(f"[{i}/{len(INCIDENTS)}] Creating incident...")
    print(f"  {note}")
    try:
        inc_resp = post(
            f"/api/venues/{VENUE}/incidents",
            {
                "occurred_at": f"2026-05-{10 + i:02d}T23:00:00Z",
                "location": location,
                "summary": summary,
                "reported_by": "shift-lead",
                "injury_observed": injury,
                "police_called": police,
                "ems_called": ems,
            },
            token=op_token,
        )
        incident_id = inc_resp["incident"]["id"]
        packets = get(f"/api/incidents/{incident_id}/packets")
        if not packets:
            print("  ! No packet generated yet — skipping")
            continue
        packet_id = packets[0]["id"]
        rec = packets[0].get("claim_recommendation", {})
        should_file = rec.get("should_file", "?")
        prob = round(rec.get("probability", 0) * 100)
        net_ev = rec.get("net_expected_value_usd", "?")
        print(f"  packet: {packet_id}")
        print(f"  recommender: should_file={should_file}, prob={prob}%, net_ev=${net_ev:,}" if isinstance(net_ev, int) else f"  recommender: should_file={should_file}, prob={prob}%")
        packet_ids.append((packet_id, should_file, note))
    except RuntimeError as e:
        print(f"  FAIL {e}")
    print()

print(f"Created {len(packet_ids)} packets.\n{'-'*60}\n")

# -- create proposals ---------------------------------------------------------
#
# Strategy:
#   Recommender says FILE -> operator proposes without override (4 incidents)
#   Recommender says DON'T FILE -> operator overrides with different reasons
#     - legal_counsel
#     - additional_evidence
#     - prior_pattern
#   Keeps the by_reason breakdown interesting.

OVERRIDE_REASONS = ["legal_counsel", "additional_evidence", "prior_pattern"]
override_idx = 0
proposal_ids = []

for packet_id, should_file, note in packet_ids:
    print(f"Proposing for packet {packet_id[:16]}...")
    if should_file:
        body = {"operator_id": "user_002", "override_recommendation": False}
        tag = "agrees with rec"
    else:
        reason = OVERRIDE_REASONS[override_idx % len(OVERRIDE_REASONS)]
        override_idx += 1
        body = {
            "operator_id": "user_002",
            "override_recommendation": True,
            "override_reason": reason,
        }
        if reason == "prior_pattern":
            body["override_freetext"] = None
        tag = f"OVERRIDE ({reason})"

    try:
        prop = post(f"/api/packets/{packet_id}/claim-proposal", body, token=op_token)
        proposal_ids.append((prop["id"], should_file, tag))
        print(f"  OK proposal {prop['id'][:16]} — {tag}")
    except RuntimeError as e:
        print(f"  FAIL {e}")
    print()

print(f"Created {len(proposal_ids)} proposals.\n{'-'*60}\n")

# -- broker decisions ----------------------------------------------------------
#
# Deliberate pattern for interesting calibration numbers:
#   Non-overrides (recommender said file) -> approve all 5
#   Overrides:
#     legal_counsel -> approve  (lawyers are usually right)
#     additional_evidence -> reject  (common noise signal)
#     prior_pattern -> approve  (broker validates the pattern)
#
# Expected result:
#   non_override_right_rate = 5/5 = 100%
#   override_right_rate     = 2/3 = 67%  (Δ = -33 pp)
#
# Intentionally leave 1 proposal pending so the "X pending" count
# appears in the UI.

DECISIONS = []
for proposal_id, should_file, tag in proposal_ids:
    if not should_file:
        # override proposals
        if "additional_evidence" in tag:
            DECISIONS.append((proposal_id, "rejected", "Net EV negative; evidence not conclusive enough to overcome the recommender's assessment."))
        else:
            DECISIONS.append((proposal_id, "approved", None))
    else:
        DECISIONS.append((proposal_id, "approved", None))

# Leave the last proposal pending so the dashboard shows it
pending_proposal_id = None
if DECISIONS:
    pending_proposal_id, _, _ = DECISIONS.pop()
    print(f"Leaving proposal {pending_proposal_id[:16]} pending (demo visual effect)\n")

for proposal_id, decision, notes in DECISIONS:
    body: dict = {"broker_id": "user_001", "decision": decision}
    if notes:
        body["notes"] = notes
    try:
        result = post(f"/api/claim-proposals/{proposal_id}/broker-decision", body, token=br_token)
        print(f"  {decision.upper()}: proposal {proposal_id[:16]}")
    except RuntimeError as e:
        print(f"  FAIL {e}")

# -- final report --------------------------------------------------------------

print(f"\n{'-'*60}")
print("Fetching override stats to confirm seeding...\n")
try:
    stats = get("/api/override-stats")
    print(f"  override_total:          {stats['override_total']}")
    print(f"  override_approved:       {stats['override_approved']}")
    print(f"  override_rejected:       {stats['override_rejected']}")
    print(f"  override_pending:        {stats['override_pending']}")
    right = stats["override_right_rate"]
    base = stats["non_override_right_rate"]
    print(f"  override_right_rate:     {f'{round(right*100)}%' if right is not None else '—'}")
    print(f"  non_override_right_rate: {f'{round(base*100)}%' if base is not None else '—'}")
    if right is not None and base is not None:
        delta = round((right - base) * 100)
        print(f"  Δ vs baseline:           {'+' if delta >= 0 else ''}{delta} pp")
    if stats.get("by_reason"):
        print("\n  By override reason:")
        for reason, counts in stats["by_reason"].items():
            decided = counts["approved"] + counts["rejected"]
            rate = f"{round(counts['approved']/decided*100)}%" if decided > 0 else "pending"
            print(f"    {reason:25} total={counts['total']}  approved={counts['approved']}  rejected={counts['rejected']}  rate={rate}")
except Exception as e:
    print(f"  Could not fetch stats: {e}")

print(f"\n{'-'*60}")
print("Demo data seeded. Open the browser and log in:")
print(f"  Broker:   {BR_EMAIL} / {PASS}  -> /claims, /risk-profile/elsewhere-brooklyn")
print(f"  Operator: {OP_EMAIL} / {PASS}  -> /claims (My Claims)")
print(f"{'-'*60}\n")
