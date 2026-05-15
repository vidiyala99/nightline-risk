"""Tests for the PageIndex policy-tree dispatcher.

Phase 1 ships only the regex-fallback path; the PageIndex LLM call is exercised
in Phase 2 (PDF ingestion). For CI we always run with POLICY_PARSER=regex so
tests are deterministic and free.
"""

import pytest

from app.policy_document import build_policy_tree


SAMPLE_POLICY = """## Coverage Section

### 4.2 Premises Liability
The carrier shall cover bodily injury claims arising from slips, trips, and falls
on insured premises, provided wet floor signage and lighting standards are met.

### 4.3 Liquor Liability
Coverage applies to dram-shop claims when the licensee can demonstrate staff
completed responsible-service training within the calendar year.

## Exclusions

### 5.1 Excluded Activities
Pyrotechnic displays and open flames are excluded from coverage at all venues.
"""


@pytest.fixture(autouse=True)
def _force_regex_mode(monkeypatch):
    monkeypatch.setenv("POLICY_PARSER", "regex")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


def test_regex_fallback_returns_at_least_three_leaves():
    result = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    _, leaves = result
    assert len(leaves) >= 3


def test_regex_fallback_marks_exclusion_leaves():
    _, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    assert any(leaf["metadata"]["is_exclusion"] for leaf in leaves), (
        "At least one leaf from the ## Exclusions section must be flagged"
    )


def test_regex_fallback_preserves_section_and_clause_id():
    _, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    sections = {leaf["metadata"]["section"] for leaf in leaves}
    assert "Coverage Section" in sections
    assert "Exclusions" in sections
    clause_ids = {leaf["metadata"]["clause_id"] for leaf in leaves}
    assert "4.2" in clause_ids
    assert "5.1" in clause_ids


def test_regex_fallback_assigns_sequential_page_numbers():
    """Markdown has no real pages; we synthesize one page per leaf so the
    citation chip can still render a `p.X` anchor in the demo. PageIndex will
    overwrite with real PDF pages in Phase 2."""
    _, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    page_starts = [leaf["metadata"]["page_start"] for leaf in leaves]
    assert page_starts == list(range(1, len(leaves) + 1))
    for leaf in leaves:
        assert leaf["metadata"]["page_end"] == leaf["metadata"]["page_start"]


def test_regex_fallback_assigns_unique_node_ids():
    _, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    node_ids = [leaf["metadata"]["node_id"] for leaf in leaves]
    assert all(nid for nid in node_ids), "node_id must be non-empty for every leaf"
    assert len(set(node_ids)) == len(node_ids), "node_ids must be unique within a doc"


def test_regex_fallback_builds_path_breadcrumb():
    _, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    premises = next(l for l in leaves if l["metadata"]["clause_id"] == "4.2")
    assert premises["metadata"]["path"] == "Coverage Section > 4.2 Premises Liability"


def test_regex_fallback_returns_hierarchical_tree_json():
    tree, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    assert tree["title"] == "master.md"
    assert isinstance(tree["children"], list)
    section_titles = {c["title"] for c in tree["children"]}
    assert "Coverage Section" in section_titles
    assert "Exclusions" in section_titles
    # every leaf in the flat list must be reachable from the tree
    flat_node_ids = {l["metadata"]["node_id"] for l in leaves}
    tree_leaf_ids = set()

    def walk(node):
        if not node.get("children"):
            tree_leaf_ids.add(node["node_id"])
        for child in node.get("children", []):
            walk(child)

    walk(tree)
    assert flat_node_ids == tree_leaf_ids


def test_pageindex_mode_falls_back_when_no_api_key(monkeypatch):
    """If POLICY_PARSER=pageindex but OPENAI_API_KEY is unset, dispatcher must
    silently fall back to regex rather than crash. This protects local dev and
    CI from accidental network calls."""
    monkeypatch.setenv("POLICY_PARSER", "pageindex")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    tree, leaves = build_policy_tree(text=SAMPLE_POLICY, source_file="master.md")
    assert len(leaves) >= 3
    assert tree["title"] == "master.md"
