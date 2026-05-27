"""Pluggable, env-gated outbound email.

Mirrors the alert_dispatcher pattern: gate on the provider key, defer the
import, and degrade gracefully (return False) when unconfigured. Today the one
backend is Resend (a single HTTPS POST). When RESEND_API_KEY is absent, sends
no-op and callers log the relevant URL so dev flows still work without an
email account.
"""
import logging
import os

logger = logging.getLogger(__name__)

RESEND_ENDPOINT = "https://api.resend.com/emails"
DEFAULT_FROM = "Nightline Risk <noreply@nightlinerisk.com>"


def email_enabled() -> bool:
    return bool(os.getenv("RESEND_API_KEY"))


def send_email(*, to: str, subject: str, html: str, text: str | None = None) -> bool:
    """Send one email via Resend. Returns True on success, False if disabled or failed."""
    api_key = os.getenv("RESEND_API_KEY", "")
    if not api_key:
        logger.info("RESEND_API_KEY not set — skipping email to %s (subject=%r)", to, subject)
        return False

    try:
        import httpx  # noqa: PLC0415
    except ImportError:
        logger.warning("httpx not installed — cannot send email to %s", to)
        return False

    payload = {
        "from": os.getenv("EMAIL_FROM", DEFAULT_FROM),
        "to": [to],
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    try:
        resp = httpx.post(
            RESEND_ENDPOINT,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
            timeout=10.0,
        )
        if resp.status_code >= 400:
            logger.warning("Resend returned %s sending to %s: %s", resp.status_code, to, resp.text[:200])
            return False
        return True
    except Exception as e:  # network/timeout — don't crash the request flow
        logger.warning("Failed to send email to %s: %s", to, e)
        return False


def send_password_reset_email(email: str, reset_url: str) -> bool:
    """Compose + send the password-reset email. Logs the URL when email is disabled."""
    if not email_enabled():
        logger.info("Password reset for %s — email disabled; reset URL: %s", email, reset_url)
        return False

    subject = "Reset your Nightline Risk password"
    html = (
        f"<p>We received a request to reset your password.</p>"
        f'<p><a href="{reset_url}">Reset your password</a></p>'
        f"<p>This link expires in 1 hour. If you didn't request this, you can ignore this email.</p>"
    )
    text = f"Reset your password (expires in 1 hour): {reset_url}"
    return send_email(to=email, subject=subject, html=html, text=text)
