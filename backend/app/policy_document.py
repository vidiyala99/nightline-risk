"""PageIndex-style policy tree builder, with a regex fallback for tests/dev.

PageIndex (https://github.com/VectifyAI/PageIndex) is a vectorless reasoning-based
RAG: given a policy doc, it builds a hierarchical JSON tree where each node has a
stable `node_id`, `page_start`/`page_end`, a title, and a summary. We use that
tree to:

  1. Power "deep" reasoning retrieval (Phase 2) without a vector DB.
  2. Anchor compliance citations to a specific clause + page range, so
     broker review decisions can render "Policy §4.2(b) · p.14–15" links.

Phase 1 (this module) ships the dispatcher + a regex fallback that emulates the
tree shape from markdown headings. The fallback is used when:

  - env `POLICY_PARSER=regex` (the default in tests/CI), OR
  - env `OPENAI_API_KEY` is unset (PageIndex needs an LLM), OR
  - the `pageindex` lib import fails.

Phase 2 will wire the real PageIndex call for markdown→PDF and PDF inputs.
"""

from __future__ import annotations

import os
import re
import uuid
from typing import Any


def _new_node_id() -> str:
    return f"node-{uuid.uuid4().hex[:10]}"


def _is_exclusion(*titles: str) -> bool:
    return any("EXCLUSION" in (t or "").upper() for t in titles)


def _regex_build(text: str, source_file: str) -> tuple[dict, list[dict]]:
    """Synthesize a PageIndex-style tree from markdown ## / ### headings.

    Each ### clause becomes a leaf carrying `node_id`, `page_start`, `page_end`,
    `path`, `section`, `clause_id`, `is_exclusion`, and `source_file`. Pages are
    synthesized as 1-per-leaf so the citation chip renders a `p.X` anchor in the
    demo; PageIndex will overwrite with real PDF page ranges in Phase 2.

    The flat leaf list is what `ingest_policy_doc` persists as SourceRecord rows.
    """
    sections = re.split(r"\n## ", text)
    tree: dict[str, Any] = {
        "title": source_file,
        "node_id": _new_node_id(),
        "children": [],
    }
    leaves: list[dict] = []
    page_counter = 1

    for section in sections:
        section_match = re.search(r"^([^\n]+)", section)
        if not section_match:
            continue
        # re.split keeps the leading "## " on the first section (no preceding
        # newline) — strip it so titles are clean for the tree + breadcrumb.
        section_title = section_match.group(1).strip().lstrip("# ").strip()
        section_node: dict[str, Any] = {
            "title": section_title,
            "node_id": _new_node_id(),
            "children": [],
        }

        clauses = re.split(r"\n### ", section)
        for clause in clauses[1:]:
            clause_match = re.search(r"^([^\n]+)", clause)
            if not clause_match:
                continue
            clause_title = clause_match.group(1).strip()
            clause_id = clause_title.split(" ")[0]
            content = clause.strip()
            is_exclusion = _is_exclusion(section_title, clause_title)

            leaf_node_id = _new_node_id()
            path = f"{section_title} > {clause_title}"

            section_node["children"].append({
                "title": clause_title,
                "node_id": leaf_node_id,
                "page_start": page_counter,
                "page_end": page_counter,
                "summary": content[:200],
                "children": [],
            })

            leaves.append({
                "content": f"{section_title} > {content}",
                "metadata": {
                    "section": section_title,
                    "clause_id": clause_id,
                    "is_exclusion": is_exclusion,
                    "source_file": source_file,
                    "node_id": leaf_node_id,
                    "parent_id": section_node["node_id"],
                    "path": path,
                    "page_start": page_counter,
                    "page_end": page_counter,
                },
            })
            page_counter += 1

        if section_node["children"]:
            tree["children"].append(section_node)

    return tree, leaves


def _pageindex_available() -> bool:
    """True only when we can actually invoke PageIndex against a live LLM."""
    if os.getenv("POLICY_PARSER", "regex").lower() != "pageindex":
        return False
    if not os.getenv("OPENAI_API_KEY"):
        return False
    try:
        import pageindex  # noqa: F401
    except Exception:
        return False
    return True


def build_policy_tree(*, text: str, source_file: str = "uploaded_policy.md") -> tuple[dict, list[dict]]:
    """Build a hierarchical policy tree from markdown text.

    Returns `(tree_json, leaves)` where:

      - `tree_json` is the full hierarchical tree (persisted to PolicyDocument.tree_json)
      - `leaves` is a flat list of `{content, metadata}` chunks suitable for
        the existing SourceRecord ingestion loop

    Falls back to the regex parser when PageIndex is unavailable. Both paths
    return the same leaf shape so downstream code doesn't branch.
    """
    if _pageindex_available():
        try:
            return _pageindex_build(text=text, source_file=source_file)
        except Exception:
            # Fall through to regex on any failure — never let an LLM hiccup
            # break broker policy uploads.
            pass
    return _regex_build(text, source_file)


def _pageindex_build(*, text: str, source_file: str) -> tuple[dict, list[dict]]:
    """Real PageIndex invocation (Phase 2 wires the markdown→PDF path).

    Phase 1 ships only the regex fallback to keep CI free of LLM calls; this
    stub raises so the dispatcher falls back. Replace with the real PageIndex
    invocation when adding PDF support.
    """
    raise NotImplementedError(
        "PageIndex live invocation is wired in Phase 2 (PDF ingestion)."
    )
