#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_visualizer.py — Turn an OKF bundle into a single self-contained HTML graph.

Reads <bundle>/concepts/*.md, parses frontmatter (title, domain, description,
sources) and body links (markdown or wikilink, per okf.config.json dialect),
builds a concept graph (nodes = concepts colored by domain; edges = concept→
concept links), and writes ONE self-contained HTML file with the data embedded
and the force-directed renderer inlined. No backend, no external CDN, no
network — the data never leaves the page. This is an OKF reference *consumer*.

Layout/rendering is force-graph (MIT, vendored at ../vendor/force-graph.min.js
and inlined into the output). It replaced a hand-rolled O(N^2) simulation that
never cooled down, so the graph vibrated forever and burned a core doing it;
force-graph's warmup/cooldown ticks freeze the layout once it settles.

Usage:
    python build_visualizer.py --vault . [--out wiki/okf-graph.html] [--open]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from okf_config import load_config  # noqa: E402

_WIKILINK = re.compile(r"\[\[((?:\\.|[^\]|#])+?)(?:#[^\]|]+)?(?:\\?\|[^\]]+)?\]\]")
_MDLINK = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)]+)\)")
_MD_TITLE = re.compile(r'^(\S.*?)\s+"[^"]*"\s*$')


def parse_frontmatter(text: str):
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        return {}, text
    fm_txt, body = m.group(1), text[m.end():]
    fm, cur = {}, None
    for line in fm_txt.splitlines():
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*:\s", line) or re.match(r"^[A-Za-z_][A-Za-z0-9_]*:$", line):
            k, _, v = line.partition(":")
            cur = k.strip()
            fm[cur] = v.strip() if v.strip() else []
        elif line.startswith("  - ") and cur is not None and isinstance(fm.get(cur), list):
            fm[cur].append(line[4:].strip())
    return fm, body


def link_targets(body: str, link_style: str):
    """Yield concept-link target basenames. Parses BOTH wikilink and markdown
    forms (mutually exclusive on real content), so the graph is dialect-agnostic
    and finds edges whether the bundle was compiled okf-pure or obsidian — even
    when no okf.config.json pins link_style. `link_style` is accepted for
    signature compatibility but no longer gates which form is read."""
    seen = set()
    # Obsidian wikilinks: [[Target]] / [[Target#h]] / [[Target|alias]]
    for mo in _WIKILINK.finditer(body):
        t = mo.group(1).strip()
        if "/" in t or not t or t in seen:
            continue
        seen.add(t)
        yield t
    # Markdown links: [text](path.md)
    for mo in _MDLINK.finditer(body):
        dest = mo.group(1).strip()
        if dest.startswith(("http://", "https://", "mailto:", "#")):
            continue
        if dest.startswith("<"):
            dest = dest[1:].split(">", 1)[0]
        tm = _MD_TITLE.match(dest)
        if tm:
            dest = tm.group(1)
        dest = dest.split("#", 1)[0].strip()
        base = os.path.basename(dest)
        if base.endswith(".md"):
            base = base[:-3]
        if base and base not in seen:
            seen.add(base)
            yield base


def build_graph(cfg) -> dict:
    concepts_dir = cfg.concepts_dir
    nodes, edges_set = [], set()
    names = set()
    raw = {}
    for p in sorted(concepts_dir.glob("*.md")):
        name = p.stem
        names.add(name)
        raw[name] = p.read_text(encoding="utf-8")
    for name in sorted(names):
        fm, body = parse_frontmatter(raw[name])
        domain = fm.get(cfg.domain_field)
        domain = domain if isinstance(domain, str) and domain else "general"
        desc = fm.get("description")
        desc = desc if isinstance(desc, str) else ""
        srcs = fm.get("sources") if isinstance(fm.get("sources"), list) else []
        nodes.append({
            "id": name, "domain": domain, "desc": desc,
            "sources": srcs, "deg": 0,
        })
        for tgt in link_targets(body, cfg.link_style):
            if tgt in names and tgt != name:
                edges_set.add(tuple(sorted([name, tgt])))
    deg = {}
    for a, b in edges_set:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    for n in nodes:
        n["deg"] = deg.get(n["id"], 0)
    domains = sorted({n["domain"] for n in nodes})
    return {
        "nodes": nodes,
        "edges": [{"s": a, "t": b} for a, b in sorted(edges_set)],
        "domains": domains,
        "title": cfg.vault.name,
        "okf_version": cfg.okf_version,
    }


VENDOR_JS = Path(__file__).resolve().parent.parent / "vendor" / "force-graph.min.js"

HTML_TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__ — OKF graph</title>
<style>
:root{--bg:#0a0a0a;--panel:#141414;--border:#2a2a2a;--text:#e8e8e8;--muted:#9a9a9a;--accent:#0050EF}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);
font-family:"Segoe UI",system-ui,sans-serif;overflow:hidden}
#wrap{display:flex;height:100%}
#side{width:300px;flex:none;background:var(--panel);border-right:1px solid var(--border);
padding:14px;overflow:auto}
#side h1{font-size:15px;margin:0 0 4px}#side .sub{color:var(--muted);font-size:12px;margin-bottom:12px}
.leg{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0;cursor:pointer;user-select:none}
.leg .sw{width:12px;height:12px;flex:none}.leg.off{opacity:.35}
#detail{margin-top:14px;border-top:1px solid var(--border);padding-top:12px;display:none}
#detail h2{font-size:14px;margin:0 0 6px}#detail .d{color:var(--muted);font-size:12px;line-height:1.5}
#detail ul{padding-left:16px;margin:8px 0;font-size:12px;color:var(--muted)}
/* flex item holding the force-graph canvas. min-width/height:0 + overflow:hidden
   stop the canvas from feeding its own size back into the flex layout (which
   would make the ResizeObserver below oscillate). */
