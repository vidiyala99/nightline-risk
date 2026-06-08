"""Deterministic scorers for the intelligence eval. No LLM-judge here — the
findings are deterministic, so deterministic scoring is reproducible and
bias-free. (LLM-as-judge is reserved for the copilot's subjective dimensions
in a later sub-project.)"""
from __future__ import annotations


def findings_recall(expected_ids: set[str], produced_ids: set[str]) -> float:
    """Fraction of expected findings that were produced."""
    if not expected_ids:
        return 1.0
    return len(expected_ids & produced_ids) / len(expected_ids)


def false_alarm_rate(expected_ids: set[str], produced_ids: set[str]) -> float:
    """Fraction of produced findings that were NOT expected. Lower is better;
    trust depends on this staying at/near zero."""
    if not produced_ids:
        return 0.0
    return len(produced_ids - expected_ids) / len(produced_ids)


def severity_match(expected: dict[str, str], produced: dict[str, str]) -> float:
    """Fraction of overlapping findings whose severity matches expectation."""
    shared = set(expected) & set(produced)
    if not shared:
        return 1.0
    correct = sum(1 for k in shared if expected[k] == produced[k])
    return correct / len(shared)
