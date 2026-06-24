---
name: wiki-query
description: >-
  Answer questions using the compiled OKF knowledge bundle as structured
  context: navigate the domain router and sub-indexes to find relevant concept
  articles, read them, and synthesize a grounded answer with source citations.
  Config-driven via okf.config.json. Trigger when the user says "query wiki",
  "问wiki", "查知识库", "ask the knowledge base", "wiki问答", or asks a complex
  cross-domain question the bundle likely covers.
---

# Wiki-Powered Q&A (OKF)

Answer complex questions by reading the compiled bundle instead of grepping raw
files. Best for cross-domain questions, "what do we know about X", and synthesis
across multiple sources. For a simple single-file lookup, read that file directly
— don't over-use this skill.

## Read the config first

Query is read-only reasoning — just **read `okf.config.json`** directly (at the
workspace root, or `<bundle_dir>/okf.config.json`). No script needed. Take from
it: `bundle_dir` (used as `<bundle>` for all paths below), `link_style`,
`output_language`, `router_heading`. Answer in `output_language` and cite using
the dialect's link style.

> If `okf.config.json` is absent, assume okf-pure defaults (`bundle_dir: wiki`,
> markdown links). If the bundle (`<bundle>/concepts/`) is empty or missing, tell
> the user to run `/wiki-init` then `/wiki-compile` first.

## Query workflow

### 1. Parse the question
Identify target concepts, query type (factual / comparative / exploratory), and
the domain(s) involved.

### 2. Two-hop index lookup
Navigation is sharded by domain, so first-read cost stays constant as the bundle
grows:
1. Read `<bundle>/index.md` (the slim router, ~2 KB). Scan the table under the
   `router_heading` to pick the 1–3 relevant domains.
2. Read each `<bundle>/indexes/domain-{domain}.md` and select the 3–5 most
   relevant concepts from their tables.
3. Optionally read the glossary (`<bundle>/glossary/…`) to resolve terminology.

A single-domain question reads one sub-index; a cross-domain one reads 2–3.

### 3. Deep read
Read the selected concept articles in full. Note key facts, the `sources:` they
cite, and any related concepts worth following (up to ~3 extra source files if
precision demands it).

### 4. Synthesize
- Ground every claim in a concept article or source — no fabrication.
- Cite with the dialect's link style (`[[Concept]]` or `[Concept](path.md)`).
- State gaps explicitly when the bundle doesn't cover part of the question.
- Answer in `output_language`, annotating original-language terms on first use.

### 5. Optional render
If the user wants a file/deck/diagram, write it to the workspace's scratch
location (or wherever they ask).

## Answer template

```
## Answer
{synthesized answer with inline citations}

### Sources
| Concept | Source documents |
|---------|------------------|
| {Concept A} | {src1}, {src2} |

### Gaps
{anything the bundle does not cover}
```

## Notes

- The bundle is a snapshot — for very recent changes, check source files directly.
- This is a **read-only** skill; it never modifies the bundle.
- For questions outside the bundle's scope (general knowledge), just answer
  normally without forcing bundle context.
