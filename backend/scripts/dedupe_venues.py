"""Merge duplicate venue records.

Duplicates are venues that share a normalized (name, address) key but have
different ids — they pile up because the venue-create path historically keyed
uniqueness on id only (see app/api/v1/venues.py). This script picks one
canonical venue per duplicate group, repoints every table that references the
dropped ids, fixes operator tenant links, deletes the dups, and writes a
`venue.merged` audit event.

Usage (from backend/):
    python -m scripts.dedupe_venues                 # dry-run: print the plan
    python -m scripts.dedupe_venues --apply         # execute (one transaction)
    python -m scripts.dedupe_venues --force-merge bdubs,bdubs-2,user_017 --apply
        # merge an explicit set (e.g. same name, different address) into the
        # first id, bypassing the (name,address) grouping.

Idempotent: re-running after --apply finds no groups and is a no-op. Restart
the backend afterwards so the in-memory VENUES dict rehydrates from the DB.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

from sqlmodel import Session, select

from app.database import engine
from app.models import (
    AlertEvent,
    CameraFeed,
    ClaimProposal,
    ComplianceEvidence,
    IncidentRecord,
    Policy,
    PolicyDocument,
    PolicyRequest,
    SourceRecord,
    Submission,
    UnderwritingPacket,
    UserRecord,
    Venue,
)
from app.packet_core import _add_audit_event

# Every model that carries a venue_id (hard FK + loose columns).
REFERENCING_MODELS = [
    IncidentRecord,
    CameraFeed,
    AlertEvent,
    Submission,
    Policy,
    SourceRecord,
    PolicyDocument,
    UnderwritingPacket,
    ClaimProposal,
    ComplianceEvidence,
    PolicyRequest,
]


def _norm(s: str | None) -> str:
    return " ".join((s or "").strip().casefold().split())


def _dedupe_key(venue: Venue) -> tuple[str, str]:
    try:
        data = json.loads(venue.venue_data) if venue.venue_data else {}
    except (ValueError, TypeError):
        data = {}
    return (_norm(venue.name), _norm(data.get("address")))


def _ref_count(session: Session, venue_id: str) -> int:
    total = 0
    for model in REFERENCING_MODELS:
        total += len(session.exec(select(model).where(model.venue_id == venue_id)).all())
    return total


def _tenant_ids(session: Session) -> set[str]:
    ids: set[str] = set()
    for u in session.exec(select(UserRecord)).all():
        if u.tenant_id:
            ids.add(u.tenant_id)
    return ids


def _choose_canonical(session: Session, venues: list[Venue], tenants: set[str]) -> Venue:
    """Most-referenced wins; tie-break: is an operator's tenant, then a bare
    (un-suffixed) id, then lexically smallest id — deterministic."""
    def key(v: Venue) -> tuple:
        return (
            _ref_count(session, v.id),
            1 if v.id in tenants else 0,
            1 if "-" not in v.id else 0,
            tuple(-ord(c) for c in v.id),  # lexically smaller id wins the max
        )
    return max(venues, key=key)


def _repoint(session: Session, dup_id: str, canonical_id: str) -> dict[str, int]:
    """Move every reference from dup_id to canonical_id. Returns per-table counts."""
    counts: dict[str, int] = {}
    for model in REFERENCING_MODELS:
        rows = session.exec(select(model).where(model.venue_id == dup_id)).all()
        for row in rows:
            row.venue_id = canonical_id
            session.add(row)
        if rows:
            counts[model.__name__] = len(rows)

    # Operator links: tenant_id == dup, and dup inside extra_venue_ids JSON.
    for u in session.exec(select(UserRecord)).all():
        changed = False
        if u.tenant_id == dup_id:
            u.tenant_id = canonical_id
            changed = True
        if u.extra_venue_ids:
            try:
                extras = json.loads(u.extra_venue_ids)
            except (ValueError, TypeError):
                extras = None
            if isinstance(extras, list) and dup_id in extras:
                extras = [canonical_id if x == dup_id else x for x in extras]
                # de-dup while preserving order, drop the canonical if it's also the tenant
                seen: list[str] = []
                for x in extras:
                    if x not in seen and x != u.tenant_id:
                        seen.append(x)
                u.extra_venue_ids = json.dumps(seen)
                changed = True
        if changed:
            session.add(u)
            counts["UserRecord"] = counts.get("UserRecord", 0) + 1
    return counts


def _groups(session: Session, force_merge: list[str] | None) -> list[list[Venue]]:
    all_venues = session.exec(select(Venue)).all()
    by_id = {v.id: v for v in all_venues}
    if force_merge:
        members = [by_id[i] for i in force_merge if i in by_id]
        return [members] if len(members) > 1 else []
    buckets: dict[tuple[str, str], list[Venue]] = defaultdict(list)
    for v in all_venues:
        buckets[_dedupe_key(v)].append(v)
    return [vs for vs in buckets.values() if len(vs) > 1]


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge duplicate venues.")
    parser.add_argument("--apply", action="store_true", help="execute (default: dry-run)")
    parser.add_argument("--force-merge", default="", help="comma-separated venue ids to merge")
    args = parser.parse_args()
    force = [s.strip() for s in args.force_merge.split(",") if s.strip()] or None

    with Session(engine) as session:
        tenants = _tenant_ids(session)
        groups = _groups(session, force)
        if not groups:
            print("No duplicate venue groups found. Nothing to do.")
            return 0

        for members in groups:
            canonical = _choose_canonical(session, members, tenants)
            dups = [v for v in members if v.id != canonical.id]
            print(f"\nGroup: {[v.id for v in members]}  (name={canonical.name!r})")
            print(f"  canonical -> {canonical.id}  (refs={_ref_count(session, canonical.id)})")
            for dup in dups:
                print(f"  merge {dup.id}  (refs={_ref_count(session, dup.id)})")
                if args.apply:
                    moved = _repoint(session, dup.id, canonical.id)
                    _add_audit_event(
                        session=session,
                        actor_id="dedupe_script",
                        actor_type="system",
                        entity_type="venue",
                        entity_id=canonical.id,
                        event_type="venue.merged",
                        event_metadata={"merged_from": dup.id, "moved": moved},
                    )
                    session.delete(dup)
                    print(f"    repointed: {moved}; deleted {dup.id}")

        if args.apply:
            session.commit()
            print("\nApplied. Restart the backend so VENUES rehydrates from the DB.")
        else:
            print("\nDry-run only. Re-run with --apply to execute.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
