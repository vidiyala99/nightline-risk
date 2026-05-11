from app.schemas import LiveVenueState, InfrastructureItem, ComplianceItem, StreamEvent

class LiveStateManager:
    def __init__(self):
        self._states = {}

    def get_state(self, venue_id: str, max_capacity: int, venue_data: dict) -> LiveVenueState:
        if venue_id not in self._states:
            seeded_capacity = int(max_capacity * 0.93)
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

    def process_events(self, venue_id: str, events: list[StreamEvent], venue_data: dict) -> None:
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
                if anomaly_score > 0.4 and len(state.compliance_queue) < 3:
                    state.compliance_queue.append(ComplianceItem(
                        id=f"INCIDENT_{event.event_id[:6].upper()}",
                        title=f"ANOMALY_DETECTED_{event.payload.get('camera_id', 'UKN').upper()}",
                        description="Upload verified security footage to preserve claims defensibility.",
                        severity="URGENT"
                    ))
                    # Apply penalty for unresolved incident
                    state.premium_impact += 0.5

    def resolve_compliance_item(self, venue_id: str, item_id: str) -> bool:
        if venue_id not in self._states:
            return False
        
        state = self._states[venue_id]
        initial_length = len(state.compliance_queue)
        state.compliance_queue = [item for item in state.compliance_queue if item.id != item_id]
        
        if len(state.compliance_queue) < initial_length:
            # Remove the penalty
            state.premium_impact = max(0.0, state.premium_impact - 0.5)
            return True
        return False

live_state_manager = LiveStateManager()
