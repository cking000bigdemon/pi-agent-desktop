#!/usr/bin/env python3
"""
structural_check.py — Bulk lint scan for an OKF knowledge bundle (generalized).

Runs five of wiki-lint's six categories in one pass (SIZE is handled by
wiki-compile/scripts/size_check.py):

  1. CONSISTENCY — router (index.md nav) vs domain sub-index row counts; every
     concept domain has a sub-index; broken concept links (concept_known /
     source_resolvable / truly_broken).
  2. FRESHNESS   — aged-out concepts; sources with git commits after compiled_at;
     orphan concepts (all sources missing).
  3. COVERAGE    — raw .md under scan_dirs not in _meta.json.files; ghosts;
     per-directory coverage %.
  4. CONNECTIONS — concept pairs sharing N+ sources but not cross-linked.
  5. GAPS        — short concepts; over-concentrated concepts; meta tracking gap.

All paths, exclude rules, link dialect, domain field and router heading come
from okf.config.json (see okf_config.py). Works for both okf-pure (markdown
links) and obsidian (wikilinks) dialects.

Usage:
  python structural_check.py --vault . --pretty
Run from the workspace root (or pass --vault). Exit code is always 0.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from okf_config import load_config  # noqa: E402


# Obsidian wikilink: [[target]], [[target#h]], [[target|alias]], escaped \| in tables.
_WIKILINK = re.compile(r"\[\[((?:\\.|[^\]|#])+?)(?:#[^\]|]+)?(?:\\?\|[^\]]+)?\]\]")
# Markdown link: [text](dest). dest captured greedily up to the closing paren so
# filenames with spaces survive ("[Refund Policy](Refund Policy.md)"); image
# embeds (![..]) are excluded.
_MDLINK = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)]+)\)")
_MD_TITLE = re.compile(r'^(\S.*?)\s+"[^"]*"\s*$')  # strip an optional "title"


def _md_dest_to_basename(dest: str) -> str:
    dest = dest.strip()
    if dest.startswith("<"):
        dest = dest[1:].split(">", 1)[0]
    m = _MD_TITLE.match(dest)          # [text](url "title")
    if m:
        dest = m.group(1)
    dest = dest.split("#", 1)[0].strip()  # drop anchor
    base = os.path.basename(dest)
    if base.endswith(".md"):
        base = base[:-3]
    return base, ("/" in dest)


def concept_targets(body: str, link_style: str):
    """Yield (target_basename, is_path_qualified) for links in a body."""
    if link_style == "wikilink":
        for mo in _WIKILINK.finditer(body):
            t = mo.group(1).strip()
            if "/" in t:
                # path-qualified wikilink to a raw source, not a bare concept ref
                yield os.path.basename(t), True
            else:
                yield t, False
    else:
        for mo in _MDLINK.finditer(body):
            dest = mo.group(1).strip()
            if dest.startswith(("http://", "https://", "mailto:", "#")):
                continue
            yield _md_dest_to_basename(dest)


def strip_frontmatter(text: str) -> tuple[dict, str]:
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}, text
    fm_txt = m.group(1)
    body = text[m.end():]
    fm: dict = {}
    cur_key = None
    for line in fm_txt.splitlines():
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*:\s", line) or re.match(
            r"^[A-Za-z_][A-Za-z0-9_]*:$", line
        ):
            k, _, v = line.partition(":")
            cur_key = k.strip()
            val = v.strip()
            fm[cur_key] = val if val else []
        elif line.startswith("  - ") and cur_key is not None:
            if isinstance(fm.get(cur_key), list):
                fm[cur_key].append(line[4:].strip())
    return fm, body


def walk_raw_md(cfg, scan_dirs):
    all_md = set()
    for d in scan_dirs:
        abs_d = os.path.join(str(cfg.vault), d)
        if not os.path.isdir(abs_d):
            continue
        for root, _dirs, files in os.walk(abs_d):
            for f in files:
                if not f.endswith(".md"):
                    continue
                rel = os.path.relpath(os.path.join(root, f), str(cfg.vault)).replace("\\", "/")
                if cfg.is_excluded(rel):
                    continue
                all_md.add(rel)
    return all_md


def _truthy_yaml(val: str) -> bool:
    return str(val).strip().strip('"').strip("'").lower() in {"true", "yes", "on", "1"}


def wiki_excluded_set(vault: str, candidates):
    out = set()
    for rel in candidates:
        try:
            with open(os.path.join(vault, rel), encoding="utf-8", errors="replace") as fp:
                text = fp.read()
        except OSError:
            continue
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        fm, _ = strip_frontmatter(text)
        val = fm.get("wiki_exclude")
        if isinstance(val, str) and _truthy_yaml(val):
            out.add(rel)
    return out


def git_log_since(vault, path, since_iso):
    try:
        r = subprocess.run(
            ["git", "log", "-1", "--format=%cI", f"--since={since_iso}", "--", path],
            capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=vault,
        )
        return r.stdout.strip() or None
    except Exception:
        return None


def _unwrap_source(s: str) -> str:
    raw = s.strip()
    if raw.startswith("[[") and raw.endswith("]]"):
        raw = raw[2:-2]
    m = re.match(r"^\[[^\]]*\]\(([^)]+)\)$", raw)
    if m:
        raw = m.group(1)
    return raw.split("|")[0].split("#")[0].strip().lstrip("/")


def check_all(cfg, aged_days, overconcentrated_n, short_words) -> dict:
    vault = str(cfg.vault)
    reserved = set(cfg.reserved_index_names)
    domain_field = cfg.domain_field
    link_style = cfg.link_style

    meta_path = str(cfg.meta_path)
    with open(meta_path, encoding="utf-8") as fp:
        meta = json.load(fp)
    meta_files = meta.get("files", {})
    meta_concepts_map = meta.get("concepts", {})
    scan_dirs = cfg.scan_dirs

    all_md = walk_raw_md(cfg, scan_dirs)

    concepts_dir = str(cfg.concepts_dir)
    concept_body, concept_domain, concept_sources = {}, {}, {}
    for fname in sorted(os.listdir(concepts_dir)):
        if not fname.endswith(".md"):
            continue
        name = fname[:-3]
        with open(os.path.join(concepts_dir, fname), encoding="utf-8") as fp:
            text = fp.read()
        fm, body = strip_frontmatter(text)
        dom = fm.get(domain_field) or "?"
        srcs = fm.get("sources") if isinstance(fm.get("sources"), list) else []
        concept_body[name] = body
        concept_domain[name] = dom if isinstance(dom, str) else "?"
        concept_sources[name] = srcs
    concept_names = set(concept_body)

    basename_map = defaultdict(list)
    for p in all_md:
        basename_map[os.path.basename(p)[:-3]].append(p)

    # ---- 1. CONSISTENCY ----
    index_md = os.path.join(str(cfg.bundle_path), "index.md")
    router_counts = {}
    in_nav = False
    if os.path.isfile(index_md):
        with open(index_md, encoding="utf-8") as fp:
            for line in fp:
                if cfg.router_heading in line:
                    in_nav = True
                    continue
                if in_nav:
                    if line.startswith("## "):
                        break
                    m = re.match(r"^\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|", line)
                    if m:
                        dom = m.group(1).strip()
                        if dom in (cfg.router_heading, "Domain", "业务域", ":--", "---"):
                            continue
                        router_counts[dom] = int(m.group(2))

    sub_counts = {}
    indexes_dir = str(cfg.indexes_dir)
    if os.path.isdir(indexes_dir):
        for fname in os.listdir(indexes_dir):
            if not fname.startswith("domain-") or not fname.endswith(".md"):
                continue
            dom = fname[len("domain-"):-3]
            with open(os.path.join(indexes_dir, fname), encoding="utf-8") as fp:
                txt = fp.read()
            sub_counts[dom] = len(re.findall(r"^\|\s*\[", txt, re.M))

    drift = []
    for dom in set(router_counts) | set(sub_counts):
        if router_counts.get(dom) != sub_counts.get(dom):
            drift.append({"domain": dom, "router": router_counts.get(dom),
                          "sub_index": sub_counts.get(dom)})

    concept_domains = set(concept_domain.values()) - {"?"}
    missing_sub = sorted(concept_domains - set(sub_counts))
    orphan_sub = sorted(set(sub_counts) - concept_domains)

    wl_concept_known = Counter()
    wl_source_resolvable = Counter()
    wl_truly_broken = []
    for name, body in concept_body.items():
        for target, qualified in concept_targets(body, link_style):
            if qualified:
                continue
            if target in reserved or target.startswith("domain-"):
                continue
            if target in concept_names:
                wl_concept_known[target] += 1
            elif target in basename_map:
                wl_source_resolvable[target] += 1
            else:
                wl_truly_broken.append({"from_concept": name, "target": target})

    consistency = {
        "slim_index_drift": drift,
        "missing_subindex_for_domain": missing_sub,
        "orphan_subindex": orphan_sub,
        "wikilinks": {
            "concept_known_refs": sum(wl_concept_known.values()),
            "concept_known_distinct": len(wl_concept_known),
            "source_resolvable_refs": sum(wl_source_resolvable.values()),
            "source_resolvable_distinct": len(wl_source_resolvable),
            "truly_broken": wl_truly_broken,
        },
    }

    # ---- 2. FRESHNESS ----
    now_cst = datetime.now(timezone(timedelta(hours=8)))
    aged_out, modified_after, orphan_concepts = [], [], []
    for path, info in meta_files.items():
        if path not in all_md:
            continue
        compiled_at = info.get("compiled_at")
        if not compiled_at:
            continue
        try:
            ct = datetime.fromisoformat(compiled_at)
        except Exception:
            continue
        if (now_cst - ct).days > aged_days:
            aged_out.append({"path": path, "days": (now_cst - ct).days})
        ts = git_log_since(vault, path, compiled_at)
        if ts:
            modified_after.append({"path": path, "last_commit": ts, "compiled_at": compiled_at})

    for name, srcs in concept_sources.items():
        if not srcs:
            continue
        missing = sum(1 for s in srcs if not os.path.exists(os.path.join(vault, _unwrap_source(s))))
        if missing == len(srcs):
            orphan_concepts.append(name)

    aged_out.sort(key=lambda x: -x["days"])
    modified_after.sort(key=lambda x: x["last_commit"], reverse=True)
    freshness = {
        "aged_out": aged_out,
        "source_modified_after_compile": modified_after,
        "orphan_concepts_all_sources_missing": orphan_concepts,
    }

    # ---- 3. COVERAGE ----
    covered = set(meta_files.keys())
    excluded_raw = wiki_excluded_set(vault, all_md)
    compilable = all_md - excluded_raw
    uncovered = sorted(compilable - covered)
    ghosts = sorted(covered - all_md)

    total_by_dir, covered_by_dir = Counter(), Counter()
    for p in compilable:
        top = p.split("/", 1)[0]
        total_by_dir[top] += 1
        if p in covered:
            covered_by_dir[top] += 1
    per_dir = []
    for d in sorted(total_by_dir):
        t, c = total_by_dir[d], covered_by_dir[d]
        per_dir.append({"dir": d, "total": t, "covered": c,
                        "pct": round(100.0 * c / t, 1) if t else 0})
    coverage = {
        "uncovered": uncovered, "ghosts": ghosts, "per_directory": per_dir,
        "excluded": sorted(excluded_raw),
        "excluded_compiled": sorted(excluded_raw & covered),
    }

    # ---- 4. CONNECTIONS ----
    src_to_concepts = defaultdict(list)
    for name, srcs in concept_sources.items():
        for s in srcs:
            src_to_concepts[_unwrap_source(s)].append(name)
    pair_shared = Counter()
    for clist in src_to_concepts.values():
        uniq = sorted(set(clist))
        for i, a in enumerate(uniq):
            for b in uniq[i + 1:]:
                pair_shared[(a, b)] += 1
    linked_pairs = set()
    for name, body in concept_body.items():
        for target, qualified in concept_targets(body, link_style):
            if not qualified and target in concept_names:
                linked_pairs.add(tuple(sorted([name, target])))
    missing_links = [{"shared": n, "a": a, "b": b}
                     for (a, b), n in pair_shared.items()
                     if n >= 2 and (a, b) not in linked_pairs]
    missing_links.sort(key=lambda x: -x["shared"])
    connections = {"shared_but_unlinked": missing_links}

    # ---- 5. GAPS ----
    short_concepts = [{"name": n, "words": len(re.findall(r"\S+", b))}
                      for n, b in concept_body.items()
                      if len(re.findall(r"\S+", b)) < short_words]
    short_concepts.sort(key=lambda x: x["words"])
    overconcentrated = [{"name": n, "source_count": len(s)}
                        for n, s in concept_sources.items() if len(s) > overconcentrated_n]
    overconcentrated.sort(key=lambda x: -x["source_count"])
    tracked = set(meta_concepts_map.keys())
    gaps = {
        "short_concepts": short_concepts,
        "overconcentrated": overconcentrated,
        "meta_concepts_untracked": sorted(concept_names - tracked),
        "meta_concepts_tracked_count": len(tracked & concept_names),
        "physical_concept_count": len(concept_names),
    }

    return {
        "meta_summary": {
            "last_compile": meta.get("last_compile"),
            "compile_stats": meta.get("compile_stats"),
            "files_tracked": len(covered),
            "concepts_tracked": len(tracked),
            "dialect": cfg.dialect,
        },
        "consistency": consistency,
        "freshness": freshness,
        "coverage": coverage,
        "connections": connections,
        "gaps": gaps,
    }


def print_pretty(result: dict) -> None:
    ms = result["meta_summary"]
    print("=== META SUMMARY ===")
    print(f"  dialect:          {ms.get('dialect')}")
    print(f"  last_compile:     {ms['last_compile']}")
    print(f"  files tracked:    {ms['files_tracked']}")
    print(f"  concepts tracked: {ms['concepts_tracked']}")

    c = result["consistency"]
    print("\n=== 1. CONSISTENCY ===")
    print(f"  router/sub-index drift: {len(c['slim_index_drift'])} "
          + ("OK" if not c['slim_index_drift'] else "DRIFT"))
    for d in c["slim_index_drift"]:
        print(f"    - {d['domain']}: router={d['router']} sub={d['sub_index']}")
    print(f"  domains missing sub-index: {c['missing_subindex_for_domain'] or 'none'}")
    print(f"  orphan sub-indexes:        {c['orphan_subindex'] or 'none'}")
    wl = c["wikilinks"]
    print(f"  links: {wl['concept_known_refs']} -> concepts, "
          f"{wl['source_resolvable_refs']} -> raw sources, "
          f"{len(wl['truly_broken'])} truly broken")
    for b in wl["truly_broken"]:
        print(f"    BROKEN  [{b['target']}]  in  {b['from_concept']}")

    f = result["freshness"]
    print("\n=== 2. FRESHNESS ===")
    print(f"  aged-out concepts:            {len(f['aged_out'])}")
    for x in f["aged_out"][:10]:
        print(f"    {x['days']}d  {x['path']}")
    print(f"  sources modified after compile: {len(f['source_modified_after_compile'])}")
    print(f"  orphan concepts (all sources missing): {len(f['orphan_concepts_all_sources_missing'])}")
    for n in f["orphan_concepts_all_sources_missing"]:
        print(f"    - {n}")

    cov = result["coverage"]
    print("\n=== 3. COVERAGE ===")
    print(f"  uncovered: {len(cov['uncovered'])}   ghosts: {len(cov['ghosts'])}"
          f"   excluded(wiki_exclude): {len(cov.get('excluded', []))}")
    for row in cov["per_directory"]:
        flag = " <50%" if row["pct"] < 50 else ""
        print(f"    {row['dir']}: {row['covered']}/{row['total']} ({row['pct']}%){flag}")
    for p in cov["uncovered"][:10]:
        print(f"    UNCOVERED  {p}")
    for p in cov["ghosts"][:10]:
        print(f"    GHOST      {p}")

    conn = result["connections"]
    print("\n=== 4. CONNECTIONS ===")
    print(f"  shared 2+ sources but not linked: {len(conn['shared_but_unlinked'])}")
    for pair in conn["shared_but_unlinked"][:20]:
        print(f"    [{pair['shared']}]  {pair['a']} <-> {pair['b']}")

    g = result["gaps"]
    print("\n=== 5. GAPS ===")
    print(f"  short concepts:             {len(g['short_concepts'])}")
    for s in g["short_concepts"][:10]:
        print(f"    {s['words']}w  {s['name']}")
    print(f"  over-concentrated:          {len(g['overconcentrated'])}")
    for o in g["overconcentrated"]:
        print(f"    {o['source_count']} sources  {o['name']}")
    print(f"  meta.concepts tracking:     {g['meta_concepts_tracked_count']}/{g['physical_concept_count']}")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("--vault", default=".", help="Workspace root (default: .)")
    p.add_argument("--pretty", action="store_true")
    p.add_argument("--aged-days", type=int, default=30)
    p.add_argument("--overconcentrated-n", type=int, default=8)
    p.add_argument("--short-words", type=int, default=100)
    args = p.parse_args()

    cfg = load_config(args.vault)
    result = check_all(cfg, args.aged_days, args.overconcentrated_n, args.short_words)

    sys.stdout.reconfigure(encoding="utf-8")
    if args.pretty:
        print_pretty(result)
    else:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
