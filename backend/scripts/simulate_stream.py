import httpx
import asyncio
import random
from datetime import datetime
from uuid import uuid4
import time

BASE_URL = "http://127.0.0.1:8000/api/v1"
VENUE_ID = "elsewhere-brooklyn"

async def send_pos_event(client):
    payload = {
        "event_id": str(uuid4()),
        "venue_id": VENUE_ID,
        "source_type": "pos",
        "timestamp": datetime.utcnow().isoformat(),
        "payload": {
            "order_id": f"ORD-{random.randint(1000, 9999)}",
            "total_amount": round(random.uniform(20.0, 150.0), 2),
            "items": [
                {"sku": "SKU-01", "name": "Tequila Shot", "quantity": 2, "price_total": 24.0, "category": "alcohol"},
                {"sku": "SKU-05", "name": "Bottled Water", "quantity": 1, "price_total": 5.0, "category": "water"}
            ],
            "payment_method": "credit_card"
        }
    }
    response = await client.post(f"/ingest/{VENUE_ID}/pos", json=payload)
    print(f"[POS] {response.status_code} | Event: {payload['event_id']}")

async def send_camera_event(client):
    payload = {
        "event_id": str(uuid4()),
        "venue_id": VENUE_ID,
        "source_type": "camera",
        "timestamp": datetime.utcnow().isoformat(),
        "payload": {
            "zone_id": "rear-bar",
            "person_count": random.randint(40, 60),
            "detections": [
                {"label": "person", "confidence": 0.98, "box": [10.5, 20.0, 50.5, 80.0]},
                {"label": "security-uniform", "confidence": 0.95, "box": [60.0, 30.0, 90.0, 90.0]}
            ],
            "aggression_score": round(random.uniform(0.0, 0.3), 2),
            "anomaly_detected": False
        }
    }
    response = await client.post(f"/ingest/{VENUE_ID}/camera", json=payload)
    print(f"[CAMERA] {response.status_code} | Event: {payload['event_id']}")

async def main():
    async with httpx.AsyncClient(base_url=BASE_URL, timeout=10.0) as client:
        print(f"🚀 Starting stream simulation for {VENUE_ID}...")
        for _ in range(5):  # Send a small burst
            await asyncio.gather(
                send_pos_event(client),
                send_camera_event(client)
            )
            await asyncio.sleep(1)
        print("✅ Simulation burst complete.")

if __name__ == "__main__":
    asyncio.run(main())
