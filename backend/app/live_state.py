from app.schemas import LiveVenueState, InfrastructureItem, ComplianceItem, StreamEvent

# Demo: venues start at 93% of stated capacity so dashboards look like a busy night.
DEMO_INITIAL_CAPACITY_FRACTION = 0.93

# Auto-generate a compliance item when a camera anomaly scores above this.
CAMERA_ANOMALY_THRESHOLD = 0.4

# Cap auto-generated compliance items per venue so the queue does not flood from a noisy camera.
MAX_AUTO_GENERATED_COMPLIANCE_ITEMS = 3

# Premium delta applied per unresolved auto-generated compliance item; removed when the item is resolved.
UNRESOLVED_INCIDENT_PREMIUM_PENALTY = 0.5


class LiveStateManager:
    def __init__(self):
        self._states = {}

    def get_state(self, venue_id: str, max_capacity: int, venue_data: dict) -> LiveVenueState:
        if venue_id not in self._states:
            seeded_capacity = int(max_capacity * DEMO_INITIAL_CAPACITY_FRACTION)
            infrastructure = [
                InfrastructureItem(
                    name=item["name"],
                    status=item["status"],
                    detail=item["detail"],
                    is_degraded=item["is_degraded"],
                )
                for item in venue_data.get("infrastructure", [])
            ]
            seed_compliance = [
                ComplianceItem(
                    id=c["id"],
                    title=c["title"],
                    description=c["description"],
                    severity=c["severity"],
                )
                for c in venue_data.get("seed_compliance", [])
            ]
            self._states[venue_id] = LiveVenueState(
                venue_id=venue_id,
                current_capacity=seeded_capacity,
                max_capacity=max_capacity,
                premium_impact=0.0,
                infrastructure=infrastructure,
                compliance_queue=seed_compliance,
            )
        return self._states[venue_id]

    def process_events(self, venue_id: str, events: list[StreamEvent], venue_data: dict, session=None) -> None:
        if venue_id not in self._states:
            self.get_state(venue_id, venue_data["capacity"], venue_data)

        state = self._states[venue_id]

        for event in events:
            if event.event_type == "door_scan":
                scan_type = event.payload.get("scan_type")
                count = event.payload.get("count", 1)
                if scan_type == "entry":
                    state.current_capacity = min(state.current_capacity + count, state.max_capacity)
                elif scan_type == "exit":
                    state.current_capacity = max(state.current_capacity - count, 0)

            elif event.event_type == "camera_metadata":
                anomaly_score = event.payload.get("anomaly_score", 0.0)
                if anomaly_score > CAMERA_ANOMALY_THRESHOLD and session is not None:
                    from app.models import ComplianceSignal
                    from sqlmodel import select
                    open_auto = session.exec(
                        select(ComplianceSignal)
                        .where(ComplianceSignal.venue_id == venue_id)
                        .where(ComplianceSignal.status == "open")
                        .where(ComplianceSignal.provenance == "auto_generated")
                    ).all()
                    if len(open_auto) < MAX_AUTO_GENERATED_COMPLIANCE_ITEMS:
                        session.add(ComplianceSignal(
                            id=f"INCIDENT_{event.event_id[:6].upper()}",
                            venue_id=venue_id,
                            title=f"ANOMALY_DETECTED_{event.payload.get('camera_id', 'UKN').upper()}",
                            description="Upload verified security footage to preserve claims defensibility.",
                            provenance="auto_generated", severity="urgent", status="open",
                        ))
                        session.commit()
                elif anomaly_score > CAMERA_ANOMALY_THRESHOLD and session is None:
                    # No DB context — fall back to in-memory queue (legacy path)
                    if len(state.compliance_queue) < MAX_AUTO_GENERATED_COMPLIANCE_ITEMS:
                        state.compliance_queue.append(ComplianceItem(
                            id=f"INCIDENT_{event.event_id[:6].upper()}",
                            title=f"ANOMALY_DETECTED_{event.payload.get('camera_id', 'UKN').upper()}",
                            description="Upload verified security footage to preserve claims defensibility.",
                            severity="urgent"
                        ))
                        state.premium_impact += UNRESOLVED_INCIDENT_PREMIUM_PENALTY

    def resolve_compliance_item(self, venue_id: str, item_id: str) -> bool:
        if venue_id not in self._states:
            return False

        state = self._states[venue_id]
        initial_length = len(state.compliance_queue)
        state.compliance_queue = [item for item in state.compliance_queue if item.id != item_id]

        if len(state.compliance_queue) < initial_length:
            state.premium_impact = max(0.0, state.premium_impact - UNRESOLVED_INCIDENT_PREMIUM_PENALTY)
            return True
        return False

live_state_manager = LiveStateManager()
