from app.copilot.schemas import AnswerType, CopilotReply, ProposedAction, ToolResult
from app.evals.copilot_scorers import (
    intent_routing_accuracy, faithfulness_score, refusal_correctness, action_appropriateness,
)


def test_intent_routing_accuracy():
    assert intent_routing_accuracy(expected="get_risk_score", actual="get_risk_score") == 1.0
    assert intent_routing_accuracy(expected="get_risk_score", actual="get_exposure") == 0.0


def test_faithfulness_score_uses_guard():
    tr = [ToolResult(tool="get_risk_score", data={"score": 46}, citations=[])]
    assert faithfulness_score(CopilotReply(answer_type=AnswerType.answer, text="risk 46"), tr) == 1.0
    assert faithfulness_score(CopilotReply(answer_type=AnswerType.answer, text="risk 99"), tr) == 0.0


def test_refusal_correctness():
    assert refusal_correctness(should_refuse=True, reply=CopilotReply(answer_type=AnswerType.refuse, text="x")) == 1.0
    assert refusal_correctness(should_refuse=True, reply=CopilotReply(answer_type=AnswerType.answer, text="x")) == 0.0


def test_action_appropriateness():
    pa = ProposedAction(kind="send_to_broker", target_id="inc-1", summary="x", gating_passed=True)
    proposed = CopilotReply(answer_type=AnswerType.propose_action, text="x", proposed_action=pa)
    assert action_appropriateness(should_propose=True, reply=proposed) == 1.0
    assert action_appropriateness(should_propose=False, reply=proposed) == 0.0
