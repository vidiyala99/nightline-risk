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


def test_validate_passes_in_prod_with_secret(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_SECRET", "a-stable-secret")
    validate_startup_env()  # must not raise


def test_validate_noop_in_dev(monkeypatch):
    monkeypatch.delenv("RAILWAY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("APP_SECRET", raising=False)
    validate_startup_env()  # dev allows the ephemeral fallback — must not raise