#cv{flex:1;min-width:0;min-height:0;overflow:hidden;position:relative}
#search{width:100%;padding:6px 8px;background:#0a0a0a;border:1px solid var(--border);color:var(--text);
margin-bottom:10px;font-size:13px}
.hint{position:fixed;bottom:8px;right:12px;color:var(--muted);font-size:11px;pointer-events:none}
</style></head>
<body><div id="wrap">
<div id="side">
<h1>__TITLE__</h1><div class="sub">OKF __OKFVER__ · <span id="stat"></span></div>
<input id="search" placeholder="search concepts…">
<div id="legend"></div>
<div id="detail"></div>
</div>
<div id="cv"></div></div>
<div class="hint">drag node · scroll zoom · drag bg pan · click node</div>
<!-- force-graph v1.51.4 — MIT (c) 2018 Vasco Asturiano — vendored, not fetched -->
<script>__VENDOR__</script>
<script>
const DATA = __DATA__;
const PAL=["#0050EF","#00A300","#E3C800","#A20025","#AA00FF","#1BA1E2","#F09609","#60A917","#D80073","#647687","#825A2C","#6D8764"];
const domColor={};DATA.domains.forEach((d,i)=>domColor[d]=PAL[i%PAL.length]);
const off={};DATA.domains.forEach(d=>off[d]=false);
// One stable object per concept: force-graph mutates x/y/vx/vy in place, so
// reusing these across graphData() swaps preserves the settled layout.
const nodes=DATA.nodes.map(n=>({...n}));
const byId={};nodes.forEach(n=>byId[n.id]=n);
const allEdges=DATA.edges.filter(e=>byId[e.s]&&byId[e.t]);
let selected=null,query="",repaintFrames=0;
// userMoved: the user has taken the viewport (pan/zoom/drag), so auto-fit stops
// for good. Driven by real input events below — NOT by onZoom, which also fires
// for our own programmatic fits.
let userMoved=false;
const host=document.getElementById('cv');
document.getElementById('stat').textContent=nodes.length+" concepts · "+allEdges.length+" links";
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function hit(n){return query&&String(n.id).toLowerCase().includes(query);}
function dim(n){return query&&!hit(n);}
function rad(n){return 2+Math.min(n.deg,12)*0.18;}
const live=new Set();
// Highest-degree concepts get first claim on label space below.
const labelOrder=nodes.slice().sort((a,b)=>b.deg-a.deg);
// Labels sit to the RIGHT of their dot at a fixed on-screen size, so the room
// they need is a constant number of screen px on that one side — measure it
// once and reserve it in fitNow(), or the outermost labels get clipped.
const scratch=document.createElement('canvas').getContext('2d');
scratch.font='11px Segoe UI';
const LABEL_PX=Math.round(Math.min(140,Math.max(0,...nodes.map(n=>scratch.measureText(String(n.id)).width))));
// Radii/fonts are divided by the zoom scale so dots and labels keep a constant
// on-screen size — the canvas context is already zoom-transformed here.
function drawNode(n,ctx,scale){
  const r=rad(n)/scale;
  ctx.globalAlpha=dim(n)?0.12:1;
  ctx.beginPath();ctx.arc(n.x,n.y,r,0,6.283);
  ctx.fillStyle=domColor[n.domain]||"#888";ctx.fill();
  if(n===selected){ctx.lineWidth=1.5/scale;ctx.strokeStyle="#fff";ctx.stroke();}
  ctx.globalAlpha=1;
}
// Labels are a separate pass (not part of nodeCanvasObject) so their draw order
// is ours to choose: greedy placement by descending degree, skipping any label
// whose box overlaps one already placed. That culling is also what decides label
// DENSITY — zoomed out only the best-connected concepts find room, and more
// appear as you zoom in. A fixed "hide labels below zoom X" threshold can't do
// that: at whole-graph zoom it blanks every label at once.
function drawLabels(ctx,scale){
  if(!scale)return;
  const fs=11/scale,gap=3/scale,pad=2/scale,placed=[];
  // Visible region, derived from the canvas transform rather than from
  // Graph.screen2GraphCoords(): that helper (like graph2ScreenCoords/centerAt)
  // reads internal state that is still null until the first frame has rendered,
  // and the resulting null comparisons cull every label.
  const m=ctx.getTransform();
  const vis=(m.a&&m.d)?{x0:-m.e/m.a,x1:(ctx.canvas.width-m.e)/m.a,
                        y0:-m.f/m.d,y1:(ctx.canvas.height-m.f)/m.d}:null;
  ctx.font=fs+"px Segoe UI";ctx.textBaseline="middle";
  for(const n of labelOrder){
    if(!live.has(n.id)||dim(n))continue;
    // off-view labels would consume placement slots the on-view ones need
    if(vis&&(n.x<vis.x0||n.x>vis.x1||n.y<vis.y0||n.y>vis.y1))continue;
    // only the clicked node skips collision culling — letting every search hit
    // skip it too stacks matched labels on top of each other
    const forced=(n===selected);
    const t=String(n.id),w=ctx.measureText(t).width;
    const x=n.x+rad(n)/scale+gap,y=n.y;
    const box={x0:x-pad,y0:y-fs*0.6-pad,x1:x+w+pad,y1:y+fs*0.6+pad};
    if(!forced&&placed.some(p=>box.x0<p.x1&&box.x1>p.x0&&box.y0<p.y1&&box.y1>p.y0))continue;
    placed.push(box);
    ctx.fillStyle=(forced||hit(n))?"#ffffff":"#cfcfcf";
    ctx.fillText(t,x,y);
  }
  // this pass runs only on frames that actually drew, so it is the honest place
  // to retire the repaint window opened above
  if(repaintFrames&&--repaintFrames<=0)Graph.autoPauseRedraw(true);
}
function hitArea(n,color,ctx,scale){
  const r=Math.max(8,4+Math.min(n.deg,12)*0.18)/scale;
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(n.x,n.y,r,0,6.283);ctx.fill();
}
const Graph=ForceGraph()(host)
  .backgroundColor('#0a0a0a')
  .nodeId('id')
  // THE fix for the old renderer's permanent vibration: settle off-screen for
  // warmupTicks, run at most cooldownTicks visible frames, then freeze. With
  // autoPauseRedraw (default on) the canvas stops repainting once frozen, so an
  // idle graph costs no CPU.
  .warmupTicks(60)
  .cooldownTicks(240)
  .d3AlphaDecay(0.03)
  .d3VelocityDecay(0.35)
  .linkColor(l=>(query&&!(hit(l.source)||hit(l.target)))?'rgba(255,255,255,0.03)':'rgba(255,255,255,0.10)')
  .linkWidth(0.7)
  .nodeCanvasObject(drawNode)
  .nodePointerAreaPaint(hitArea)
  .onRenderFramePost(drawLabels)
  .onNodeClick(n=>{selected=n;showDetail(n);repaint();})
  .onBackgroundClick(()=>{selected=null;document.getElementById('detail').style.display='none';repaint();})
  // pin where dropped: dragging reheats the engine, so an unpinned node would
  // otherwise spring back to its force equilibrium on release
  .onNodeDragEnd(n=>{n.fx=n.x;n.fy=n.y;})
  // Track the growing layout continuously while it settles, then hold. Fitting
  // per tick (rather than once at engine stop) means the graph is on-screen even
  // if the engine never reaches its cooldown — a background/throttled tab starves
  // requestAnimationFrame, and a one-shot fit at stop would never run there.
  .onEngineTick(()=>{if(!userMoved)fitNow();})
  .onEngineStop(()=>{if(!userMoved)fitNow();});
