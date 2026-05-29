# Deterministic Memo Credibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the deterministic underwriting memo read like a real underwriter wrote it *about this specific incident* (killing the byte-identical-memo tell), and pin that with an eval scorer so it can't regress to generic.

**Architecture:** Rewrite only the `summary` construction in `DeterministicProvider.draft_memo` to weave inputs already passed in (venue/location, a trimmed incident-summary fragment, a quoted citation excerpt, a confidence-banded recommendation) — fully deterministic. Add an optional `venue_name` param across the provider interface. Add a `score_memo_specificity` scorer (invariant-only hard gate) plus distinctness/determinism unit tests, and regenerate the eval baseline.

**Tech Stack:** Python 3.12, pytest, FastAPI/SQLModel backend, the in-house provider abstraction (`app/providers/`) and eval harness (`app/evals/`).

**Spec:** `docs/superpowers/specs/2026-05-28-deterministic-memo-credibility-design.md`

---

## File Structure

- `backend/app/providers/base.py` — add optional `venue_name` to the abstract `draft_memo`.
- `backend/app/providers/deterministic.py` — the core rewrite (summary composition + helpers).
- `backend/app/providers/gemini_provider.py`, `anthropic_provider.py` — accept `venue_name`, weave into prompt.
- `backend/app/agents/runtime.py` — thread `venue_name` from `execute` → `_run_underwriter_memo_agent` → `draft_memo`.
- `backend/app/evals/runner.py` — add `incident` to `_RunOutput`; wire new scorer into `_score_standard_scenario`.
- `backend/app/evals/scorers.py` — new `score_memo_specificity`.
- `backend/tests/test_memo_credibility.py` — new test file (provider behavior + scorer).

---

### Task 1: Add optional `venue_name` to the provider interface

**Files:**
- Modify: `backend/app/providers/base.py:160-170`
- Modify: `backend/app/providers/deterministic.py:250-260`
- Modify: `backend/app/providers/anthropic_provider.py` (the `draft_memo` signature, ~line 53)
- Modify: `backend/app/providers/gemini_provider.py` (the `draft_memo` signature, ~line 52)
- Test: `backend/tests/test_memo_credibility.py`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_memo_credibility.py`:

```python
from app.providers.deterministic import DeterministicProvider


def _draft(**kw):
    base = dict(
        incident_summary="A patron altercation near the rear bar escalated.",
        incident_location="rear-bar",
        risk_type="altercation_event",
        severity="high",
        confidence=0.82,
        citation_excerpts=["Door staff intervened at 1:42am per the incident log."],
    )
    base.update(kw)
    return DeterministicProvider().draft_memo(**base)


def test_draft_memo_accepts_venue_name():
    out = _draft(venue_name="House of Yes")
    assert out.summary  # does not raise; produces output
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py::test_draft_memo_accepts_venue_name -v`
Expected: FAIL with `TypeError: draft_memo() got an unexpected keyword argument 'venue_name'`.

- [ ] **Step 3: Add the param to the abstract base and all three implementations**

In `backend/app/providers/base.py`, change the abstract `draft_memo` signature to add `venue_name` (after `incident_location`):

```python
    @abstractmethod
    def draft_memo(
        self,
        *,
        incident_summary: str,
        incident_location: str,
        venue_name: str | None = None,
        risk_type: str,
        severity: str,
        confidence: float,
        citation_excerpts: list[str],
        open_questions: list[str] | None = None,
    ) -> MemoOutput: ...
```

In `backend/app/providers/deterministic.py`, `anthropic_provider.py`, and `gemini_provider.py`, add the same `venue_name: str | None = None,` line to each concrete `draft_memo` signature (right after `incident_location: str,`). Do not use it yet in Anthropic/Gemini (Task 3) — just accept it so the signature matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py::test_draft_memo_accepts_venue_name -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/providers/base.py backend/app/providers/deterministic.py backend/app/providers/anthropic_provider.py backend/app/providers/gemini_provider.py backend/tests/test_memo_credibility.py
git commit -m "feat(providers): add optional venue_name to draft_memo"
```

---

### Task 2: Rewrite the deterministic `summary` composition

