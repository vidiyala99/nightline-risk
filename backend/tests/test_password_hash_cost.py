"""Test-mode bcrypt cost.

bcrypt is deliberately slow (default 12 rounds ≈ 250 ms/hash). In the test suite
its *security* is irrelevant — only its *interface* (produces a verifiable hash)
matters — and it's the single biggest per-test cost (seed_demo_users hashes every
lifespan; auth tests hash per user). Under the TESTING flag we drop to 4 rounds so
the suite isn't dominated by KDF work. Verification must still work for any cost,
including legacy 12-round hashes, so reducing NEW-hash cost is safe.
"""
import os

from app.auth import create_password_hash, verify_password


def test_test_mode_uses_low_bcrypt_cost():
    # conftest sets TESTING=1; the bcrypt cost factor is encoded in the hash
    # prefix ($2b$<rounds>$...). Low rounds = the cheap test path is active.
    assert os.getenv("TESTING")
    h = create_password_hash("whatever")
    assert h.startswith("$2b$04$"), f"expected 4-round test hash, got {h[:7]!r}"


def test_low_cost_hash_still_round_trips():
    h = create_password_hash("correct horse battery staple")
    assert verify_password("correct horse battery staple", h)
    assert not verify_password("wrong password", h)
