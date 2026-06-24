#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Classify Changed files into PATCH vs FULL re-extract using git diff against
the commit recorded in `_meta.json[path].compiled_commit`.

Rationale: body_hash mismatch alone is a binary signal — a one-line tweak and
a full rewrite look identical. Running `git diff <baseline>..HEAD -- <path>`
shows how much actually changed, so SCAN can route small edits to PATCH mode
(feed LLM only the diff + affected concept articles) instead of full re-extract.

Public API:
    classify(path, meta_entry, threshold_lines) -> dict

CLI:
    python classify_changes.py --meta <path-to-meta.json> \
        [--threshold 80] [--since-field compiled_commit] <path> [<path>...]

    Emits one JSON object per path to stdout.
    Shape: {
        "path": str,
        "mode": "patch" | "full",
        "reason": str,
        "diff_lines": int,       # 0 for full/no-baseline
        "diff": str,             # empty for full; unified diff for patch
        "baseline_commit": str,  # may be empty
    }

Fallback to FULL happens when:
    - No `compiled_commit` recorded (first compile of this file)
    - Recorded commit no longer exists (gc/rebase)
    - diff line count exceeds threshold
    - File not tracked in git
    - Any git command errors unexpectedly

Threshold default is 80 combined +/- lines (excluding diff header). Tune via
`--threshold`. Very small threshold (e.g., <30) is noisy on routine table
edits; very large (>200) defeats the purpose.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def _run_git(args, cwd=None):
    """Run git and return (returncode, stdout, stderr). Never raises."""
    try:
        proc = subprocess.run(
            ["git"] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return proc.returncode, proc.stdout, proc.stderr
    except FileNotFoundError:
        return 127, "", "git not found"


def _commit_exists(sha, cwd=None):
    if not sha:
        return False
    rc, _, _ = _run_git(["cat-file", "-e", sha + "^{commit}"], cwd=cwd)
    return rc == 0


def _diff_against_worktree(sha, path, cwd=None):
    """Diff from <sha> to current working tree for <path>.

    Using worktree (not HEAD) so uncommitted edits are included — matches the
    file state the compiler is about to read.
    """
    rc, out, err = _run_git(["diff", "--no-color", sha, "--", path], cwd=cwd)
    if rc != 0:
        return None, err.strip()
    return out, ""


def _count_diff_lines(diff_text):
    """Count +/- content lines, excluding diff headers (--- / +++ / @@)."""
    count = 0
    for line in diff_text.splitlines():
        if not line:
            continue
        if line.startswith("+++") or line.startswith("---"):
            continue
        if line[0] in "+-":
            count += 1
    return count


def classify(path, meta_entry, threshold_lines, since_field="compiled_commit", cwd=None):
    result = {
        "path": path,
        "mode": "full",
        "reason": "",
        "diff_lines": 0,
        "diff": "",
        "baseline_commit": "",
    }

    if not meta_entry:
        result["reason"] = "no-meta-entry"
        return result

    sha = meta_entry.get(since_field, "")
    result["baseline_commit"] = sha

    if not sha:
        result["reason"] = "no-baseline-commit"
        return result

    if not _commit_exists(sha, cwd=cwd):
        result["reason"] = "baseline-commit-missing"
        return result

    diff_text, err = _diff_against_worktree(sha, path, cwd=cwd)
    if diff_text is None:
        result["reason"] = f"git-diff-failed: {err}"
        return result

    if not diff_text.strip():
        # Body hash said "changed" but git says no diff — likely frontmatter-only
        # churn that slipped through (shouldn't happen since we hash body only,
        # but be defensive).
        result["mode"] = "patch"
        result["reason"] = "empty-diff"
        return result

    n_lines = _count_diff_lines(diff_text)
    result["diff_lines"] = n_lines

    if n_lines <= threshold_lines:
        result["mode"] = "patch"
        result["reason"] = f"diff-within-threshold ({n_lines}<={threshold_lines})"
        result["diff"] = diff_text
    else:
        result["mode"] = "full"
        result["reason"] = f"diff-exceeds-threshold ({n_lines}>{threshold_lines})"

    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--meta", required=True, help="Path to wiki/_meta.json")
    parser.add_argument("--threshold", type=int, default=80,
                        help="Max +/- diff lines to qualify as patch (default 80)")
    parser.add_argument("--since-field", default="compiled_commit",
                        help="Meta field name holding the baseline commit SHA")
    parser.add_argument("--cwd", default=None, help="Run git in this directory")
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()

    meta_path = Path(args.meta)
    if not meta_path.exists():
        print(f"ERROR: meta file not found: {meta_path}", file=sys.stderr)
        return 2
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    files = meta.get("files", {})

    # Normalize keys (Windows backslash tolerance).
    def _norm(p):
        return p.replace("\\", "/")
    files_norm = {_norm(k): v for k, v in files.items()}

    for p in args.paths:
        entry = files_norm.get(_norm(p))
        res = classify(p, entry, args.threshold,
                       since_field=args.since_field, cwd=args.cwd)
        print(json.dumps(res, ensure_ascii=False))

    return 0


if __name__ == "__main__":
    sys.exit(main())