**Files:**
- Modify: `backend/app/providers/deterministic.py:261-360` (the body of `draft_memo`)
- Test: `backend/tests/test_memo_credibility.py`

Keep the existing `risk_analysis`, `severity_action`, and `open_questions` dicts. Replace the `citation_note` + `summary` assembly with composed parts, and add three module-level helpers above the class.

- [ ] **Step 1: Write the failing tests**

Append to `backend/tests/test_memo_credibility.py`:

```python
def test_summary_weaves_location_and_citation():
    out = _draft(venue_name="House of Yes")
    s = out.summary
    assert "House of Yes" in s                       # venue named in the lead
    assert "rear bar" in s.lower()                   # incident fragment present
    assert "1:42am" in s                             # citation excerpt quoted

def test_summary_uses_location_when_no_venue_name():
    out = _draft(venue_name=None)
    assert "rear-bar" in out.summary                 # falls back to location

def test_two_distinct_incidents_differ():
    a = _draft(venue_name="House of Yes",
               incident_summary="Altercation near the rear bar.",
               citation_excerpts=["Door staff intervened at 1:42am."])
    b = _draft(venue_name="Elsewhere",
               incident_location="main-floor",
               incident_summary="A slip on a wet floor by the entrance.",
               risk_type="premises_liability",
               citation_excerpts=["No wet-floor signage was posted per the log."])
    assert a.summary != b.summary

def test_same_input_is_byte_identical():
    assert _draft(venue_name="House of Yes").summary == _draft(venue_name="House of Yes").summary

def test_low_confidence_softens_recommendation():
    out = _draft(confidence=0.40)
    assert "manual review" in out.summary.lower()

def test_no_citations_uses_no_sources_note():
    out = _draft(citation_excerpts=[])
    assert "no corroborating sources" in out.summary.lower()

def test_empty_summary_does_not_crash():
    out = _draft(incident_summary="", citation_excerpts=[])
    assert isinstance(out.summary, str) and out.summary
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py -v`
Expected: the new tests FAIL (e.g. `assert "House of Yes" in s` fails — the current summary never includes the venue; `test_two_distinct_incidents_differ` may pass coincidentally via risk_type but the location/citation asserts fail first).

- [ ] **Step 3: Add helpers and rewrite the summary assembly**

In `backend/app/providers/deterministic.py`, add these module-level helpers above `class DeterministicProvider`:

```python
def _lead_fragment(incident_summary: str, limit: int = 140) -> str:
    """First sentence of the incident summary, else a word-boundary trim.

    Deterministic: no randomness, stable for identical input.
    """
    text = (incident_summary or "").strip()
    if not text:
        return "An incident was reported"
    # earliest sentence terminator
    cut = len(text)
    for term in (". ", "! ", "? "):
        idx = text.find(term)
        if idx != -1:
            cut = min(cut, idx + 1)
    if cut <= limit:
        return text[:cut].rstrip(".!? ").strip()
    # no early terminator within limit — trim on a word boundary
    clipped = text[:limit]
    if " " in clipped:
        clipped = clipped[: clipped.rfind(" ")]
    return clipped.strip() + "…"


def _trim_excerpt(excerpt: str, limit: int = 120) -> str:
    text = (excerpt or "").strip()
    if len(text) <= limit:
        return text
    clipped = text[:limit]
    if " " in clipped:
        clipped = clipped[: clipped.rfind(" ")]
    return clipped.strip() + "…"


def _confidence_clause(confidence: float) -> str:
    """Deterministic confidence band → recommendation modulation."""
    c = round(confidence, 2)
    if c < 0.5:
        return f"Classifier confidence is low ({c:.2f}) — recommend manual review before acting."
    if c < 0.7:
        return f"Classifier confidence is moderate ({c:.2f}); corroborate before a premium decision."
    return f"Classifier confidence is high ({c:.2f})."
```

Then in `draft_memo`, after the `severity_action = {...}.get(...)` block, replace the `citation_note` + `summary` lines (currently lines ~313-319) with:

