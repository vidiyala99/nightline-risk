"""Lightweight environment/config helpers.

The codebase reads env vars ad hoc via os.getenv; this module centralizes only
the two things that need a single source of truth: detecting production and
validating that production has the secrets it can't safely run without.
"""
import os


def is_production() -> bool:
    """True when running in a real deployment.

    Railway sets RAILWAY_ENVIRONMENT; APP_ENV is our own override for any other
    host. Anything else (unset, "development", "test") is treated as non-prod.
    """
    return (
        os.getenv("RAILWAY_ENVIRONMENT", "").lower() == "production"
        or os.getenv("APP_ENV", "").lower() == "production"
    )


def validate_startup_env() -> None:
    """Fail fast on a misconfigured production boot.

    In production, APP_SECRET MUST be set — otherwise auth.py falls back to an
    ephemeral per-process secret and every restart silently logs all users out.
    In dev we allow the ephemeral fallback (auth.py logs a warning).
    """
    if is_production() and not os.getenv("APP_SECRET"):
        raise RuntimeError(
            "APP_SECRET is not set but the environment is production. "
            "Set APP_SECRET to a stable secret so session tokens survive restarts. "
            "Refusing to start with an ephemeral secret in production."
        )
