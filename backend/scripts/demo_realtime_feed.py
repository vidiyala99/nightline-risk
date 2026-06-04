"""Demo real-time feed — POSTs synthetic operational signals to a running
server's push-ingestion endpoints on an interval, so the Savings-Score inputs
visibly move live.

This is the "real-time" half of the pitch made tangible: point it at a venue
and watch operational_data update each tick as camera/POS/staffing signals flow
through the same spine (quality gate -> dedupe -> rollup) as batch.

Usage (server must be running, e.g. uvicorn app.main:app):
    python -m scripts.demo_realtime_feed --venue elsewhere-brooklyn
    python -m scripts.demo_realtime_feed --base-url http://localhost:8000 \
        --venue elsewhere-brooklyn --interval 3 --ticks 20

Stdlib only — no extra dependencies, no auth (push endpoints are
machine-to-machine).
"""
from __future__ import annotations

import argparse
import json
import random
import time
import urllib.error
import urllib.request
import uuid


def _post(base_url: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"error": e.code, "detail": e.read().decode("utf-8", "replace")}
    except urllib.error.URLError as e:
        return {"error": "unreachable", "detail": str(e.reason)}


def _camera(venue: str) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "venue_id": venue,
        "payload": {
            "zone_id": "dance-floor",
            "person_count": random.randint(120, 900),
            "detections": [],
            "aggression_score": round(random.uniform(0.0, 0.6), 2),
        },
    }


def _pos(venue: str) -> dict:
    alcohol = random.randint(0, 8)
    other = random.randint(1, 6)
    return {
        "event_id": str(uuid.uuid4()),
        "venue_id": venue,
        "payload": {
            "order_id": f"o-{uuid.uuid4().hex[:8]}",
            "total_amount": round(alcohol * 12 + other * 5, 2),
            "items": [
                {"sku": "alc", "name": "Cocktail", "quantity": alcohol, "price_total": alcohol * 12.0, "category": "alcohol"},
                {"sku": "oth", "name": "Water", "quantity": other, "price_total": other * 5.0, "category": "water"},
            ],
            "payment_method": "card",
        },
    }


def _staffing(venue: str) -> dict:
    return {
        "event_id": str(uuid.uuid4()),
        "venue_id": venue,
        "payload": {
            "staff_id": f"s-{random.randint(1, 12)}",
            "name": "Demo Staff",
            "role": random.choice(["security", "bartender", "manager"]),
            "action": "clock-in",
            "staffing_ratio": round(random.uniform(0.6, 1.2), 2),
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Push synthetic real-time signals to a venue.")
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--venue", required=True, help="Venue id to feed (e.g. elsewhere-brooklyn)")
    ap.add_argument("--interval", type=float, default=3.0, help="Seconds between ticks")
    ap.add_argument("--ticks", type=int, default=20, help="Number of ticks (0 = run forever)")
    args = ap.parse_args()

    senders = [("camera", _camera), ("pos", _pos), ("staffing", _staffing)]
    print(f"Feeding {args.venue} at {args.base_url} every {args.interval}s "
          f"({'forever' if args.ticks == 0 else args.ticks} ticks)\n")

    tick = 0
    while args.ticks == 0 or tick < args.ticks:
        tick += 1
        for kind, build in senders:
            res = _post(args.base_url, f"/api/v1/ingest/{args.venue}/{kind}", build(args.venue))
            if "error" in res:
                print(f"[tick {tick}] {kind:8s} -> ERROR {res['error']}: {res.get('detail', '')[:120]}")
            else:
                od = res.get("operational_data", {})
                inputs = ", ".join(f"{k}={v}" for k, v in sorted(od.items()) if isinstance(v, (int, float)))
                print(f"[tick {tick}] {kind:8s} -> loaded={res.get('loaded')} "
                      f"rejected={res.get('rejected')} | score inputs: {inputs}")
        print()
        if args.ticks == 0 or tick < args.ticks:
            time.sleep(args.interval)


if __name__ == "__main__":
    main()
