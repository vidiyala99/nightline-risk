"""Meta-eval for the memo-faithfulness judge.

Measures whether the judge agrees with KNOWN labels (docs/evals/judge_gold.json).
Ground truth is auditable: faithful memos plus variants with a programmatically
injected unsupported claim (expected_faithful=false). This is the judge's own
trust number — a quality ratchet, not a per-commit gate. Positive class =
"unfaithful memo caught".
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class JudgeMetaReport:
    n: int
    accuracy: float
    confusion: dict  # {"tp", "fp", "tn", "fn"}


def run_judge_meta(judge, gold: list[dict]) -> JudgeMetaReport:
    tp = fp = tn = fn = 0
    for item in gold:
        verdict = judge(item["summary"], item["citations"], item["risk_signal"])
        predicted_unfaithful = not verdict.faithful
        actual_unfaithful = not item["expected_faithful"]
        if actual_unfaithful and predicted_unfaithful:
            tp += 1
        elif not actual_unfaithful and predicted_unfaithful:
            fp += 1
        elif not actual_unfaithful and not predicted_unfaithful:
            tn += 1
        else:
            fn += 1
    n = len(gold)
    accuracy = (tp + tn) / n if n else 0.0
    return JudgeMetaReport(n=n, accuracy=accuracy, confusion={"tp": tp, "fp": fp, "tn": tn, "fn": fn})