```python
        where = venue_name or incident_location or "The venue"
        lead = f"{where}: {_lead_fragment(incident_summary)}."

        if citation_excerpts:
            citation_grounding = (
                f'Corroborated by {len(citation_excerpts)} source(s), '
                f'incl. "{_trim_excerpt(citation_excerpts[0])}".'
            )
        else:
            citation_grounding = (
                "No corroborating sources retrieved — underwriter should request "
                "additional documentation."
            )

        summary = " ".join([
            lead,
            risk_analysis,
            citation_grounding,
            severity_action,
            _confidence_clause(confidence),
        ])
```

Leave the `open_questions` block and the final `return MemoOutput(...)` unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py -v`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/providers/deterministic.py backend/tests/test_memo_credibility.py
git commit -m "feat(memo): weave incident specifics into deterministic summary"
```

---

### Task 3: Thread `venue_name` through the runtime and into LLM prompts

**Files:**
- Modify: `backend/app/agents/runtime.py:97` (the `execute` call), `:583-617` (`_run_underwriter_memo_agent`)
- Modify: `backend/app/providers/gemini_provider.py` (the `user_prompt` in `draft_memo`)
- Modify: `backend/app/providers/anthropic_provider.py` (the user prompt in `draft_memo`)
- Test: `backend/tests/test_memo_credibility.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_memo_credibility.py`:

```python
from app.agents.runtime import UnderwritingPacketAgentRuntime
from app.providers.deterministic import DeterministicProvider, DeterministicRiskClassifier
from app.schemas import IncidentCreate  # adjust import if IncidentCreate lives elsewhere


def test_runtime_passes_venue_name_into_memo():
    rt = UnderwritingPacketAgentRuntime(
        memo_provider=DeterministicProvider(),
        risk_classifier=DeterministicRiskClassifier(),
    )
    incident = IncidentCreate(
        occurred_at="2026-05-28T01:42:00Z",
        location="rear-bar",
        summary="A patron altercation near the rear bar escalated.",
        reported_by="floor-staff",
        injury_observed=True, police_called=True, ems_called=False,
    )
    result = rt.execute(
        venue_id="venue-1",
        venue={"name": "House of Yes"},
        incident=incident,
        knowledge_sources=[],
        stream_events=[],
    )
    assert "House of Yes" in result.underwriting_memo.summary
```