Graph.d3Force('charge').strength(-160).distanceMax(600);
Graph.d3Force('link').distance(55);
// Style- and viewport-only changes (search dimming, selection ring, a re-fit)
// don't wake the paused renderer, so un-pause it until a few frames have really
// been drawn. Counted in FRAMES, not milliseconds: a backgrounded window gets
// requestAnimationFrame at a crawl, and a time-boxed window would expire before
// a single frame landed, leaving a stale canvas.
function repaint(){repaintFrames=3;Graph.autoPauseRedraw(false);}
// Hand-rolled instead of Graph.zoomToFit(): (a) zoomToFit's padding is uniform,
// but only the RIGHT side needs the label allowance, and spending it on all four
// sides shrinks the graph badly; (b) a non-zero zoomToFit transition is driven by
// the render loop, which autoPauseRedraw has already halted by the time the
// engine stops — the animation freezes part-way and the graph lands off-screen.
// Everything here is an instantaneous transform, so neither trap applies.
function fitNow(){
  const ns=Graph.graphData().nodes;if(!ns.length)return;
  let x0=1/0,x1=-1/0,y0=1/0,y1=-1/0,c=0;
  // Nodes carry no coordinates until the engine has placed them; folding an
  // undefined in here yields a NaN zoom, which wedges the transform permanently.
  for(const n of ns){if(!Number.isFinite(n.x)||!Number.isFinite(n.y))continue;c++;
    if(n.x<x0)x0=n.x;if(n.x>x1)x1=n.x;if(n.y<y0)y0=n.y;if(n.y>y1)y1=n.y;}
  if(!c)return;
  const W=Graph.width(),H=Graph.height(),M=24;
  const k=Math.max(0.02,Math.min((W-2*M-LABEL_PX)/Math.max(1,x1-x0),(H-2*M)/Math.max(1,y1-y0),2));
  Graph.zoom(k,0);
  // shift right by half the label allowance so the reserved room lands on the
  // right, where the text actually goes
  Graph.centerAt((x0+x1)/2+LABEL_PX/(2*k),(y0+y1)/2,0);
  repaint();
}
function resize(){const r=host.getBoundingClientRect();
  Graph.width(Math.max(1,Math.round(r.width))).height(Math.max(1,Math.round(r.height)));
  if(!userMoved)fitNow();}
