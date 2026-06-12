"""Verify-seed for the `coverage_exclusion_review` broker finding (Phase 1).

Guarantees the three conditions on `elsewhere-brooklyn` so the broker Exposure
panel shows a HIGH "Review excluded exposure (E&O)" card:

  1. an in-force Policy            (reuses ensure_eb_current_policy → EB-DEMO-2026-0001)
  2. assault-&-battery + liquor incidents   (the venue's actual loss exposure)
  3. ingested policy_exclusion clauses naming assault & battery + liquor

Idempotent — safe to re-run (incidents skip by id; clauses skip by content hash;
the policy is ensured, not duplicated).

Run from backend/ against LOCAL sqlite:
    python -m scripts.seed_verify_exclusion

Against PROD (Neon, to check on the live site) — use the Postgres PUBLIC url:
    DATABASE_URL=<DATABASE_PUBLIC_URL> python -m scripts.seed_verify_exclusion

Then log in as the broker and open:  /risk-profile/elsewhere-brooklyn
"""
from __future__ import annotations

import hashlib
import sys

from sqlmodel import Session

from app.database import engine
from app.knowledge_sources import INGESTED_ORIGIN
from app.models import IncidentRecord, SourceRecord
from app.policy_document import build_policy_tree
from scripts.seed_demo_placements import ensure_eb_current_policy

VENUE_ID = "elsewhere-brooklyn"

# An Exclusions section that carves back out the two things this venue actually
# loses money on — the canonical nightlife E&O gap.
EXCLUSION_POLICY = """## Exclusions

### 9.1 Excluded Conduct — Assault and Battery
Bodily injury arising out of assault, battery, or any physical altercation
between patrons or involving staff is excluded from coverage under this Policy,
regardless of whether the act was intended or foreseeable.

### 9.3 Excluded Conduct — Known Intoxication
Claims arising from liquor service to a patron the Insured's staff knew or
should reasonably have known was visibly intoxicated are excluded under the
liquor liability section.
"""

INCIDENTS = [
    ("inc-verify-ab1", "Brawl broke out near the main bar; two patrons in a fight."),
    ("inc-verify-ab2", "Altercation by the front door; security had to intervene."),
    ("inc-verify-liq", "Patron over-served and visibly intoxicated; refused further service."),
]


def _seed_incidents(session: Session) -> int:
    created = 0
    for iid, summary in INCIDENTS:
        if session.get(IncidentRecord, iid):
            continue
        session.add(IncidentRecord(
            id=iid, venue_id=VENUE_ID, occurred_at="2026-05-01", location="Main floor",
            summary=summary, reported_by="Door staff", injury_observed=False,
            police_called=False, ems_called=False, status="open",
        ))
        created += 1
    return created


def _ingest_exclusions(session: Session) -> int:
    """Same flatten-to-SourceRecord path as POST /venues/{id}/policy-docs,
    content-hash idempotent."""
    _tree, leaves = build_policy_tree(text=EXCLUSION_POLICY, source_file="verify_master.md")
    inserted = 0
    for chunk in leaves:
        content = chunk["content"]
        content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
        source_id = f"ingested-{content_hash[:16]}"
        if session.get(SourceRecord, source_id):
            continue
        meta = dict(chunk.get("metadata", {}))
        source_type = "policy_exclusion" if meta.get("is_exclusion") else "policy"
        session.add(SourceRecord(
            id=source_id, venue_id=VENUE_ID, source_type=source_type,
            origin_system=INGESTED_ORIGIN, external_ref="verify_master.md",
            excerpt=content[:2000], content_hash=content_hash, source_metadata=meta,
        ))
        inserted += 1
    return inserted


def main() -> int:
    with Session(engine) as session:
        policy = ensure_eb_current_policy(session)
        session.commit()
    with Session(engine) as session:
        incidents = _seed_incidents(session)
        clauses = _ingest_exclusions(session)
        session.commit()

    print(f"[verify] in-force policy : {'created EB-DEMO-2026-0001' if policy else 'already present'}")
    print(f"[verify] incidents added : {incidents}")
    print(f"[verify] exclusion clauses ingested : {clauses}")
    print()
    print(f"[verify] Log in as the broker and open /risk-profile/{VENUE_ID}")
    print("[verify] Expect a HIGH 'Review excluded exposure (E&O)' card in the Exposure")
    print("[verify] panel — A&B is the venue's #1 loss and the policy excludes it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
