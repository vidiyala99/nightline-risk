import pytest
from pathlib import Path
from pydantic import ValidationError
from app.schemas.events import POSEvent, CameraEvent
from scripts.process_policy import chunk_policy_text

# --- SCHEMA TESTS ---

def test_pos_schema_validation():
    """Verify that valid POS data passes and malformed data fails."""
    valid_data = {
        "venue_id": "elsewhere-brooklyn",
        "source_type": "pos",
        "payload": {
            "order_id": "ORD-123",
            "total_amount": 29.0,
            "items": [{"sku": "S-1", "name": "Beer", "quantity": 2, "price_total": 16.0, "category": "alcohol"}],
            "payment_method": "credit_card"
        }
    }
    event = POSEvent(**valid_data)
    assert event.venue_id == "elsewhere-brooklyn"
    assert len(event.payload.items) == 1

    with pytest.raises(ValidationError):
        # Missing total_amount
        POSEvent(venue_id="test", source_type="pos", payload={"order_id": "123"})

def test_camera_schema_validation():
    """Verify that Camera metadata schema is enforced."""
    valid_data = {
        "venue_id": "elsewhere-brooklyn",
        "source_type": "camera",
        "payload": {
            "zone_id": "rear-bar",
            "person_count": 50,
            "detections": [],
            "aggression_score": 0.5
        }
    }
    event = CameraEvent(**valid_data)
    assert event.payload.aggression_score == 0.5

# --- CHUNKER TESTS ---

def test_policy_chunker_logic():
    """Verify the semantic chunker correctly splits Markdown and extracts metadata."""
    mock_policy = """
## SECTION I: TEST
### 1.1 CLAUSE A
This is a test clause.
### 1.2 EXCLUSION B
This is an excluded clause.
"""
    chunks = chunk_policy_text(mock_policy)
    assert len(chunks) == 2
    assert chunks[0]["metadata"]["clause_id"] == "1.1"
    assert chunks[1]["metadata"]["is_exclusion"] is True
    assert "SECTION I: TEST" in chunks[0]["content"]

# --- EVAL SET TESTS ---

def test_gold_standard_integrity():
    """Ensure the eval set is valid JSON and has required fields."""
    import json

    eval_path = Path(__file__).resolve().parents[2] / "docs" / "evals" / "gold_standard.json"
    with open(eval_path, "r") as f:
        data = json.load(f)
    
    assert len(data) >= 3
    for case in data:
        assert "scenario_id" in case
        assert "ideal_output" in case
        assert "risk_score" in case["ideal_output"]
