---
name: wiki-compile
description: >-
  Compile raw workspace documents into a structured OKF (Open Knowledge Format)
  knowledge bundle: scan source dirs for changes, extract concepts, write/update
  one concept article per concept, rebuild indexes and glossary, cross-link, and
  update the bundle's metadata + log. Config-driven via okf.config.json (run
  wiki-init first). Trigger when the user says "compile wiki", "编译wiki",
  "update knowledge base", "更新知识库", "ingest", "收录到wiki", "重建wiki", or
  "wiki 编译".
---

# Wiki Knowledge Base Compiler (OKF)

Distill raw documents (PRDs, code notes, design docs, articles, anything in
markdown) into **concept-level** knowledge: one article per concept, cross-linked
and indexed, drawn from multiple sources. Output is a portable OKF bundle.

## Prerequisites

- `okf.config.json` exists (run **`/wiki-init`** first if not).
- The bundle skeleton (`<bundle_dir>/concepts`, `indexes`, `_meta.json`,
  `index.md`, `log.md`) exists — wiki-init creates it.
- Python 3 on PATH; the workspace is a git repo.

## Read the config first

Every run starts by resolving config:

```bash
python ~/.pi/agent/skills/wiki-compile/scripts/okf_config.py --vault .
```

It tells you: `bundle_dir`, `scan_dirs`, `exclude_patterns`, `output_language`,
`dialect`, `link_style`, `callout_style`, `frontmatter`, `backfill_sources`,
`domains`. **All paths, link rendering, and language below follow this config.**
Scripts read it themselves; you read it to know which dialect templates to emit.
(Below, `<skill>` = this skill's dir, e.g. `~/.pi/agent/skills/wiki-compile`;
`<bundle>` = the configured `bundle_dir`, default `wiki`.)

## Dialect — emit the right markup

| | `okf-pure` (default) | `obsidian` |
|---|---|---|
| Concept link | `[Title](Title.md)` | `[[Title]]` |
| Source ref | `[doc](../docs/x.md)` | `[[docs/x.md\|doc]]` |
| Callout | `> **Note:** …` | `> [!info] …` |
| Frontmatter | OKF fields | Dataview fields |
| Backfill into sources | no | yes |

Use the config's `link_style` / `callout_style` / `frontmatter` to pick. Write
all generated prose in `output_language`.

## Compile pipeline

### Step 1 — SCAN (detect changes)

```bash
python <skill>/scripts/scan_changes.py --vault . --pretty
```

Returns `added` / `changed` / `deleted` / `excluded` / `excluded_compiled`.
Hashing is body-only and EOL-normalized (frontmatter churn never counts as a
change). Per-file opt-out: a source with `wiki_exclude: true` frontmatter is
skipped; `excluded_compiled` lists ones compiled before the flag was added —
surface those to the user, never auto-delete.

If `--full` is requested or `_meta.json.last_compile` is null, treat all as
changed.

### Step 1b — CLASSIFY (patch vs full, for changed files)

```bash
python <skill>/scripts/classify_changes.py --meta <bundle>/_meta.json \
  --threshold 80 <changed-path> ...
```

Each changed file → `mode: patch` (small diff, ≤80 lines: feed the diff only) or
`full` (large diff / no baseline: re-read whole file). Added files always go full.

**Report to user**: N added, M changed (P patch / F full), K deleted, E excluded.
Confirm before proceeding.

### Step 2 — EXTRACT (identify concepts)

For added + changed-full files, read the content and extract:
1. **Concepts** — noun-phrase terms you'd explain separately in a review.
2. **Rules** — single-sentence business/technical rules.
3. **Terms** — definitions (with original-language annotation on first use).
4. **Relations** — cross-references to other concepts.

Granularity: one concept = one term a reader would explain on its own. Too coarse
→ split; too fine (a single enum) → fold into a parent. Map each source to a
domain via `config.domains` (the resolver: `okf_config.py` exposes `domain_for`).

For changed-**patch** files: read only the diff + the concept articles listed in
`_meta.json[path].concepts`; fold added lines in, remove deleted facts, refresh
`timestamp`. If the diff introduces a brand-new concept, promote to full.

Batch >10 files in groups of 5–8; report progress per batch.

### Step 3 — MERGE (write concept articles)

For each concept, create or update `<bundle>/concepts/<Title>.md`.