> Note: confirm `IncidentCreate`'s import path with `grep -rn "class IncidentCreate" backend/app` before running; fix the import line if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py::test_runtime_passes_venue_name_into_memo -v`
Expected: FAIL — `"House of Yes"` not in summary (runtime doesn't pass `venue_name` yet).

- [ ] **Step 3: Thread `venue_name` through the runtime**

In `backend/app/agents/runtime.py`, change `_run_underwriter_memo_agent`'s signature (line 583) to accept `venue_name`:

```python
    def _run_underwriter_memo_agent(
        self,
        *,
        incident: IncidentCreate,
        risk_signal: RiskSignal,
        citations: list[Citation],
        venue_name: str | None = None,
    ) -> UnderwritingMemo:
```

Add `venue_name=venue_name,` to BOTH `draft_memo(...)` calls inside it (the primary at ~line 596 and the deterministic fallback at ~line 610), right after `incident_location=incident.location,`.

At the `execute` call site (line 97), pass the venue name:

```python
        underwriting_memo = self._run_underwriter_memo_agent(
            incident=incident,
            risk_signal=risk_signal,
            citations=citations,
            venue_name=venue.get("name") if isinstance(venue, dict) else None,
        )
```

> Verify the exact current keyword args at line 97 first (`grep -n "_run_underwriter_memo_agent(" app/agents/runtime.py`) and add only the `venue_name=` kwarg.

- [ ] **Step 4: Weave `venue_name` into the LLM prompts**

In `backend/app/providers/gemini_provider.py` `draft_memo`, change the `user_prompt` so the incident line includes the venue:

```python
        venue_line = f"Venue: {venue_name}\n" if venue_name else ""
        user_prompt = f"""Draft an underwriting memo for this incident:

{venue_line}Incident: {incident_summary}
Location: {incident_location}
Risk type: {risk_type}
Severity: {severity} (confidence: {confidence:.0%})

Supporting citations:
{citations_block}

Return JSON with keys: summary (string), open_questions (list of strings)."""
```

Apply the equivalent one-line `Venue:` addition to the user prompt in `anthropic_provider.py`'s `draft_memo`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/app/agents/runtime.py backend/app/providers/gemini_provider.py backend/app/providers/anthropic_provider.py backend/tests/test_memo_credibility.py
git commit -m "feat(memo): thread venue_name through runtime and LLM prompts"
```

---

### Task 4: Add `score_memo_specificity` scorer + wire it into the runner

**Files:**
- Modify: `backend/app/evals/runner.py:242-248` (`_RunOutput`), `:349-353` (`run_scenario` return), `:379-399` (`_score_standard_scenario`)
- Modify: `backend/app/evals/scorers.py` (new scorer)
- Test: `backend/tests/test_memo_credibility.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_memo_credibility.py`:

```python
from types import SimpleNamespace
from app.evals import scorers


def _fake_actual(summary: str, excerpts: list[str]):
    citations = [SimpleNamespace(excerpt=e, source_id=f"s{i}") for i, e in enumerate(excerpts)]
    memo = SimpleNamespace(summary=summary)
    return SimpleNamespace(underwriting_memo=memo, citations=citations)


def test_specificity_passes_when_grounded():
    actual = _fake_actual(
        'rear-bar: altercation. Corroborated by 1 source(s), incl. "Door staff intervened at 1:42am.".',
        ["Door staff intervened at 1:42am."],
    )
    incident = SimpleNamespace(location="rear-bar")
    assert scorers.score_memo_specificity(actual, incident).passed


def test_specificity_fails_on_generic_memo():
    actual = _fake_actual(
        "Physical altercation creates liquor-liability exposure. Standard review applies.",
        ["Door staff intervened at 1:42am."],
    )
    incident = SimpleNamespace(location="rear-bar")
    assert not scorers.score_memo_specificity(actual, incident).passed


def test_specificity_skips_when_nothing_to_ground():
    actual = _fake_actual("Some memo text.", [])
    incident = SimpleNamespace(location="")
    assert scorers.score_memo_specificity(actual, incident).passed  # trivially passes
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py -k specificity -v`
Expected: FAIL with `AttributeError: module 'app.evals.scorers' has no attribute 'score_memo_specificity'`.

- [ ] **Step 3: Add the scorer**

In `backend/app/evals/scorers.py`, add at the end of the file:

```python
def _norm(text: str) -> str:
    return " ".join((text or "").lower().split())


def score_memo_specificity(actual: UnderwritingPacketAgentResult, incident: Any) -> ScorerResult:
    """Grounding invariant: the memo names the incident location and quotes a
    real citation. Conditional — only asserts what exists, so a scenario with
    no location and no citations trivially passes (nothing to ground against).
    """
    summary = _norm(getattr(actual.underwriting_memo, "summary", "") or "")
    failures: list[str] = []

    location = (getattr(incident, "location", "") or "").strip()
    if location and _norm(location) not in summary:
        failures.append(f"location {location!r} not referenced in memo summary")

    excerpts = [c.excerpt for c in actual.citations if getattr(c, "excerpt", None)]
    if excerpts:
        prefixes = [_norm(e)[:40] for e in excerpts if _norm(e)]
        if prefixes and not any(p and p in summary for p in prefixes):
            failures.append("no citation excerpt fragment quoted in memo summary")

    passed = not failures
    detail = "ok" if passed else "; ".join(failures)
    return ScorerResult(name="memo_specificity", passed=passed, score=1.0 if passed else 0.0, detail=detail)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && python -m pytest tests/test_memo_credibility.py -k specificity -v`
Expected: all PASS.

- [ ] **Step 5: Wire the scorer into the runner**

In `backend/app/evals/runner.py`, add an `incident` field to `_RunOutput` (line 242):

```python
@dataclass
class _RunOutput:
    scenario_id: str
    description: str
    actual: UnderwritingPacketAgentResult | None
    incident: "IncidentCreate | None" = None
    error: str | None = None
    scorer_results: list[ScorerResult] = field(default_factory=list)
```

In `run_scenario` (the success-path `return _RunOutput(...)` near line 349), add `incident=incident,`:

```python
        return _RunOutput(
            scenario_id=scenario["scenario_id"],
            description=scenario.get("description", ""),
            actual=actual,
            incident=incident,
        )
```

In `_score_standard_scenario` (line 379), append the new scorer after `score_review_status_match`:

```python
    results.append(scorers.score_memo_specificity(run.actual, run.incident))
```

- [ ] **Step 6: Run the eval suite to verify the scorer runs green on real scenarios**

Run: `cd backend && python -m app.evals.runner` (deterministic stack — the default).
Expected: completes; `memo_specificity` appears in the per-scorer output and passes on the standard scenarios. If any standard scenario fails it, inspect that scenario's location/citations and the generated memo before proceeding.

- [ ] **Step 7: Commit**

```bash
git add backend/app/evals/scorers.py backend/app/evals/runner.py backend/tests/test_memo_credibility.py
git commit -m "feat(evals): pin memo grounding with score_memo_specificity"
```

---

### Task 5: Regenerate baseline + scoreboard, full-suite verification

**Files:**
- Modify: `backend/app/evals/eval-baseline.json` (or wherever the baseline writer emits — confirm path)
- Modify: `frontend/public/eval-baseline.json` (public scoreboard data)

- [ ] **Step 1: Find the baseline-write command**

Run: `cd backend && python -m app.evals.runner --help`
Read the flags; identify the baseline-write flag (e.g. `--write-baseline` / `--update-baseline`) and the scoreboard export path. If unclear, `grep -rn "write\|baseline\|eval-baseline.json\|public" app/evals/runner.py app/evals/baseline.py`.

- [ ] **Step 2: Regenerate the baseline + public scoreboard**

Run the baseline-write command identified in Step 1 (deterministic stack). Confirm the new `memo_specificity` scorer is recorded in both the backend baseline JSON and `frontend/public/eval-baseline.json`. A new scorer is a non-regression per `baseline.py` (`new_scorers` are allowed), so the gate will accept it.

- [ ] **Step 3: Run the comparison gate to confirm no regression**

Run: `cd backend && python -m app.evals.runner --compare-baseline`
Expected: exit 0, no `REGRESSED` lines; `memo_specificity` shows as a baseline entry (or NEW on the first run before the regen, which is fine).

- [ ] **Step 4: Full backend suite**

Run: `cd backend && python -m pytest -q`
Expected: all pass (was 776 before this work + the new `test_memo_credibility.py` cases). Confirm `structural`, citation, and factor scorers did not regress.

- [ ] **Step 5: Commit**

```bash
git add backend/app/evals/eval-baseline.json frontend/public/eval-baseline.json
git commit -m "chore(evals): refresh baseline + scoreboard with memo_specificity"
```

---

## Self-Review

**Spec coverage:**
- Structural weaving (lead/risk/citation/recommendation) → Task 2. ✅
- Determinism rules (sentence trim, citation trim, confidence bands) → Task 2 helpers + `test_same_input_is_byte_identical`. ✅
- Optional `venue_name` across providers + LLM prompts use it → Tasks 1 & 3. ✅
- `score_memo_specificity` invariant-only, conditional, hard gate → Task 4. ✅
- `_RunOutput.incident` enabler → Task 4 Step 5. ✅
- Distinctness + determinism unit tests → Task 2. ✅
- Baseline + scoreboard regen, full-suite, no regression → Task 5. ✅
- `open_questions` + `MemoOutput` schema untouched → not modified in any task. ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code. Two explicit *verify-before-edit* notes (IncidentCreate import path in Task 3; baseline-write flag in Task 5) are deliberate discovery steps, not placeholders — each has the command to resolve it.

**Type consistency:** `venue_name: str | None = None` identical across base + 3 impls + `_run_underwriter_memo_agent`. Scorer named `score_memo_specificity` and `ScorerResult(name="memo_specificity", ...)` used consistently in Task 4 code, test, and runner wiring. `_RunOutput.incident` set in `run_scenario` and read as `run.incident` in `_score_standard_scenario`.
