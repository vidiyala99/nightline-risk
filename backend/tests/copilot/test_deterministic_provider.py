from app.copilot.provider import DeterministicChatProvider, _classify
from app.copilot.schemas import AnswerType, ToolResult
from app.schemas.domain import Citation


class _FakeTools:
    def run(self, name, args):
        return ToolResult(tool=name, data={"score": 46, "tier": "C", "count": 1},
                          citations=[Citation(source_id="risk-v1", source_type="risk_score", excerpt="46/100 tier C")])
    catalog_names = {"get_risk_score", "get_exposure", "list_open_claims", "list_incidents"}


def test_risk_question_routes_to_risk_tool_and_grounds():
    p = DeterministicChatProvider()
    reply = p.respond("why is my risk a C?", tools=_FakeTools())
    assert reply.answer_type == AnswerType.answer
    assert "46" in reply.text and "C" in reply.text
    assert reply.citations


def test_off_topic_refuses():
    p = DeterministicChatProvider()
    reply = p.respond("what's the weather tonight?", tools=_FakeTools())
    assert reply.answer_type == AnswerType.refuse


# --- Over-fit guards: novel phrasings per read intent must still route. ---
# These assert on the classifier directly so a template change can't mask a
# routing regression. Keywords are added by meaning, not by memorizing the
# exact sentence.

def test_overfit_get_exposure():
    assert _classify("how exposed am I?") == "get_exposure"
    assert _classify("what needs my attention?") == "get_exposure"
    assert _classify("am I overdue on anything?") == "get_exposure"


def test_overfit_list_open_claims():
    assert _classify("any open claims?") == "list_open_claims"
    assert _classify("show me what we've filed") == "list_open_claims"
    assert _classify("how much is in reserve?") == "list_open_claims"


def test_overfit_list_incidents():
    assert _classify("what's the status of my reports?") == "list_incidents"
    assert _classify("show me recent incidents") == "list_incidents"
    assert _classify("did anyone file a report?") == "list_incidents"


def test_overfit_get_risk_score():
    assert _classify("what's my rating?") == "get_risk_score"
    assert _classify("why is my score so low?") == "get_risk_score"
    assert _classify("what tier am I in?") == "get_risk_score"


def test_overfit_off_topic_control_still_refuses():
    assert _classify("what's the weather tonight?") is None
    assert _classify("tell me a joke") is None
