from app.copilot.faithfulness import assert_grounded
from app.copilot.schemas import ToolResult
from app.schemas.domain import Citation


def _tr():
    return [ToolResult(tool="get_risk_score", data={"score": 46, "tier": "C"},
                       citations=[Citation(source_id="risk-v1", source_type="risk_score", excerpt="46/100 tier C")])]


def test_grounded_text_passes():
    g = assert_grounded("Your risk is 46/100, tier C.", _tr())
    assert g.ok is True


def test_unsupported_number_is_flagged():
    g = assert_grounded("Your risk is 92/100 and you owe $5,000.", _tr())
    assert g.ok is False
    assert g.unsupported  # at least one ungrounded token
