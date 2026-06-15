from app.copilot import engine as engine_mod
from app.copilot.engine import respond_to_message
from app.copilot.schemas import AnswerType, CopilotReply, ProposedAction


def test_read_question_grounds(seeded_operator_session):
    user, session = seeded_operator_session
    reply = respond_to_message(user, session, "what needs my attention?")
    assert reply.answer_type in (AnswerType.answer, AnswerType.refuse, AnswerType.clarify)


def test_action_intent_proposes_then_executes(seeded_borderline_incident_insured_user):
    user, session, incident_id = seeded_borderline_incident_insured_user
    reply = respond_to_message(user, session, f"send incident {incident_id} to my broker")
    assert reply.answer_type == AnswerType.propose_action
    assert reply.proposed_action.kind == "send_to_broker"
    confirmed = respond_to_message(user, session, "", confirm_action=reply.proposed_action)
    assert confirmed.answer_type == AnswerType.answer
    assert "broker" in confirmed.text.lower()


def test_confirm_revalidates_and_blocks_stale_action(seeded_no_policy_incident_user):
    user, session, incident_id = seeded_no_policy_incident_user
    stale = ProposedAction(kind="send_to_broker", target_id=incident_id, summary="x", gating_passed=True)
    reply = respond_to_message(user, session, "", confirm_action=stale)
    assert reply.answer_type == AnswerType.refuse  # server re-validation catches no-policy


def test_deterministic_read_is_tagged_deterministic(seeded_operator_session, monkeypatch):
    # Force the no-key path (a dev machine may have COPILOT_LLM_* / keys set).
    for var in ("COPILOT_LLM_BASE_URL", "COPILOT_LLM_MODEL", "COPILOT_LLM_API_KEY",
                "LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    user, session = seeded_operator_session
    reply = respond_to_message(user, session, "what needs my attention?")
    assert reply.source == "deterministic"


def test_grounding_downgrade_preserves_source(seeded_operator_session, monkeypatch):
    """An LLM answer that fails the faithfulness guard is downgraded to a
    clarify — but the telemetry source must survive so the fallback/quality
    rate stays measurable."""
    user, session = seeded_operator_session

    class _Stub:
        def respond(self, message, *, tools, confirm_action=None):
            tools.run("get_exposure", {})  # a real (grounded) tool result
            # ...but assert a number that isn't in the tool data → ungrounded.
            return CopilotReply(answer_type=AnswerType.answer,
                                text="You have 999999 urgent things.", source="llm")

    monkeypatch.setattr(engine_mod, "get_chat_provider", lambda: _Stub())
    reply = respond_to_message(user, session, "what needs my attention?")
    assert reply.answer_type == AnswerType.clarify  # downgraded by the guard
    assert reply.source == "llm"                     # telemetry preserved
