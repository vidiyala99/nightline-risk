"""Tests for startup env validation (app/config.py)."""
import pytest

from app.config import is_production, validate_startup_env


def test_not_production_by_default(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    assert is_production() is False


def test_production_via_app_env(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.setenv("APP_ENV", "production")
    assert is_production() is True


def test_production_via_railway(monkeypatch):
    monkeypatch.setenv("RAILWAY_ENVIRONMENT", "production")
    assert is_production() is True


def test_validate_raises_in_prod_without_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("APP_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="APP_SECRET"):
        validate_startup_env()


def test_validate_raises_in_prod_without_database_url(monkeypatch):
    # Production without DATABASE_URL silently falls back to ephemeral sqlite
    # (database.py) — data vanishes on every redeploy. Fail fast instead.
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "a-stable-secret")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        validate_startup_env()


def test_validate_passes_in_prod_with_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "a-stable-secret")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@host/db")
    validate_startup_env()  # must not raise


def test_validate_noop_in_dev(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("APP_SECRET", raising=False)
    validate_startup_env()  # dev allows the ephemeral fallback — must not raise
