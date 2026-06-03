"""Labeled carrier-underwriting scenarios for eval. Labels reflect what a real
underwriter would do — NOT the recommender's internal rules (avoids a circular
scorer). `inputs` is the RecommenderInputs kwargs (money as strings; coerced by
the scorer)."""

UNDERWRITING_SCENARIOS = [
    {
        "id": "clean-tier-a",
        "inputs": {"tier": "A", "total_score": 90, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "9000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "adequate",
        "why": "Clean low-tier account, no losses — straightforward quote.",
    },
    {
        "id": "clean-tier-b-generous-rate",
        "inputs": {"tier": "B", "total_score": 72, "coverage_lines": ["gl", "liquor"],
                   "loss_by_line": {"gl": {"claim_count": 1, "incurred": "1500"}},
                   "indicated_total": "12000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "lean_credit",
        "why": "Minor stale loss, premium generous vs incurred — writable, could credit.",
    },
    {
        "id": "prior-ab-elevated",
        "inputs": {"tier": "B", "total_score": 66, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 2, "incurred": "60000"}},
                   "indicated_total": "18500", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "lean_debit",
        "why": "Repeat GL/A&B losses — write it but attach security conditions; rate thin.",
    },
    {
        "id": "prior-liquor-loss",
        "inputs": {"tier": "C", "total_score": 50, "coverage_lines": ["liquor"],
                   "loss_by_line": {"liquor": {"claim_count": 1, "incurred": "40000"}},
                   "indicated_total": "22000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "lean_debit",
        "why": "Liquor loss at an elevated tier — conditions on service/training; $40k incurred on a $22k premium is thin, lean debit.",
    },
    {
        "id": "elevated-tier-c-clean",
        "inputs": {"tier": "C", "total_score": 52, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "15000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": "Higher-hazard tier even without losses — a loss-control inspection condition is prudent.",
    },
    {
        "id": "severe-tier-d-adverse",
        "inputs": {"tier": "D", "total_score": 22, "coverage_lines": ["gl", "liquor"],
                   "loss_by_line": {"gl": {"claim_count": 3, "incurred": "120000"}},
                   "indicated_total": "30000", "in_appetite": True},
        "expected_posture": "decline",
        "expected_rate_adequacy": "lean_debit",
        "why": "Worst tier with frequent severe losses — exposure outweighs appetite; decline.",
    },
    {
        "id": "out-of-appetite",
        "inputs": {"tier": "B", "total_score": 65, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "11000", "in_appetite": False},
        "expected_posture": "decline",
        "expected_rate_adequacy": "adequate",
        "why": "Out of appetite regardless of the loss picture — decline.",
    },
    {
        "id": "high-frequency-low-severity",
        "inputs": {"tier": "C", "total_score": 58, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 2, "incurred": "9000"}},
                   "indicated_total": "14000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": "Frequency signal (2 claims) at an elevated tier — conditions warranted, rate ok.",
    },

    # ── Boundary / stress scenarios (probe the decision thresholds) ──────────
    # Labels below are assigned from underwriting first principles, NOT from the
    # recommender's rules, so a disagreement is a real signal about the rule.
    {
        "id": "rate-ratio-0p75-just-under-debit",
        "inputs": {"tier": "B", "total_score": 70, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 1, "incurred": "15000"}},
                   "indicated_total": "20000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "lean_debit",
        "why": ("Boundary: incurred/indicated = 0.75, just under the 0.8 debit "
                "cutoff. A 75% prior-loss-to-premium ratio is genuinely thin — "
                "sound underwriting leans debit here. (Recommender's flat 0.8 "
                "cutoff calls it 'adequate' → documented miss; see commit note.)"),
    },
    {
        "id": "rate-ratio-0p85-just-over-debit",
        "inputs": {"tier": "B", "total_score": 70, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 1, "incurred": "17000"}},
                   "indicated_total": "20000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "lean_debit",
        "why": ("Boundary: incurred/indicated = 0.85, just over the 0.8 cutoff. "
                "Clearly thin → lean debit. Single non-frequency loss under $50k "
                "is not adverse, so a clean quote (no conditions) is right."),
    },
    {
        "id": "tier-b-single-midsize-loss-debatable",
        "inputs": {"tier": "B", "total_score": 68, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 1, "incurred": "30000"}},
                   "indicated_total": "40000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": ("Debatable posture: one $30k GL loss at tier B. First principles "
                "say a $30k nightlife loss is material enough to attach a "
                "loss-control/security subjectivity even at count 1. Recommender's "
                "$50k adverse-severity bar treats it as a clean quote → documented "
                "miss; the $50k bar is defensible so the rule is left as-is."),
    },
    {
        "id": "tier-d-clean-in-appetite",
        "inputs": {"tier": "D", "total_score": 30, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "16000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": ("Worst-tier but CLEAN and in appetite: blanket logic must NOT "
                "auto-decline — a clean tier-D risk is writable with a loss-control "
                "inspection condition. Confirms decline is gated on D *and* adverse, "
                "not tier alone."),
    },
]