try{new ResizeObserver(resize).observe(host);}catch(e){window.addEventListener('resize',resize);}
resize();
// Auto-fit yields the moment the user touches the canvas — including a node
// drag, which reheats the engine and would otherwise re-fit under their cursor.
['pointerdown','wheel'].forEach(ev=>host.addEventListener(ev,()=>{userMoved=true;},{passive:true}));
// Legend toggles remove nodes from the SIMULATION, not just from the paint pass
// — hidden concepts used to keep tugging on the visible ones.
function rebuild(){
  const vis=nodes.filter(n=>!off[n.domain]);
  live.clear();vis.forEach(n=>live.add(n.id));
  Graph.graphData({nodes:vis,
    links:allEdges.filter(e=>live.has(e.s)&&live.has(e.t)).map(e=>({source:e.s,target:e.t}))});
}
const leg=document.getElementById('legend');
DATA.domains.forEach(d=>{const el=document.createElement('div');el.className='leg';
el.innerHTML='<span class="sw" style="background:'+domColor[d]+'"></span>'+esc(d)+' ('+nodes.filter(n=>n.domain===d).length+')';
el.onclick=()=>{off[d]=!off[d];el.classList.toggle('off',off[d]);rebuild();};leg.appendChild(el);});
// Search only dims/highlights — relaying out the graph on every keystroke would
// reintroduce exactly the churn this renderer exists to avoid.
document.getElementById('search').oninput=e=>{query=e.target.value.trim().toLowerCase();repaint();};
function showDetail(n){const d=document.getElementById('detail');
  const s=(n.sources&&n.sources.length)?'<div class="d" style="margin-top:8px">sources:</div><ul>'
    +n.sources.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':'';
  d.style.display='block';
  d.innerHTML='<h2>'+esc(n.id)+'</h2><div class="d">'+esc(n.desc||'(no description)')
    +'</div><div class="d" style="margin-top:8px">domain: <b style="color:'+(domColor[n.domain]||'#888')+'">'
    +esc(n.domain)+'</b> · '+n.deg+' links</div>'+s;}
