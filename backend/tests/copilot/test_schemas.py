from app.copilot.schemas import (
    AnswerType, ToolResult, ProposedAction, CopilotReply,
)
from app.schemas.domain import Citation


def test_tool_result_carries_data_and_citations():
    tr = ToolResult(
        tool="get_risk_score",
        data={"score": 46, "tier": "C"},
        citations=[Citation(source_id="risk-elsewhere", source_type="risk_score", excerpt="46/100 tier C")],
    )
    assert tr.tool == "get_risk_score"
    assert tr.data["tier"] == "C"
    assert tr.citations[0].source_type == "risk_score"


def test_reply_defaults_are_safe():
    r = CopilotReply(answer_type=AnswerType.answer, text="ok")
    assert r.citations == []
    assert r.followups == []
    assert r.proposed_action is None


def test_proposed_action_roundtrips():
    pa = ProposedAction(
        kind="send_to_broker", target_id="inc-1", summary="Send the rear-bar incident",
        gating_passed=True,
    )
    assert ProposedAction(**pa.model_dump()).kind == "send_to_broker"
