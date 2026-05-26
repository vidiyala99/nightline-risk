"""One-shot helper to ingest the sample nightlife policy into a running backend.

Usage (from backend/):
    python scripts/upload_demo_policy.py

Logs in as the demo broker (broker@nightline.risk / demo123), POSTs the
markdown body to /api/venues/elsewhere-brooklyn/policy-docs, and prints the
URLs to open for the citation-chip demo.
"""

import os
import sys
from pathlib import Path

import httpx

API_URL = os.environ.get("API_URL", "http://127.0.0.1:8000")
VENUE_ID = "elsewhere-brooklyn"
POLICY_PATH = Path(__file__).resolve().parents[1] / "sample_data" / "nightlife_liability_2026.md"

DEMO_ITEMS = [
    ("COMP_CAMERA_REAR_001", "Rear camera footage gap"),
    ("COMP_INCIDENT_DOCS_002", "Incident report countersignature"),
]


def main() -> int:
    if not POLICY_PATH.exists():
        print(f"FAIL: sample policy missing at {POLICY_PATH}", file=sys.stderr)
        return 2

    with httpx.Client(base_url=API_URL, timeout=30.0) as client:
        login = client.post(
            "/api/auth/login",
            json={"email": "broker@nightline.risk", "password": "demo123"},
        )
        if login.status_code != 200:
            print(f"FAIL: login returned {login.status_code}: {login.text}", file=sys.stderr)
            return 1
        token = login.json()["access_token"]
        print(f"OK: logged in as broker (token len={len(token)})")

        body = POLICY_PATH.read_text(encoding="utf-8")
        upload = client.post(
            f"/api/venues/{VENUE_ID}/policy-docs",
            headers={"Authorization": f"Bearer {token}"},
            json={"text": body, "source_file": POLICY_PATH.name},
        )
        if upload.status_code != 201:
            print(f"FAIL: upload returned {upload.status_code}: {upload.text}", file=sys.stderr)
            return 1
        result = upload.json()
        print(
            f"OK: doc_id={result['doc_id']} "
            f"extracted={result['chunks_extracted']} inserted={result['chunks_inserted']}"
        )

    web = os.environ.get("WEB_URL", "http://localhost:3000")
    print()
    print("Open these in the browser to see the citation chip:")
    for item_id, label in DEMO_ITEMS:
        print(f"  {label}: {web}/compliance/{VENUE_ID}/{item_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