rebuild();
// onEngineTick drives the fit, but requestAnimationFrame is throttled to a crawl
// in a background or non-compositing window, so the tick may not arrive for a
// long time. These timers are not subject to that and keep the first view honest.
[0,400,1500,4000].forEach(ms=>setTimeout(()=>{if(!userMoved)fitNow();},ms));
</script></body></html>"""


def render(graph: dict) -> str:
    try:
        vendor = VENDOR_JS.read_text(encoding="utf-8")
    except OSError as exc:
        raise SystemExit(f"ERROR: missing vendored renderer {VENDOR_JS} ({exc})")
    # Defensive: a literal </script inside the payload would close the tag early.
    vendor = vendor.replace("</script", "<\\/script")
    data = json.dumps(graph, ensure_ascii=False).replace("</script", "<\\/script")
    html = HTML_TEMPLATE
    # Substitute the small placeholders first — __DATA__/__VENDOR__ carry
    # arbitrary vault text and must not be scanned for later placeholders.
    html = html.replace("__TITLE__", graph["title"] or "Knowledge Bundle")
    html = html.replace("__OKFVER__", str(graph.get("okf_version", "0.1")))
    html = html.replace("__DATA__", data)
    html = html.replace("__VENDOR__", vendor)
    return html


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vault", default=".")
    ap.add_argument("--out", default=None, help="default: <bundle>/okf-graph.html")
    ap.add_argument("--open", action="store_true", help="open in default browser")
    args = ap.parse_args()

    cfg = load_config(args.vault)
    if not cfg.concepts_dir.is_dir():
        print(f"ERROR: no concepts dir at {cfg.concepts_dir} — compile the bundle first.",
              file=sys.stderr)
        return 1
    graph = build_graph(cfg)
    out = Path(args.out) if args.out else (cfg.bundle_path / "okf-graph.html")
    if not out.is_absolute():
        out = cfg.vault / out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(graph), encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"Wrote {out}  ({len(graph['nodes'])} nodes, {len(graph['edges'])} edges, "
          f"{len(graph['domains'])} domains)")
    if args.open:
        webbrowser.open(out.as_uri())
    return 0


if __name__ == "__main__":
    sys.exit(main())
