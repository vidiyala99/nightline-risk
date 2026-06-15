from app.evals.judge import FaithfulnessVerdict
from app.evals.judge_meta import run_judge_meta, JudgeMetaReport


def test_run_judge_meta_confusion_and_accuracy():
    gold = [
        {"id": "a", "summary": "clean", "citations": [], "risk_signal": {}, "expected_faithful": True},
        {"id": "b", "summary": "hallu", "citations": [], "risk_signal": {}, "expected_faithful": False},
        {"id": "c", "summary": "clean2", "citations": [], "risk_signal": {}, "expected_faithful": True},
        {"id": "d", "summary": "hallu2", "citations": [], "risk_signal": {}, "expected_faithful": False},
    ]
    # clean->faithful (tn), hallu->unfaithful (tp), clean2->unfaithful (fp), hallu2->faithful (fn)
    verdicts = {
        "clean": FaithfulnessVerdict(True, []),
        "hallu": FaithfulnessVerdict(False, ["x"]),
        "clean2": FaithfulnessVerdict(False, ["y"]),
        "hallu2": FaithfulnessVerdict(True, []),
    }
    judge = lambda s, c, r: verdicts[s]
    report = run_judge_meta(judge, gold)
    assert isinstance(report, JudgeMetaReport)
    assert report.n == 4
    assert report.confusion == {"tp": 1, "fp": 1, "tn": 1, "fn": 1}
    assert report.accuracy == 0.5


def test_run_judge_meta_empty():
    report = run_judge_meta(lambda s, c, r: FaithfulnessVerdict(True, []), [])
    assert report.n == 0
    assert report.accuracy == 0.0
    assert report.confusion == {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
