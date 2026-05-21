# Customer Action Agent Contract

## Purpose

Convert underwriting evidence gaps into venue/customer-facing tasks that help complete the packet and improve claims defensibility.

## Current Runtime Status

Loaded at runtime by the deterministic underwriting packet agent runtime. Customer actions currently use Python template logic; no LLM call is made.

## Inputs

- `venue`: venue profile and operational owner context.
- `incident`: reported incident facts.
- `retrieved_sources`: citations and source gaps from retrieval.
- `stream_events`: operational signals and event timing.
- `policy_context`: policy or carrier evidence requirements.
- `prior_packet_outputs`: risk signal, memo open questions, and timeline gaps.

## Outputs

Return JSON-compatible fields:

```json
{
  "actions": [
    {
      "title": "string",
      "rationale": "string",
      "owner": "venue|broker|nightline",
      "priority": "low|medium|high",
      "evidence_needed": ["string"],
      "due_window": "string",
      "related_source_ids": ["string"]
    }
  ],
  "review_status": "ready|needs_review|blocked",
  "open_questions": ["string"]
}
```

## Decision Rules

- Actions must be practical for venue or customer operators, not internal model instructions.
- Preserve separation between venue-facing tasks and underwriter-facing conclusions.
- Prioritize evidence preservation, same-night records, witness/contact details, and policy-required documentation.
- Higher-risk incidents should produce higher-priority evidence tasks.
- Do not ask the customer to assert facts the packet cannot support; ask for the evidence needed to resolve them.

## Citation Requirements

- Each action should include `related_source_ids` when a source created or contextualized the task.
- Missing evidence can drive an action without a citation, but the rationale must name the gap.
- Do not cite underwriter memo text as the source of a venue action unless the memo includes source-backed evidence.

## Failure / Escalation Behavior

- Return `needs_review` if task ownership is ambiguous.
- Return `blocked` if required action context is absent, such as unknown venue id or no incident facts.
- Escalate when customer-facing wording could imply liability admission.

## Future Runtime Integration

Use this contract after retrieval and risk evaluation. Runtime implementation should enforce owner labels, priority labels, and evidence-needed fields before returning actions to the frontend.

## Evaluation Cases

- Current brawl packet should ask for video preservation, witness/contact completion, and manager/security narrative.
- Injury or EMS involvement should raise preservation and documentation priority.
- Missing venue id should return `blocked`.
