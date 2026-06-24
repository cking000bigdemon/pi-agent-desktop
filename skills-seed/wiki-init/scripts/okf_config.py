#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Shared OKF (Open Knowledge Format) config loader for the wiki-* skills.

These wiki skills operate on ANY OKF-style knowledge bundle. Everything that is
project-specific — scan directories, exclude rules, output language, link /
callout dialect, bundle location, domain taxonomy — lives in one per-project
file that `wiki-init` writes and the user edits:

    <workspace>/okf.config.json              (preferred, OKF-portable root)
    <workspace>/<bundle_dir>/okf.config.json  (default bundle_dir = "wiki")

Resolution order for every setting (first hit wins):
    1. okf.config.json
    2. <bundle_dir>/_meta.json   (legacy home for scan_dirs / exclude_patterns)
    3. built-in DEFAULTS below

DEFAULTS resolve to the portable **okf-pure** dialect (standard markdown links,
plain callouts, OKF frontmatter, no source backfill) — the right default for a
fresh external workspace. A project that wants the Obsidian flavor sets
`"dialect": "obsidian"` (or individual fields) in its okf.config.json.

Stdlib only — no third-party dependencies, no network.
"""
from __future__ import annotations

import json
from pathlib import Path


# ---------------------------------------------------------------------------
# Built-in defaults — portable OKF profile. A bundle with no okf.config.json
# behaves as a generic, vendor-neutral OKF producer/consumer.
# ---------------------------------------------------------------------------

# Exclusion fragments are matched as substrings against `"/" + rel_posix`. The
# surrounding slashes make each fragment a path-segment match (so "/.git/" never
# hits a file literally named "x.gitignore"). One matcher shared by SCAN + lint.
DEFAULT_EXCLUDE_PATTERNS = [
    "/.git/",
    "/.obsidian/",
    "/.claude/",
    "/node_modules/",
    "/assets/",
    "/.trash/",
]

# Reserved index/alias basenames never treated as concept links.
DEFAULT_RESERVED_INDEX_NAMES = ["index", "by-type", "by-concept", "glossary"]

DEFAULTS = {
    "okf_version": "0.1",
    "bundle_dir": "wiki",
    "scan_dirs": [],                       # resolved from _meta.json when absent
    "exclude_patterns": DEFAULT_EXCLUDE_PATTERNS,
    "output_language": "en",
    "dialect": "okf-pure",                 # okf-pure | obsidian
    "link_style": "markdown",              # markdown | wikilink
    "callout_style": "plain",              # plain | obsidian
    "frontmatter": "okf",                  # okf | obsidian-dataview
    "backfill_sources": False,
    "domain_field": "domain",
    "router_heading": "Domains",           # nav-section heading inside index.md
    "reserved_index_names": DEFAULT_RESERVED_INDEX_NAMES,
    "domains": {"rules": [], "default": "general"},
}

# Selecting `"dialect": "obsidian"` flips this whole profile unless the config
# overrides individual fields. Mirrors the Obsidian vault behavior (wikilinks,
# callouts, Dataview frontmatter, raw-source backfill, Chinese output, the
# historical "按业务域导航" router heading and 术语表 glossary name).
_OBSIDIAN_PROFILE = {
    "link_style": "wikilink",
    "callout_style": "obsidian",
    "frontmatter": "obsidian-dataview",
    "backfill_sources": True,
    "output_language": "zh",
    "router_heading": "按业务域导航",
    "reserved_index_names": ["index", "by-type", "by-concept", "术语表"],
    "domains": {"rules": [], "default": "综合"},
}


class OkfConfig:
    """Resolved configuration. Attribute access for every DEFAULTS key."""

    def __init__(self, data: dict, *, vault: Path, config_path: Path | None):
        self._data = data
        self.vault = vault
        self.config_path = config_path
        for k, v in data.items():
            setattr(self, k, v)

    @property
    def bundle_path(self) -> Path:
        return self.vault / self.bundle_dir

    @property
    def concepts_dir(self) -> Path:
        return self.bundle_path / "concepts"

    @property
    def indexes_dir(self) -> Path:
        return self.bundle_path / "indexes"

    @property
    def meta_path(self) -> Path:
        return self.bundle_path / "_meta.json"

    @property
    def is_obsidian(self) -> bool:
        return self.dialect == "obsidian"

    @property
    def is_okf_pure(self) -> bool:
        return self.dialect != "obsidian"

    def domain_for(self, rel_path: str) -> str:
        """Map a source path to its domain via configured prefix rules (longest
        prefix wins)."""
        rel = rel_path.replace("\\", "/")
        best = None
        for rule in self.domains.get("rules", []):
            pref = rule.get("path_prefix", "")
            if pref and rel.startswith(pref):
                if best is None or len(pref) > len(best[0]):
                    best = (pref, rule.get("domain"))
        return best[1] if best else self.domains.get("default", "general")

    def is_excluded(self, rel_posix: str) -> bool:
        probe = "/" + rel_posix.replace("\\", "/")
        return any(frag in probe for frag in self.exclude_patterns)

    def to_dict(self) -> dict:
        return dict(self._data)


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def find_config_path(vault: Path, bundle_dir: str) -> Path | None:
    for cand in (vault / "okf.config.json", vault / bundle_dir / "okf.config.json"):
        if cand.is_file():
            return cand
    return None


def load_config(vault, *, meta: dict | None = None) -> OkfConfig:
    """Resolve config for `vault`. `meta` (a parsed _meta.json) is an optional
    pre-read to supply the legacy scan_dirs fallback without a second disk read."""
    vault = Path(vault).resolve()

    cfg_raw = _read_json(vault / "okf.config.json") or {}
    bundle_dir = cfg_raw.get("bundle_dir", DEFAULTS["bundle_dir"])
    config_path = find_config_path(vault, bundle_dir)
    if config_path is not None:
        cfg_raw = _read_json(config_path) or {}
        bundle_dir = cfg_raw.get("bundle_dir", bundle_dir)

    if meta is None:
        meta = _read_json(vault / bundle_dir / "_meta.json") or {}

    # DEFAULTS -> obsidian profile (if requested) -> explicit config overrides.
    resolved = dict(DEFAULTS)
    if cfg_raw.get("dialect") == "obsidian":
        resolved.update(_OBSIDIAN_PROFILE)
    resolved.update({k: v for k, v in cfg_raw.items() if v is not None})

    if not resolved.get("scan_dirs"):
        resolved["scan_dirs"] = list(meta.get("scan_dirs") or [])

    dom = resolved.get("domains") or {}
    resolved["domains"] = {
        "rules": dom.get("rules", []),
        "default": dom.get("default", DEFAULTS["domains"]["default"]),
    }

    return OkfConfig(resolved, vault=vault, config_path=config_path)


if __name__ == "__main__":
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Print the resolved OKF config.")
    ap.add_argument("--vault", default=".")
    args = ap.parse_args()
    cfg = load_config(args.vault)
    sys.stdout.reconfigure(encoding="utf-8")
    out = cfg.to_dict()
    out["_config_path"] = str(cfg.config_path) if cfg.config_path else None
    print(json.dumps(out, ensure_ascii=False, indent=2))
