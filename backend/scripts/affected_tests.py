"""Select only the test files affected by your current changes.

The full suite is large; most changes touch a handful of modules. This maps a
git diff -> the test files that (transitively) import the changed `app.*` modules,
so you can run `pytest <those files>` instead of everything.

Usage (from backend/):
    python -m scripts.affected_tests                # vs working tree + staged
    python -m scripts.affected_tests --base main    # vs a base ref
    python -m scripts.affected_tests --run          # run pytest on the selection
    python -m scripts.affected_tests --run -- -x -q # pass args through to pytest

Heuristic, not a proof: it follows static `import app.x` / `from app.x import`
edges. It is intentionally conservative — a changed module with no importing test
selects nothing, and changed test files always select themselves. For a
belt-and-suspenders check before merge, still run the full suite (CI does).
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
APP = BACKEND / "app"
TESTS = BACKEND / "tests"

_IMPORT_RE = re.compile(r"^\s*(?:from|import)\s+(app(?:\.[\w]+)*)", re.MULTILINE)


def _module_name(path: Path) -> str:
    """app/services/claims.py -> app.services.claims ; .../__init__.py -> package."""
    rel = path.relative_to(BACKEND).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _imports_of(path: Path) -> set[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return set()
    return {m.group(1) for m in _IMPORT_RE.finditer(text)}


def _resolve(mod: str, known: set[str]) -> set[str]:
    """Map an imported dotted name to known module names. `app.services.claims`
    may resolve to that module or to the `app.services.claims` symbol imported
    from `app.services` package — match the longest known prefix plus the package."""
    out = set()
    if mod in known:
        out.add(mod)
    # `from app.services import claims` -> import name is `app.services`; also pull
    # the package so a change to the package __init__ counts.
    parts = mod.split(".")
    while parts:
        cand = ".".join(parts)
        if cand in known:
            out.add(cand)
            break
        parts = parts[:-1]
    return out


def _git_changed(base: str | None) -> list[Path]:
    if base:
        cmd = ["git", "diff", "--name-only", f"{base}...HEAD"]
        tracked = subprocess.run(cmd, cwd=BACKEND, capture_output=True, text=True).stdout.split()
    else:
        # working tree + staged vs HEAD, plus untracked
        diff = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"], cwd=BACKEND, capture_output=True, text=True
        ).stdout.split()
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=BACKEND, capture_output=True, text=True,
        ).stdout.split()
        tracked = diff + untracked
    repo_root = BACKEND.parent
    return [repo_root / f for f in tracked]


def select(base: str | None = None) -> tuple[list[Path], set[str]]:
    app_files = list(APP.rglob("*.py"))
    test_files = list(TESTS.rglob("test_*.py"))
    known = {_module_name(p) for p in app_files} | {_module_name(p) for p in app_files if p.name != "__init__.py"}

    # app module -> direct app deps
    app_deps: dict[str, set[str]] = {}
    for p in app_files:
        name = _module_name(p)
        deps = set()
        for imp in _imports_of(p):
            deps |= _resolve(imp, known)
        deps.discard(name)
        app_deps[name] = deps

    def closure(seeds: set[str]) -> set[str]:
        seen, stack = set(), list(seeds)
        while stack:
            m = stack.pop()
            if m in seen:
                continue
            seen.add(m)
            stack.extend(app_deps.get(m, ()))
        return seen

    changed = _git_changed(base)
    changed_app = {_module_name(p) for p in changed if APP in p.parents or p.parent == APP}
    changed_app = {m for m in changed_app if m in known}
    changed_tests = {p.resolve() for p in changed if (TESTS in p.parents) and p.name.startswith("test_")}

    selected: list[Path] = []
    for t in sorted(test_files):
        if t.resolve() in changed_tests:
            selected.append(t)
            continue
        seeds = set()
        for imp in _imports_of(t):
            seeds |= _resolve(imp, known)
        if closure(seeds) & changed_app:
            selected.append(t)
    return selected, changed_app


def main(argv: list[str]) -> int:
    base = None
    run = False
    passthrough: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--base" and i + 1 < len(argv):
            base = argv[i + 1]; i += 2; continue
        if a == "--run":
            run = True; i += 1; continue
        if a == "--":
            passthrough = argv[i + 1:]; break
        i += 1

    selected, changed_app = select(base)
    rels = [str(p.relative_to(BACKEND)).replace("\\", "/") for p in selected]
    if changed_app:
        print(f"# changed app modules: {', '.join(sorted(changed_app))}", file=sys.stderr)
    if not selected:
        print("# no affected test files for this diff", file=sys.stderr)
        return 0
    if run:
        cmd = [sys.executable, "-m", "pytest", *rels, *passthrough]
        return subprocess.call(cmd, cwd=BACKEND)
    print(" ".join(rels))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
