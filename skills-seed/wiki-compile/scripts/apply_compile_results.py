#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
apply_compile_results.py — Write per-compile-run results into <bundle>/_meta.json
(OKF-generalized).

Input is a small JSON manifest the LLM writes after finishing the EXTRACT/MERGE/
LINK steps; this script handles the mechanical parts: body hashing, pinning
compiled_commit, re-deriving compile_stats, atomic write.

Manifest schema (all keys optional; unknown keys rejected):

    {
      "compile_timestamp": "2026-04-24T11:35:00+08:00",  // default = now (local+8)
      "added":   { "<source-path>": ["concept1", ...], ... },
      "changed": { "<source-path>": ["concept1", ...], ... },
      "deleted": [ "<source-path>", ... ],
      "linked_concepts": [ "<concept-name>", ... ]
    }

Paths (bundle dir, concepts dir) and the domain frontmatter field come from
okf.config.json. Requires a git repo (compiled_commit pinning); if HEAD can't be
resolved it errors out.

Usage:
    python apply_compile_results.py --vault . --manifest <path.json> [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from hash_utils import body_md5  # noqa: E402
from io_utils import atomic_write_text  # noqa: E402
from okf_config import load_config  # noqa: E402


CST = timezone(timedelta(hours=8))
KNOWN_MANIFEST_KEYS = {
    "compile_timestamp",
    "added",
    "changed",
    "deleted",
    "linked_concepts",
}


def iso_now_cst() -> str:
    return datetime.now(CST).strftime("%Y-%m-%dT%H:%M:%S+08:00")


def git(args: list[str], cwd: Path) -> str:
    out = subprocess.run(
        ["git", "-C", str(cwd), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if out.returncode != 0:
        return ""
    return out.stdout.strip()


def head_commit(vault: Path) -> str:
    sha = git(["rev-parse", "HEAD"], vault)
    if not sha:
        raise RuntimeError("Could not determine git HEAD — is the workspace a git repo?")
    return sha


def file_has_uncommitted_changes(path: str, vault: Path) -> bool:
    status = git(["status", "--porcelain=v1", "--", path], vault)
    return bool(status.strip())


def derive_domain_counts(concepts_dir: Path, domain_re: re.Pattern) -> dict[str, int]:
    counts: dict[str, int] = {}
    for p in concepts_dir.glob("*.md"):
        text = p.read_text(encoding="utf-8")
        parts = text.split("---", 2)
        if len(parts) < 3:
            continue
        m = domain_re.search(parts[1])
        if m:
            d = m.group(1)
            counts[d] = counts.get(d, 0) + 1
    return counts


def validate_manifest(manifest: dict) -> None:
    unknown = set(manifest.keys()) - KNOWN_MANIFEST_KEYS
    if unknown:
        raise ValueError(f"Unknown manifest keys: {sorted(unknown)}")
    for k in ("added", "changed"):
        v = manifest.get(k) or {}
        if not isinstance(v, dict):
            raise ValueError(f"'{k}' must be a map path->[concepts]")
        for path, concepts in v.items():
            if not isinstance(concepts, list) or not all(isinstance(c, str) for c in concepts):
                raise ValueError(f"'{k}[{path}]' must be a list of concept-name strings")
    if "deleted" in manifest and not (
        isinstance(manifest["deleted"], list)
        and all(isinstance(p, str) for p in manifest["deleted"])
    ):
        raise ValueError("'deleted' must be a list of path strings")
    if "linked_concepts" in manifest and not (
        isinstance(manifest["linked_concepts"], list)
        and all(isinstance(c, str) for c in manifest["linked_concepts"])
    ):
        raise ValueError("'linked_concepts' must be a list of concept-name strings")


def apply(vault: Path, manifest: dict, dry_run: bool) -> int:
    cfg = load_config(vault)
    meta_path = cfg.meta_path
    concepts_dir = cfg.concepts_dir
    domain_re = re.compile(rf"^{re.escape(cfg.domain_field)}:\s*(.+?)\s*$", re.MULTILINE)
    if not meta_path.is_file():
        raise FileNotFoundError(meta_path)

    validate_manifest(manifest)
    timestamp = manifest.get("compile_timestamp") or iso_now_cst()
    commit = head_commit(vault)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))

    files = meta.setdefault("files", {})
    concepts_map = meta.setdefault("concepts", {})

    added = manifest.get("added") or {}
    changed = manifest.get("changed") or {}
    deleted = manifest.get("deleted") or []
    linked = manifest.get("linked_concepts") or []

    dirty_skipped: list[str] = []
    for rel in list(added.keys()) + list(changed.keys()):
        abs_path = vault / rel
        if not abs_path.is_file():
            raise FileNotFoundError(f"manifest path missing on disk: {rel}")
        if file_has_uncommitted_changes(rel, vault):
            dirty_skipped.append(rel)

    if dirty_skipped:
        print(
            "ERROR: the following source files have uncommitted working-tree changes; "
            "recording compiled_commit would be lying about what was compiled. "
            "Commit (or stash) them, then re-run.",
            file=sys.stderr,
        )
        for p in dirty_skipped:
            print(f"  {p}", file=sys.stderr)
        return 2

    touched_files: list[tuple[str, str]] = []
    for rel, concept_list in {**added, **changed}.items():
        abs_path = vault / rel
        files[rel] = {
            "body_hash": body_md5(abs_path),
            "compiled_at": timestamp,
            "compiled_commit": commit,
            "concepts": list(concept_list),
        }
        touched_files.append(("add" if rel in added else "change", rel))

    deleted_actual: list[str] = []
    for rel in deleted:
        if rel in files:
            del files[rel]
            deleted_actual.append(rel)

    linked_actual: list[str] = []
    missing_concepts: list[str] = []
    for name in linked:
        concept_path = concepts_dir / f"{name}.md"
        if not concept_path.is_file():
            missing_concepts.append(name)
            continue
        concepts_map[name] = {
            "linked_at": timestamp,
            "linked_body_hash": body_md5(concept_path),
        }
        linked_actual.append(name)

    if missing_concepts:
        print(
            f"WARNING: {len(missing_concepts)} linked_concepts have no concept article "
            f"on disk (skipped): {missing_concepts}",
            file=sys.stderr,
        )

    domain_counts = derive_domain_counts(concepts_dir, domain_re)
    stats = meta.setdefault("compile_stats", {})
    stats["total_source_files"] = len(files)
    stats["total_concepts"] = sum(1 for _ in concepts_dir.glob("*.md"))
    stats["domains"] = domain_counts
    stats["last_compile_at"] = timestamp
    meta["last_compile"] = timestamp

    print(f"Workspace: {vault}")
    print(f"Commit:    {commit}")
    print(f"Timestamp: {timestamp}")
    print(f"Manifest:  added={len(added)} changed={len(changed)} "
          f"deleted={len(deleted_actual)}/{len(deleted)} linked={len(linked_actual)}/{len(linked)}")
    for verb, rel in touched_files:
        print(f"  {verb:>6}: {rel}")
    for rel in deleted_actual:
        print(f"  delete: {rel}")
    print(f"Stats: {stats['total_source_files']} files, {stats['total_concepts']} concepts, "
          f"{len(domain_counts)} domains")

    if dry_run:
        print("\n[dry-run] not writing _meta.json")
        return 0

    backup = meta_path.with_suffix(".json.bak")
    shutil.copy2(meta_path, backup)
    atomic_write_text(meta_path, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
    print(f"\nUpdated {meta_path} (backup: {backup.name})")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1] if __doc__ else "")
    ap.add_argument("--manifest", required=True, help="Path to manifest JSON")
    ap.add_argument("--vault", default=".", help="Workspace root (default: cwd)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    vault = Path(args.vault).resolve()
    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        print(f"ERROR: manifest not found: {manifest_path}", file=sys.stderr)
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    try:
        sys.exit(apply(vault, manifest, args.dry_run))
    except (ValueError, FileNotFoundError, RuntimeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
