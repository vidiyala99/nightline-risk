"""Demo simulator — drips synthetic incidents into a running backend so the
broker dashboard's risk scores move in real time.

Use case: during a live demo or screen-recording, run this in a second
terminal while the broker dashboard is open. New incidents flow in every
few seconds; the score and tier visibly degrade across the portfolio.

Usage:
    python -m scripts.demo_simulator                              # default: 4 incidents, 8s apart, elsewhere-brooklyn
    python -m scripts.demo_simulator --venue brooklyn-mirage      # target a different venue
    python -m scripts.demo_simulator --count 10 --interval 3      # heavier drip
    python -m scripts.demo_simulator --reset                      # wipe accumulated deltas and exit

The simulator hits the public `/api/venues/{venue_id}/incidents` endpoint,
which goes through the real incident_flow → agent pipeline → packet snapshot,
so what the dashboard shows is what the demo audience sees.
"""
from __future__ import annotations

import argparse
import random
import sys
import time
from datetime import datetime, timezone

import httpx


DEFAULT_BASE_URL = "http://127.0.0.1:8000"
DEFAULT_VENUE = "elsewhere-brooklyn"

# A small library of plausible incidents — varying severity so the
# audience sees the risk-evaluator hard signals (injury/police/EMS) bite.
INCIDENT_TEMPLATES = [
    {
        "location": "Main floor — south bar",
        "summary": "Two patrons exchanged shoves near the bar after a drink dispute. Security separated them within 30s; no injuries.",
        "reported_by": "security_lead",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
    {
        "location": "Smoking patio",
        "summary": "Verbal altercation escalated to one patron pushing another into the railing. Patron declined medical aid but visibly favored their arm.",
        "reported_by": "door_lead",
        "injury_observed": True,
        "police_called": False,
        "ems_called": False,
    },
    {
        "location": "Coat-check line",
        "summary": "Patron slipped on spilled drink near coat check. EMS called as a precaution; patron walked out under their own power.",
        "reported_by": "manager_on_duty",
        "injury_observed": True,
        "police_called": False,
        "ems_called": True,
    },
    {
        "location": "Main floor — center",
        "summary": "Group altercation involving 4 patrons; one struck another with a thrown bottle. Police and EMS dispatched; one transported.",
        "reported_by": "security_lead",
        "injury_observed": True,
        "police_called": True,
        "ems_called": True,
    },
    {
        "location": "DJ booth side",
        "summary": "Patron attempted to climb onto stage equipment. Removed by security without incident; no injury, no escalation.",
        "reported_by": "stage_manager",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
    {
        "location": "Front door queue",
        "summary": "ID dispute turned into verbal aggression toward door staff. Patron left after warning; no police involvement.",
        "reported_by": "door_lead",
        "injury_observed": False,
        "police_called": False,
        "ems_called": False,
    },
]


def get_risk(client: httpx.Client, venue_id: str) -> dict:
    r = client.get(f"/api/venues/{venue_id}/risk-score", timeout=15.0)
    r.raise_for_status()
    return r.json()


def print_reset_instructions() -> None:
    """The tracker is a module-level singleton inside the backend process.
    The simplest reset is to restart the backend."""
    print(
        "Reset is in-process only — restart the backend (Ctrl-C uvicorn, then "
        "re-run) to clear accumulated deltas. Or run with --count 0 to just "
        "inspect current state without posting new incidents."
    )


def post_incident(client: httpx.Client, venue_id: str, template: dict) -> dict:
    payload = {
        **template,
        # IncidentCreate expects an ISO-8601 string for occurred_at
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    r = client.post(f"/api/venues/{venue_id}/incidents", json=payload, timeout=30.0)
    r.raise_for_status()
    return r.json()


def fmt_score(s: dict) -> str:
    delta = s.get("delta", {}) or {}
    delta_str = f"(d-inc={delta.get('incident_delta', 0)}, d-comp={delta.get('compliance_delta', 0)})"
    return f"score={s['total_score']:>3d}/100 tier={s['tier']} {delta_str}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--venue", default=DEFAULT_VENUE, help="Venue id to drip incidents into")
    parser.add_argument("--count", type=int, default=4, help="Number of incidents to post (0 = just show state and exit)")
    parser.add_argument("--interval", type=float, default=8.0, help="Seconds between incidents")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Backend base URL")
    parser.add_argument("--reset", action="store_true", help="Print reset instructions and exit")
    args = parser.parse_args(argv)

    if args.reset:
        print_reset_instructions()
        return 0

    with httpx.Client(base_url=args.base_url) as client:
        try:
            health = client.get("/openapi.json", timeout=5.0)
            health.raise_for_status()
        except Exception as exc:
            print(f"!! Could not reach backend at {args.base_url}: {exc}", file=sys.stderr)
            print("   Start it with: cd backend && uvicorn app.main:app --reload", file=sys.stderr)
            return 2

        initial = get_risk(client, args.venue)
        print(f"[t=0]   {args.venue:24s} {fmt_score(initial)}  (baseline)")

        if args.count == 0:
            return 0

        for i in range(1, args.count + 1):
            template = random.choice(INCIDENT_TEMPLATES)
            try:
                result = post_incident(client, args.venue, template)
            except httpx.HTTPStatusError as e:
                print(f"!! POST failed: {e.response.status_code} {e.response.text[:200]}")
                return 1

            inc = result.get("incident", {})
            risk = result.get("risk_signal", {})
            after = get_risk(client, args.venue)
            t = i * args.interval
            tag = "INJURY" if template["injury_observed"] else "       "
            police = "POLICE" if template["police_called"] else "      "
            ems = "EMS" if template["ems_called"] else "   "
            print(
                f"[t={t:5.0f}s] {args.venue:24s} {fmt_score(after)}  "
                f"({tag} {police} {ems})  "
                f"inc={inc.get('id', '???')[-8:]}  "
                f"risk.type={risk.get('type', '?'):20s} sev={risk.get('severity', '?')}"
            )

            if i < args.count:
                time.sleep(args.interval)

        final = get_risk(client, args.venue)
        baseline_score = initial["total_score"]
        final_score = final["total_score"]
        drop = baseline_score - final_score
        print()
        print(f"  score: {baseline_score} -> {final_score}  ({-drop:+d} points)")
        print(f"  tier:  {initial['tier']} -> {final['tier']}")
        print(f"  delta: {final.get('delta', {})}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
