---
name: wiki-init
description: >-
  Bootstrap an OKF (Open Knowledge Format) knowledge bundle in the current
  workspace: write okf.config.json, propose scan directories and domains, and
  create the empty bundle skeleton (concepts/, indexes/, index.md, log.md,
  _meta.json). Run this ONCE per workspace before the first wiki-compile.
  Trigger when the user says "init wiki", "set up knowledge base", "初始化知识库",
  "wiki 初始化", "建知识库", or when /wiki-compile is requested but no
  okf.config.json exists yet.
---

# Wiki Init — Bootstrap an OKF Bundle

This skill turns any workspace into an OKF knowledge bundle so that
`wiki-compile`, `wiki-query`, and `wiki-lint` have a config and a place to write.
It is the first thing to run in a fresh workspace.

## What OKF is (1 paragraph)

The Open Knowledge Format represents knowledge as a directory of markdown files
— one **concept** per file — with a small YAML frontmatter (`type` required;
`title`, `description`, `tags`, `timestamp` recommended), a markdown body, and
normal links between concepts that form a graph. Optional `index.md` (navigation)
and `log.md` (history) files. It is just files + markdown + YAML — portable,
vendor-neutral, readable by any agent. These wiki skills are an OKF
producer/consumer/linter.

## Script location

Scripts live in this skill's `scripts/` folder. Invoke them with the skill's
absolute path and always pass `--vault .` so they target the current workspace:

```bash
python ~/.pi/agent/skills/wiki-init/scripts/init_bundle.py --vault .
```

(Adjust the prefix if the skills directory differs. `python3` on some systems.)

## Workflow

### Step 1 — Detect / confirm dialect

Two dialects, selected by `--dialect`:

| Dialect | When | Links | Frontmatter | Output |
|---------|------|-------|-------------|--------|
| `okf-pure` (default) | Any editor/agent; portable | standard markdown `[t](path.md)` | OKF fields | follows source language |
| `obsidian` | The workspace is an Obsidian vault | `[[wikilink]]` | Dataview + callouts | Chinese-friendly |

If unsure, ask the user one short question; otherwise default to `okf-pure`.

### Step 2 — Preview the proposed config

```bash
python <skill>/scripts/init_bundle.py --vault . --print
```

This scans top-level directories that contain `.md` files and proposes
`scan_dirs` + one domain rule per directory. Show the user the proposed
`scan_dirs` and `domains`, and let them adjust (merge dirs, rename domains, set a
different `bundle_dir`).

### Step 3 — Write config + skeleton

```bash
python <skill>/scripts/init_bundle.py --vault . --dialect okf-pure
# or: --dialect obsidian   |   --bundle-dir kb   |   --force (overwrite)
```

This writes `okf.config.json` at the workspace root and creates
`<bundle_dir>/{concepts,indexes}/`, `index.md`, `log.md`, `_meta.json`.

### Step 4 — Hand off

Tell the user the bundle is ready and to run `/wiki-compile` to distill their
source documents into concepts. Point them at `okf.config.json` for tuning
(`scan_dirs`, `exclude_patterns`, `domains`, `dialect`).

## Config reference (okf.config.json)

| Key | Meaning |
|-----|---------|
| `bundle_dir` | Where the compiled bundle lives (default `wiki`) |
| `scan_dirs` | Source directories to compile from |
| `exclude_patterns` | Path fragments (matched against `/`+relpath) to skip |
| `output_language` | `en` / `zh` / … — language of generated concepts & indexes |
| `dialect` | `okf-pure` or `obsidian` (sets the link/callout/frontmatter profile) |
| `link_style` | `markdown` or `wikilink` |
| `callout_style` | `plain` or `obsidian` |
| `frontmatter` | `okf` or `obsidian-dataview` |
| `backfill_sources` | inject a `concepts:` field back into raw sources (obsidian only) |
| `domains` | `{rules: [{path_prefix, domain}], default}` — source → domain mapping |

Editing any field and re-running `/wiki-compile` is safe.

## Requirements

- Python 3 on PATH (scripts are stdlib-only; no pip packages needed).
- A git repository for the workspace (incremental compile pins `compiled_commit`).
  If the workspace is not a git repo, offer to run `git init`.
