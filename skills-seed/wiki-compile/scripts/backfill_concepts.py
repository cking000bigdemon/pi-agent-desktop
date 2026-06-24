#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Backfill `concepts:` frontmatter into raw source files (OKF-generalized).

For each concept article under <bundle>/concepts/, read its `sources:` list and
build a reverse index {source_file: [concept_names]}. Then inject/update a
`concepts:` YAML list in each source file's frontmatter so editors (Obsidian
graph/backlinks, etc.) can surface "this doc is cited by N concepts".

This is a DIALECT-SPECIFIC convenience. It is meaningful only when the project
opts in (`backfill_sources: true`, the Obsidian profile). Under the default
okf-pure profile it is disabled — running it then is a no-op unless --force.

Link rendering follows `link_style`:
  - wikilink: `  - "[[Concept]]"`
  - markdown: `  - "[Concept](/<bundle>/concepts/Concept.md)"`

Non-destructive: only the `concepts:` block is inserted/replaced; all other
frontmatter bytes are preserved. Idempotent.

Usage:
    python backfill_concepts.py --vault <root> [--dry-run] [--verbose] [--force]
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from collections import defaultdict

sys.path.insert(0, str(Path(__file__).resolve().parent))
from io_utils import atomic_write_bytes  # noqa: E402
from okf_config import load_config  # noqa: E402


FM_DELIM = "---"
CONCEPTS_KEY = "concepts"


def _unwrap_wikilink(val: str) -> str:
    val = val.strip()
    if (val.startswith('"') and val.endswith('"')) or (
        val.startswith("'") and val.endswith("'")
    ):
        val = val[1:-1].strip()
    m = re.match(r"^\[\[(.+?)\]\]$", val)
    if m:
        val = m.group(1)
    # markdown link form: [text](path)
    m2 = re.match(r"^\[[^\]]*\]\(([^)]+)\)$", val)
    if m2:
        val = m2.group(1)
    val = val.split("|", 1)[0]
    val = val.split("#", 1)[0]
    return val.strip().lstrip("/")


def split_frontmatter(text: str) -> tuple[str | None, str]:
    if not text.startswith(FM_DELIM):
        return None, text
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip() != FM_DELIM:
        return None, text
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].rstrip() == FM_DELIM:
            end_idx = i
            break
    if end_idx is None:
        return None, text
    raw_block = "".join(lines[1:end_idx])
    body_with_delim = "".join(lines[end_idx:])
    return raw_block, body_with_delim


def parse_sources_from_concept(concept_text: str) -> list[str]:
    raw_fm, _ = split_frontmatter(concept_text)
    if raw_fm is None:
        return []
    m = re.search(r"^sources:\s*\n((?:[ \t]+-[ \t]*.*\n?)+)", raw_fm, re.MULTILINE)
    if not m:
        return []
    items = []
    for line in m.group(1).splitlines():
        item_m = re.match(r"^[ \t]+-[ \t]*(.*?)\s*$", line)
        if item_m:
            val = _unwrap_wikilink(item_m.group(1))
            if val:
                items.append(val)
    return items


def build_reverse_index(cfg) -> dict[str, list[str]]:
    concepts_dir = cfg.concepts_dir
    vault = cfg.vault
    if not concepts_dir.is_dir():
        print(f"ERROR: {concepts_dir} not found", file=sys.stderr)
        sys.exit(1)
    index: dict[str, set[str]] = defaultdict(set)
    for concept_file in concepts_dir.glob("*.md"):
        name = concept_file.stem
        text = concept_file.read_text(encoding="utf-8")
        for src in parse_sources_from_concept(text):
            src_norm = src.replace("\\", "/").strip()
            if not src_norm:
                continue
            if not (vault / src_norm).is_file() and (vault / (src_norm + ".md")).is_file():
                src_norm = src_norm + ".md"
            index[src_norm].add(name)
    return {k: sorted(v) for k, v in index.items()}


def find_concepts_block(raw_fm: str) -> tuple[int, int] | None:
    pattern = re.compile(
        r"^concepts:[ \t]*(?:\S[^\r\n]*)?\r?\n(?:[ \t]+[^\r\n]*\r?\n)*",
        re.MULTILINE,
    )
    m = pattern.search(raw_fm)
    return (m.start(), m.end()) if m else None


def render_concepts_block(concepts: list[str], nl: str, cfg) -> str:
    lines = [f"{CONCEPTS_KEY}:"]
    for c in concepts:
        if cfg.link_style == "wikilink":
            lines.append(f'  - "[[{c}]]"')
        else:
            lines.append(f'  - "[{c}]({cfg.bundle_dir}/concepts/{c}.md)"')
    return nl.join(lines) + nl


def detect_newline(raw: bytes) -> str:
    first = raw.find(b"\n")
    if first > 0 and raw[first - 1:first] == b"\r":
        return "\r\n"
    return "\n"


def apply_to_file(src_file: Path, concepts: list[str], dry_run: bool, cfg) -> tuple[bool, str]:
    raw = src_file.read_bytes()
    nl = detect_newline(raw)
    text = raw.decode("utf-8")
    raw_fm, body_with_delim = split_frontmatter(text)
    new_block = render_concepts_block(concepts, nl, cfg)

    if raw_fm is None:
        new_text = f"{FM_DELIM}{nl}{new_block}{FM_DELIM}{nl}{text}"
    else:
        span = find_concepts_block(raw_fm)
        if span is None:
            if raw_fm and not raw_fm.endswith(("\n", "\r")):
                raw_fm = raw_fm + nl
            new_fm = raw_fm + new_block
        else:
            start, end = span
            if raw_fm[start:end] == new_block:
                return False, "unchanged"
            new_fm = raw_fm[:start] + new_block + raw_fm[end:]
        new_text = f"{FM_DELIM}{nl}{new_fm}{body_with_delim}"

    new_bytes = new_text.encode("utf-8")
    if new_bytes == raw:
        return False, "unchanged"
    if not dry_run:
        atomic_write_bytes(src_file, new_bytes)
    return True, "updated"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, help="Workspace root")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--force", action="store_true",
                        help="run even when backfill_sources is disabled in config")
    args = parser.parse_args()

    cfg = load_config(args.vault)
    if not cfg.vault.is_dir():
        print(f"ERROR: vault {cfg.vault} not found", file=sys.stderr)
        return 1

    if not cfg.backfill_sources and not args.force:
        print("backfill_sources is disabled in okf.config.json — nothing to do "
              "(pass --force to override).")
        return 0

    print(f"Vault: {cfg.vault}")
    print(f"Mode:  {'DRY-RUN' if args.dry_run else 'WRITE'}  link_style={cfg.link_style}")
    print()

    reverse_index = build_reverse_index(cfg)
    print(f"Reverse index: {len(reverse_index)} source files reference concepts")

    updated = unchanged = 0
    missing: list[str] = []
    for rel_path, concepts in reverse_index.items():
        src_file = cfg.vault / rel_path
        if not src_file.is_file():
            missing.append(rel_path)
            continue
        changed, _ = apply_to_file(src_file, concepts, args.dry_run, cfg)
        if changed:
            updated += 1
            if args.verbose or args.dry_run:
                action = "DRY-RUN would update" if args.dry_run else "update"
                print(f"  {action}: {rel_path} -> {len(concepts)} concepts")
        else:
            unchanged += 1

    print()
    print("Summary:")
    print(f"  Files updated:   {updated}")
    print(f"  Files unchanged: {unchanged}")
    print(f"  Missing sources: {len(missing)}")
    if missing and args.verbose:
        for m in missing:
            print(f"    - {m}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
