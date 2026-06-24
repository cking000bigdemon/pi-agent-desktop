#!/usr/bin/env python3
"""
size_check.py — Concept article size guardrails (OKF-generalized).

Scans <bundle>/concepts/*.md and reports articles exceeding size thresholds:
  - WARN:  > 8192 bytes  (8 KB)  — may have drifted beyond single-term scope
  - ERROR: > 16384 bytes (16 KB) — almost certainly covers multiple topics

Concepts dir is resolved from okf.config.json (bundle_dir) unless --concepts-dir
is given explicitly.

Output: JSON to stdout (machine-readable) or --pretty for a human summary.
Exit codes: always 0, unless --strict (error -> 2, warn -> 1).

Usage:
  python size_check.py --vault . --pretty
  python size_check.py --concepts-dir wiki/concepts
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from okf_config import load_config  # noqa: E402


DEFAULT_WARN_BYTES = 8 * 1024
DEFAULT_ERROR_BYTES = 16 * 1024


def scan(concepts_dir: Path, warn_bytes: int, error_bytes: int) -> dict:
    results = {"ok": [], "warn": [], "error": [],
               "thresholds": {"warn": warn_bytes, "error": error_bytes}}
    for p in sorted(concepts_dir.glob("*.md")):
        size = p.stat().st_size
        entry = {"path": p.as_posix(), "bytes": size}
        if size > error_bytes:
            results["error"].append(entry)
        elif size > warn_bytes:
            results["warn"].append(entry)
        else:
            results["ok"].append(entry)
    return results


def print_pretty(results: dict, concepts_dir: Path) -> None:
    total = len(results["ok"]) + len(results["warn"]) + len(results["error"])
    warn_b = results["thresholds"]["warn"]
    err_b = results["thresholds"]["error"]
    print(f"Scanned {total} concept articles under {concepts_dir.as_posix()}/")
    print(f"  OK    (<= {warn_b} B): {len(results['ok'])}")
    print(f"  WARN  (>  {warn_b} B): {len(results['warn'])}")
    print(f"  ERROR (>  {err_b} B): {len(results['error'])}")
    if results["error"]:
        print("\nERROR — should split (covers multiple distinct topics):")
        for e in sorted(results["error"], key=lambda x: -x["bytes"]):
            print(f"  {e['bytes']:>8} B  {e['path']}")
    if results["warn"]:
        print("\nWARN — consider splitting on next touch:")
        for e in sorted(results["warn"], key=lambda x: -x["bytes"]):
            print(f"  {e['bytes']:>8} B  {e['path']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1] if __doc__ else "")
    ap.add_argument("--vault", default=".")
    ap.add_argument("--concepts-dir", default=None,
                    help="override; default = <bundle_dir>/concepts from okf.config.json")
    ap.add_argument("--warn-bytes", type=int, default=DEFAULT_WARN_BYTES)
    ap.add_argument("--error-bytes", type=int, default=DEFAULT_ERROR_BYTES)
    ap.add_argument("--pretty", action="store_true")
    ap.add_argument("--json-only", action="store_true")
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args()

    if args.concepts_dir:
        concepts_dir = Path(args.concepts_dir)
    else:
        concepts_dir = load_config(args.vault).concepts_dir

    if not concepts_dir.is_dir():
        print(f"ERROR: not a directory: {concepts_dir}", file=sys.stderr)
        sys.exit(2)

    results = scan(concepts_dir, args.warn_bytes, args.error_bytes)

    if args.pretty:
        print_pretty(results, concepts_dir)
    elif args.json_only:
        print(json.dumps(results, ensure_ascii=False))
    else:
        print(json.dumps(results, ensure_ascii=False, indent=2))

    if args.strict:
        if results["error"]:
            sys.exit(2)
        if results["warn"]:
            sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