**okf-pure template:**
```markdown
---
type: concept
title: {Title}
description: {one-sentence definition}
domain: {domain}
timestamp: {ISO-8601}
source_count: {N}
sources:
  - {source/relative/path.md}
tags: [concept, {domain}]
---
# {Title}

> **Auto-compiled** from source documents — re-compile to update.

## Definition
{one-paragraph definition}

## Details
{distilled explanation}

## Rules
- {rule}

## Related
- [{Other}](Other.md)

## Sources
- [{source}]({relative/path.md})
```

**obsidian template:** same sections, but `[[wikilinks]]`, `> [!info]` callout,
and Dataview frontmatter (`last_compiled` instead of `timestamp`, `tags:` as a
block list). When updating an existing article, append into the matching sections
— don't overwrite — and keep `source_count == len(sources)`.

**Size guardrail** after writing:
```bash
python <skill>/scripts/size_check.py --vault . --pretty
```
>16 KB = ERROR (article covers multiple topics → split before continuing);
8–16 KB = WARN.

### Step 4 — INDEX (rebuild navigation)

Per domain, write `<bundle>/indexes/domain-{domain}.md` — a table of that
domain's concepts (`Concept | Summary | Source count`). Also rebuild:
- `<bundle>/indexes/by-type.md` — concepts grouped by source directory
- `<bundle>/indexes/by-concept.md` — concept → sources reverse index
- glossary: `<bundle>/glossary/{glossary|术语表}.md` — term table

Each index/concept row uses the dialect's link style. The `domain-` filename
prefix keeps sub-index basenames distinct from concept names.

### Step 5 — LINK (cross-reference pass)

Ensure each touched/new concept's body links to the other concepts it mentions
and its "Related" section is complete. Default scope = concepts touched this run
+ their source-sharing neighbors (unchanged concepts are assumed valid until
`/wiki-lint`). `--full-link` rescans everything.

### Step 6 — MAP (optional graph)

If ≥5 concepts, regenerate `<bundle>/maps/knowledge-graph.md` (Mermaid) from
shared sources + explicit links.

### Step 7 — MASTER INDEX (slim router)

Rewrite `<bundle>/index.md` as a **slim domain router** (≤3 KB, constant size as
the bundle grows): a `{Domain | Concepts | Sub-index}` table under the
`router_heading`, plus links to the other indexes. Do NOT inline the full concept
list here — that lives in the per-domain sub-indexes. (In `obsidian` dialect,
escape the pipe in a table-cell wikilink as `\|`.)

### Step 8 — BACKFILL (obsidian only)

Only when `backfill_sources: true`:
```bash
python <skill>/scripts/backfill_concepts.py --vault .
```
Injects/refreshes a `concepts:` field in each raw source's frontmatter (the one
documented exception to source immutability — touches only that field). Skipped
entirely in okf-pure.

### Step 9 — META (update _meta.json)

Run **after** any backfill commit lands. Write a manifest, then:
```bash
python <skill>/scripts/apply_compile_results.py --vault . --manifest <path.json>
```
Manifest: `{compile_timestamp, added:{path:[concepts]}, changed:{...}, deleted:[...],
linked_concepts:[...]}`. The script pins `compiled_commit = git HEAD` (refuses if
any added/changed source has uncommitted changes — commit first), recomputes
body hashes and `compile_stats`, atomic-writes with a `.bak`.

### Step 10 — LOG

Append to `<bundle>/log.md`:
```markdown
## [YYYY-MM-DD] compile | {description}
- Mode: {batch / ingest}
- Files: scanned {N} (added {X} / changed {Y})
- Concepts: created {A} / updated {B} / total {C}
```

### Completion report

Scanned N (added/changed/unchanged), skipped E, concepts created/updated/total,
indexes rebuilt, graph nodes/edges.

## Ingest mode (single source)

When the user points at one file ("ingest docs/x.md", "收录这个"), run the full
pipeline on that single file (every step except the batch SCAN), interactively:
READ → DISCUSS takeaways → EXTRACT → MERGE → INDEX → LINK → (MAP) → MASTER INDEX
→ (BACKFILL) → META → LOG. A single file may touch 5–15 bundle pages.

## Source immutability

Raw source files are READ-ONLY during compile. The only exception is Step 8
backfill (obsidian dialect), which touches a single `concepts:` frontmatter
field. Never edit source bodies.

## Parameters

| Flag | Meaning |
|------|---------|
| `--full` | recompile all (ignore cache); implies `--full-link` |
| `--full-link` | force LINK to scan all concepts |
| `--scope {dir}` | compile only one directory |
| `--dry-run` | scan/preview without writing |
| `--ingest {file}` | single-source interactive mode |
