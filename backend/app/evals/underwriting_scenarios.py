"""Labeled carrier-underwriting scenarios for eval. Labels reflect what a real
underwriter would do — NOT the recommender's internal rules (avoids a circular
scorer). `inputs` is the RecommenderInputs kwargs (money as strings; coerced by
the scorer)."""

UNDERWRITING_SCENARIOS = [
    {
        "id": "clean-tier-a",
        "inputs": {"tier": "A", "total_score": 18, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "9000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "adequate",
        "why": "Clean low-tier account, no losses — straightforward quote.",
    },
    {
        "id": "clean-tier-b-generous-rate",
        "inputs": {"tier": "B", "total_score": 35, "coverage_lines": ["gl", "liquor"],
                   "loss_by_line": {"gl": {"claim_count": 1, "incurred": "1500"}},
                   "indicated_total": "12000", "in_appetite": True},
        "expected_posture": "quote",
        "expected_rate_adequacy": "lean_credit",
        "why": "Minor stale loss, premium generous vs incurred — writable, could credit.",
    },
    {
        "id": "prior-ab-elevated",
        "inputs": {"tier": "B", "total_score": 52, "coverage_lines": ["gl"],
                   "loss_by_line": {"gl": {"claim_count": 2, "incurred": "60000"}},
                   "indicated_total": "18500", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "lean_debit",
        "why": "Repeat GL/A&B losses — write it but attach security conditions; rate thin.",
    },
    {
        "id": "prior-liquor-loss",
        "inputs": {"tier": "C", "total_score": 64, "coverage_lines": ["liquor"],
                   "loss_by_line": {"liquor": {"claim_count": 1, "incurred": "40000"}},
                   "indicated_total": "22000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "lean_debit",
        "why": "Liquor loss at an elevated tier — conditions on service/training; $40k incurred on a $22k premium is thin, lean debit.",
    },
    {
        "id": "elevated-tier-c-clean",
        "inputs": {"tier": "C", "total_score": 60, "coverage_lines": ["gl"],
                   "loss_by_line": {}, "indicated_total": "15000", "in_appetite": True},
        "expected_posture": "quote_with_conditions",
        "expected_rate_adequacy": "adequate",
        "why": "Higher-hazard tier even without losses — a loss-control inspection condition is prudent.",
    },
    {
        "id": "severe-tier-d-adverse",
        "inputs": {"tier": "D", "total_score": 88, "coverage_lines": ["gl", "liquor"],
                   "loss_by_line": {"gl": {"claim_count": 3, "incurred": "120000"}},
                   "indicated_total": "30000", "in_appetite": True},
        "expected_posture": "decline",
        "expected_rate_adequacy": "lean_debit",
        "why": "Worst tier with frequent severe losses — exposure outweighs appetite; decline.",
    },
    {
        "id": "out-of-appetite",
        "inputs": {"tier": "B", "total_score": 40, "coverage_lines": ["gl"],
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
]
