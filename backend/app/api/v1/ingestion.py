from fastapi import APIRouter, HTTPException, BackgroundTasks
from typing import Union
from app.schemas.events import POSEvent, CameraEvent, StaffingEvent

router = APIRouter()

# In a real implementation, we would initialize a Redpanda/Kafka producer here.
# For now, we simulate the handoff to the message bus.

async def produce_to_redpanda(topic: str, event: Union[POSEvent, CameraEvent, StaffingEvent]):
    """
    Simulation of a Kafka producer. 
    In Phase 1, this will push to the 'raw-events' topic.
    """
    print(f"\n[REDPANDA PRODUCER] Pushing to topic: {topic}")
    print(f"  -> Event ID: {event.event_id}")
    print(f"  -> Source: {event.source_type}")
    print(f"  -> Venue: {event.venue_id}")
    # In reality: await producer.send_and_wait(topic, event.json())

@router.post("/ingest/{venue_id}/pos", status_code=202)
async def ingest_pos(venue_id: str, event: POSEvent, background_tasks: BackgroundTasks):
    if event.venue_id != venue_id:
        raise HTTPException(status_code=400, detail="Venue ID mismatch")
    background_tasks.add_task(produce_to_redpanda, "raw-events-pos", event)
    return {"status": "accepted", "event_id": event.event_id}

@router.post("/ingest/{venue_id}/camera", status_code=202)
async def ingest_camera(venue_id: str, event: CameraEvent, background_tasks: BackgroundTasks):
    if event.venue_id != venue_id:
        raise HTTPException(status_code=400, detail="Venue ID mismatch")
    background_tasks.add_task(produce_to_redpanda, "raw-events-camera", event)
    return {"status": "accepted", "event_id": event.event_id}

@router.post("/ingest/{venue_id}/staffing", status_code=202)
async def ingest_staffing(venue_id: str, event: StaffingEvent, background_tasks: BackgroundTasks):
    if event.venue_id != venue_id:
        raise HTTPException(status_code=400, detail="Venue ID mismatch")
    background_tasks.add_task(produce_to_redpanda, "raw-events-staffing", event)
    return {"status": "accepted", "event_id": event.event_id}
