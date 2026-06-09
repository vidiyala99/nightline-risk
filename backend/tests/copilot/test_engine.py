from app.copilot.engine import respond_to_message
from app.copilot.schemas import AnswerType, ProposedAction


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
