#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SCAN step for wiki-compile (OKF-generalized).

Walks scan_dirs (from okf.config.json, falling back to <bundle>/_meta.json),
computes body-only md5 for every .md source, compares against stored hashes in
_meta.json, and classifies each path as added / changed / deleted / unchanged.

Scan dirs and exclude rules are config-driven — see okf_config.py. With no
okf.config.json present, the portable okf-pure defaults apply.

Output: JSON to stdout (and optionally --out) with the shape:

    {
      "added":     ["<path>", ...],
      "changed":   ["<path>", ...],
      "deleted":   ["<path>", ...],
      "excluded":  ["<path>", ...],
      "excluded_compiled": ["<path>", ...],
      "unchanged_count": N,
      "scanned_count":   M,
      "excluded_count":  E
    }

Per-file opt-out (frontmatter): a source whose frontmatter carries
`wiki_exclude: true` is removed from added/changed/unchanged classification and
reported under `excluded`. `excluded_compiled` is the subset also present in
_meta.json.files (compiled before the flag was added).

Usage:
    python scan_changes.py [--vault .] [--out changes.json] [--pretty]

Path normalization: output paths are vault-relative, forward-slash only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

from hash_utils import body_md5_from_bytes, extract_frontmatter
from okf_config import load_config


def _full_md5_variants(raw: bytes) -> set[str]:
    """Full-file md5 under raw / LF-normalized / CRLF-normalized bytes (legacy
    entries may have stored md5 computed on either line-ending style)."""
    lf = raw.replace(b"\r\n", b"\n")
    crlf = lf.replace(b"\n", b"\r\n")
    return {
        hashlib.md5(raw).hexdigest(),
        hashlib.md5(lf).hexdigest(),
        hashlib.md5(crlf).hexdigest(),
    }


_WIKI_EXCLUDE_RE = re.compile(r"^wiki_exclude\s*:\s*(.+?)\s*$", re.MULTILINE)
_TRUTHY = {"true", "yes", "on", "1"}


def is_wiki_excluded(raw: bytes) -> bool:
    """True if the file's frontmatter sets `wiki_exclude` truthy (top-level)."""
    text = raw.decode("utf-8", errors="replace")
    fm = extract_frontmatter(text)
    if not fm:
        return False
    m = _WIKI_EXCLUDE_RE.search(fm)
    if not m:
        return False
    val = m.group(1).strip().strip('"').strip("'").lower()
    return val in _TRUTHY


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vault", default=".")
    ap.add_argument("--meta", default=None, help="override meta path (default: <bundle>/_meta.json)")
    ap.add_argument("--out", default=None, help="optional path to write JSON")
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    vault = Path(args.vault).resolve()
    cfg = load_config(vault)
    meta_path = Path(args.meta) if args.meta else cfg.meta_path
    if not meta_path.is_absolute():
        meta_path = vault / meta_path

    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.is_file() else {}
    files_meta = meta.get("files", {})

    scan_dirs = cfg.scan_dirs
    if not scan_dirs:
        print("ERROR: no scan_dirs in okf.config.json or _meta.json", file=sys.stderr)
        return 2

    current: dict[str, tuple[str, bytes]] = {}
    excluded: list[str] = []
    for d in scan_dirs:
        base = vault / d
        if not base.exists():
            continue
        for p in base.rglob("*.md"):
            rel = p.relative_to(vault).as_posix()
            if cfg.is_excluded(rel):
                continue
            try:
                raw = p.read_bytes()
            except OSError as e:
                print(f"WARN: {rel}: {e}", file=sys.stderr)
                continue
            if is_wiki_excluded(raw):
                excluded.append(rel)
                continue
            current[rel] = (body_md5_from_bytes(raw), raw)

    added, changed, unchanged = [], [], []
    for rel, (bh, raw) in current.items():
        e = files_meta.get(rel)
        if e is None:
            added.append(rel)
            continue
        stored_body = e.get("body_hash")
        if stored_body:
            (unchanged if stored_body == bh else changed).append(rel)
            continue
        stored_full = e.get("hash")
        if stored_full and stored_full in _full_md5_variants(raw):
            unchanged.append(rel)
        else:
            changed.append(rel)

    excluded_set = set(excluded)
    deleted = [p for p in files_meta if p not in current and p not in excluded_set]
    excluded_compiled = [p for p in excluded if p in files_meta]

    result = {
        "added": sorted(added),
        "changed": sorted(changed),
        "deleted": sorted(deleted),
        "excluded": sorted(excluded),
        "excluded_compiled": sorted(excluded_compiled),
        "unchanged_count": len(unchanged),
        "scanned_count": len(current),
        "excluded_count": len(excluded),
    }

    payload = json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None)
    if args.out:
        Path(args.out).write_text(payload, encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
