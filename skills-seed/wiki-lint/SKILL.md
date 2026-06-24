---
name: wiki-lint
description: >-
  Health-check the compiled OKF knowledge bundle: consistency, freshness,
  coverage, connection discovery, gap analysis, and concept size. Outputs a lint
  report with issues and suggestions. Config-driven via okf.config.json; works
  for both okf-pure (markdown links) and obsidian (wikilinks) dialects. Trigger
  when the user says "lint wiki", "wiki检查", "知识库健康检查", "check the knowledge
  base", or "wiki 查一下有没有问题".
---

# Wiki Health Check (Lint)

Find inconsistencies, staleness, missing coverage, and improvement opportunities
in the bundle. Read-only on concept articles (it only writes the lint report).

## Prerequisites

The bundle exists and has compiled concepts. If empty, suggest `/wiki-compile`.

## How to run

Two scripts cover all six categories (paths/dialect come from okf.config.json):

```bash
# Categories 1–5: CONSISTENCY, FRESHNESS, COVERAGE, CONNECTIONS, GAPS
python ~/.pi/agent/skills/wiki-lint/scripts/structural_check.py --vault . --pretty

# Category 6: SIZE (reuses wiki-compile's guardrail)
python ~/.pi/agent/skills/wiki-compile/scripts/size_check.py --vault . --pretty
```

Both emit JSON by default (drop `--pretty`). `structural_check.py` accepts
`--aged-days`, `--overconcentrated-n`, `--short-words`. The script already
handles the dialect's link form, escaped pipes in tables, and broken-link
classification — don't hand-roll these checks; extend `structural_check.py` if a
new check is needed.

> If only the `wiki-lint` skill is installed (no `wiki-compile`), run SIZE from
> this skill's sibling copy or skip it — categories 1–5 are self-contained here.

## Check categories

1. **CONSISTENCY** — router (`index.md`) domain counts vs each
   `domain-{domain}.md` row count; every concept domain has a sub-index; broken
   concept links classified as `concept_known` / `source_resolvable` /
   `truly_broken` (only the last is a real finding); terminology drift and
   contradictory rules across articles.
2. **FRESHNESS** — sources with git commits after their `compiled_at`; concepts
   aged past N days; orphan concepts (all sources deleted).
3. **COVERAGE** — raw `.md` under `scan_dirs` absent from `_meta.json.files`;
   ghosts (meta entries with no file); per-directory coverage %. `wiki_exclude`
   sources are not counted as gaps.
4. **CONNECTIONS** (full-scan safety net for compile's incremental LINK) —
   concept pairs sharing 2+ sources but not cross-linked; merge candidates (very
   short) and split candidates (very long).
5. **GAPS** — terms implied across articles but lacking their own concept;
   domain imbalance; glossary misses.
6. **SIZE** — concepts >8 KB (WARN) / >16 KB (ERROR, propose a split).

## Output

Write `<bundle>/indexes/lint-report.md` in `output_language` with a summary table
(issues/suggestions per category) and a section per category listing findings.
Use the dialect's callout style for emphasis (`> [!warning]` in obsidian, plain
`> **Warning:**` in okf-pure).

## Post-lint actions

Suggest concrete next steps: re-compile stale scopes
(`/wiki-compile --scope {dir}`), pick up uncovered files (`/wiki-compile --full`),
reset the LINK baseline on recurring connection gaps (`/wiki-compile --full-link`),
split oversized concepts, and resolve contradictory rules by checking sources.

## Notes

- Lint is read-only on concept articles; it only writes the lint report.
- Run after each major compile cycle. Git tracks report history.
