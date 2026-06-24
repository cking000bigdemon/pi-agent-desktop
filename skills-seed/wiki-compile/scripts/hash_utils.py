#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Body-only hashing for wiki-compile SCAN.

Frontmatter changes (title, tags, concepts backfill, obsidian-cli property
edits) do not affect what the wiki compiler should extract — only the body
matters. Hashing body-only makes SCAN classify files correctly and avoids
spurious re-extraction.

Public API:
    strip_frontmatter(text: str) -> str
    extract_frontmatter(text: str) -> str
    body_md5(path: Path | str) -> str
    body_md5_from_bytes(data: bytes) -> str

CLI:
    python hash_utils.py <path> [<path> ...]
        Print "<body-md5>  <path>" per line (md5sum-compatible output).
"""
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path


FM_DELIM = "---"


def strip_frontmatter(text: str) -> str:
    """Return body text with the leading YAML frontmatter block removed.

    The frontmatter block is defined as: the file starts with a line `---`,
    and contains a subsequent line `---`. Everything between (inclusive of
    both delimiters) is removed. If no frontmatter is present, `text` is
    returned unchanged.
    """
    if not text.startswith(FM_DELIM):
        return text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != FM_DELIM:
        return text
    for i in range(1, len(lines)):
        if lines[i].rstrip() == FM_DELIM:
            return "".join(lines[i + 1:])
    # Unterminated frontmatter — treat whole file as body to be conservative.
    return text


def extract_frontmatter(text: str) -> str:
    """Return the YAML frontmatter block (the lines between the leading `---`
    delimiters, excluding the delimiters themselves).

    Empty string if the file has no well-formed leading frontmatter block.
    This is the inverse of `strip_frontmatter` and shares the same notion of
    what counts as frontmatter, so callers that need to read a frontmatter
    field don't reimplement delimiter detection.
    """
    if not text.startswith(FM_DELIM):
        return ""
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != FM_DELIM:
        return ""
    for i in range(1, len(lines)):
        if lines[i].rstrip() == FM_DELIM:
            return "".join(lines[1:i])
    # Unterminated frontmatter — no usable block.
    return ""


def body_md5_from_bytes(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    body = strip_frontmatter(text)
    # Normalize line endings so CRLF (Windows checkout via autocrlf) and LF
    # (git store / Linux) produce the same hash — avoids spurious "changed"
    # classification on cross-machine compiles or after re-checkout.
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    return hashlib.md5(body.encode("utf-8")).hexdigest()


def body_md5(path) -> str:
    return body_md5_from_bytes(Path(path).read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args()
    for p in args.paths:
        try:
            print(f"{body_md5(p)}  {p}")
        except OSError as e:
            print(f"ERROR: {p}: {e}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
