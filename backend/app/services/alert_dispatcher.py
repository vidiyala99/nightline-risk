"""alert_dispatcher.py — Web Push delivery for AlertEvent notifications.

Sends push notifications to operator users subscribed to a venue,
records operator feedback, and logs observability signals for threshold tuning.
"""

import json
import logging
import os
from datetime import datetime, timedelta

from sqlmodel import Session, col, select

from app.models import AlertEvent, PushSubscription, UserRecord

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def dispatch_alert(alert_event: AlertEvent, session: Session) -> bool:
    """Send Web Push notifications to all operator subscribers for the venue.

    Returns True if at least one push succeeded; False otherwise.
    Updates alert_event.alerted = True in the DB on any success.
    """
    vapid_key = os.getenv("VAPID_PRIVATE_KEY", "")
    if not vapid_key:
        logger.warning(
            "VAPID_PRIVATE_KEY is not set — skipping push delivery for alert %s",
            alert_event.id,
        )
        return False

    try:
        from pywebpush import WebPushException, webpush  # noqa: PLC0415
    except ImportError:
        logger.warning(
            "pywebpush is not installed — skipping push delivery for alert %s",
            alert_event.id,
        )
        return False

    payload = _build_payload(alert_event)
    payload_str = json.dumps(payload)

    subscriptions = _get_operator_subscriptions(alert_event.venue_id, session)
    if not subscriptions:
        logger.info(
            "No push subscriptions found for venue %s (alert %s)",
            alert_event.venue_id,
            alert_event.id,
        )
        return False

    total = len(subscriptions)
    succeeded = 0
    for sub in subscriptions:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub.endpoint,
                    "keys": {"p256dh": sub.p256dh, "auth": sub.auth},
                },
                data=payload_str,
                vapid_private_key=vapid_key,
                vapid_claims={"sub": "mailto:alerts@nightlinerisk.com"},
            )
            succeeded += 1
            logger.debug("Push delivered to subscription %s", sub.id)
        except WebPushException as exc:
            logger.warning(
                "Push failed for subscription %s: %s", sub.id, exc
            )

    any_succeeded = succeeded > 0
    if any_succeeded:
        alert_event.alerted = True
        session.add(alert_event)
        session.commit()
        logger.info(
            "Alert %s dispatched for venue %s (%d/%d subscriptions delivered)",
            alert_event.id,
            alert_event.venue_id,
            succeeded,
            total,
        )

    return any_succeeded


def record_feedback(
    alert_id: str, feedback: str, session: Session
) -> AlertEvent | None:
    """Record operator feedback on an alert and trigger threshold observability.

    feedback should be "false_alarm" or "confirmed".
    Returns the updated AlertEvent, or None if not found.
    """
    alert_event = session.get(AlertEvent, alert_id)
    if alert_event is None:
        logger.warning("record_feedback: AlertEvent %s not found", alert_id)
        return None

    alert_event.feedback = feedback
    session.add(alert_event)
    session.commit()
    session.refresh(alert_event)

    _maybe_adjust_threshold(alert_event, session)
    return alert_event


def get_venue_alerts(
    venue_id: str, session: Session, limit: int = 50
) -> list[AlertEvent]:
    """Return up to `limit` alerts for a venue, newest first."""
    statement = (
        select(AlertEvent)
        .where(AlertEvent.venue_id == venue_id)
        .order_by(col(AlertEvent.detected_at).desc())
        .limit(limit)
    )
    return list(session.exec(statement).all())


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _build_payload(alert_event: AlertEvent) -> dict:
    title = (
        f"⚠️ {alert_event.severity.upper()} — "
        f"{alert_event.zone.replace('_', ' ').title()}"
    )
    body = (
        f"{alert_event.description} "
        f"({alert_event.confidence * 100:.0f}% confidence)"
    )
    return {
        "title": title,
        "body": body,
        "venue_id": alert_event.venue_id,
        "alert_id": alert_event.id,
        "zone": alert_event.zone,
        "severity": alert_event.severity,
    }


def _get_operator_subscriptions(
    venue_id: str, session: Session
) -> list[PushSubscription]:
    """Return all PushSubscription rows for operators scoped to venue_id."""
    user_statement = select(UserRecord).where(UserRecord.role == "operator")
    operator_users = session.exec(user_statement).all()

    scoped_user_ids: list[str] = []
    for user in operator_users:
        if user.tenant_id == venue_id:
            scoped_user_ids.append(user.id)
            continue
        extra: list[str] = json.loads(user.extra_venue_ids or "[]")
        if venue_id in extra:
            scoped_user_ids.append(user.id)

    if not scoped_user_ids:
        return []

    sub_statement = select(PushSubscription).where(
        PushSubscription.user_id.in_(scoped_user_ids)  # type: ignore[attr-defined]
    )
    return list(session.exec(sub_statement).all())


def _maybe_adjust_threshold(alert_event: AlertEvent, session: Session) -> None:
    """Log a warning if a venue has accumulated too many false-alarm signals."""
    cutoff = datetime.utcnow() - timedelta(days=7)
    statement = (
        select(AlertEvent)
        .where(AlertEvent.venue_id == alert_event.venue_id)
        .where(AlertEvent.feedback == "false_alarm")
        .where(AlertEvent.detected_at >= cutoff)
    )
    false_alarms = session.exec(statement).all()
    count = len(false_alarms)

    if count >= 5:
        logger.warning(
            "Venue %s has %d false alarms in the last 7 days — "
            "consider raising confidence threshold",
            alert_event.venue_id,
            count,
        )
