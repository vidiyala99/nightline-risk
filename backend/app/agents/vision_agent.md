# Vision Agent Contract

## Current Runtime Status

`app/agents/vision_agent.py` (`analyze_image` / `analyze_video_keyframes`) is the
only agent that emits **factual visual findings** — injury detail, crowd density,
security presence, environmental hazards, and a corroboration verdict — which flow
downstream into **risk scoring** (the corroboration confidence delta) **and fraud
detection** (`corroboration_agent` → `fraud_agent` red flags). It runs from the
evidence pipeline (`main._process_evidence_sync`), not the packet runtime, so —
like `fraud_agent` and `corroboration_agent` — it is **not** registered in
`runtime.REQUIRED_CONTRACTS` (those are the five packet runtime agents).

Two execution paths, resolved per call:

- **Primary — Gemini 2.5 Flash** (`_call_gemini_vision`) when `GEMINI_API_KEY` is
  set and the file fits inline (≤ ~15MB after base64). The request pins
  `responseSchema=_VISION_SCHEMA` + `responseMimeType=application/json`, so the
  model can only return the contracted fields.
- **Fallback — deterministic template** (`_template_finding`) when no key is set,
  the file is too large, or the API errors. Keyword-routed to a finding family
  (altercation / slip-fall / medical / property / vandalism / general).

Best-effort and non-blocking: any Gemini failure is logged and falls back to the
template; the vision step never blocks incident creation or the packet flow.

This contract is **eval-gated** by `app/evals/vision_scorers.py` (deterministic,
key-free; sibling of `fraud_scorer.py`), run under `tests/test_vision_eval.py` —
the precondition `agents/README.md` originally deferred ("fold the
vision/corroboration agents into the same eval-gated contract").

## Output contract (VisionFinding)

The LLM path's response is mapped through `_gemini_finding_to_dataclass`, which
**clamps** it to the contract regardless of what the model returns:

- `security_response_seconds` → **always None** — a VLM cannot reliably measure a
  response time; the model may not assert one.
- `timestamp_in_exif` → **always None**; `timestamp_matches_report` is not derived
  from the pixels.
- `confidence_delta` → bound strictly to the verdict via `_delta_from_verdict`
  (CONSISTENT 0.10 / PARTIAL 0.05 / CONTRADICTED −0.05 / INCONCLUSIVE 0.01, plus
  0.01 per injury/police/EMS flag) — never a model-chosen number.

So the model contributes *descriptive* fields (indicators, injury prose, hazards,
crowd density, verdict) but cannot inject the *score-moving* integrity fields.

## Honesty invariant (template / no-key path)

Every template finding passes through `_stamp_unverified`, which forces:

- `corroboration` → `INCONCLUSIVE` (nothing was actually compared),
- `timestamp_matches_report` → `False`, `timestamp_in_exif` → `None`,
- `confidence_delta` → `0.0` (template prose cannot move the risk score),
- `raw_description` → prefixed with `[Unverified — template fallback, …]`.

This is the governance guarantee that the no-key path can **never claim a
corroboration it did not perform** — the descriptive prose stays for demo texture,
but the integrity fields tell the truth. `score_vision_honesty` pins it.

## Scored dimensions (key-free)

- `score_vision_routing` — summary routes to the correct finding family.
- `score_vision_honesty` — template findings are always unverified-stamped.
- `score_vision_mapping` — the Gemini→dataclass mapping clamps EXIF /
  response-seconds to None and binds `confidence_delta` to the verdict.
