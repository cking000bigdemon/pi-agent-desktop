---
name: okf-visualizer
description: >-
  Render the compiled OKF knowledge bundle as a single self-contained,
  interactive HTML graph (concepts as nodes colored by domain, links as edges).
  No backend, no CDN, no network — the data stays in the file. An OKF reference
  consumer. Trigger when the user says "visualize wiki", "知识图谱", "可视化知识库",
  "show the knowledge graph", "okf graph", or wants to browse the bundle visually.
---

# OKF Visualizer

Turn any OKF bundle into one portable HTML file that draws the concept graph —
a force-directed view with domain coloring, filtering, and per-concept detail
(description + sources). The output is self-contained: open it in any browser,
share it as a file, host it anywhere. Nothing leaves the page.

## Prerequisites

A compiled bundle (`<bundle>/concepts/*.md`). If empty, run `/wiki-compile` first.

## Run

```bash
python ~/.pi/agent/skills/okf-visualizer/scripts/build_visualizer.py --vault . --open
```

- Output defaults to `<bundle>/okf-graph.html` (override with `--out`).
- `--open` launches it in the default browser; omit to just write the file.
- Reads `okf.config.json` for `bundle_dir`, `link_style`, and `domain_field`, so
  it works for both okf-pure (markdown links) and obsidian (wikilinks) bundles.

## What it shows

- **Nodes** — one per concept, sized by link degree, colored by `domain`.
- **Edges** — concept→concept links parsed from article bodies.
- **Sidebar** — domain legend (click to toggle), concept filter box, and a detail
  panel (description, domain, link count, sources) when a node is clicked.
- Drag a node to reposition, scroll to zoom, drag the background to pan.

## Notes

- Pure stdlib Python; the renderer is inline vanilla JS (no dependencies).
- Re-run after each compile to refresh the graph.
- The HTML embeds a snapshot of the bundle data at generation time.
