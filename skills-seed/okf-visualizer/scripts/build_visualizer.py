#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_visualizer.py — Turn an OKF bundle into a single self-contained HTML graph.

Reads <bundle>/concepts/*.md, parses frontmatter (title, domain, description,
sources) and body links (markdown or wikilink, per okf.config.json dialect),
builds a concept graph (nodes = concepts colored by domain; edges = concept→
concept links), and writes ONE self-contained HTML file with the data embedded
and a tiny inline force-directed renderer. No backend, no external CDN, no
network — the data never leaves the page. This is an OKF reference *consumer*.

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
#cv{flex:1;display:block;cursor:grab}#cv:active{cursor:grabbing}
#search{width:100%;padding:6px 8px;background:#0a0a0a;border:1px solid var(--border);color:var(--text);
margin-bottom:10px;font-size:13px}
.hint{position:fixed;bottom:8px;right:12px;color:var(--muted);font-size:11px}
</style></head>
<body><div id="wrap">
<div id="side">
<h1>__TITLE__</h1><div class="sub">OKF __OKFVER__ · <span id="stat"></span></div>
<input id="search" placeholder="filter concepts…">
<div id="legend"></div>
<div id="detail"></div>
</div>
<canvas id="cv"></canvas></div>
<div class="hint">drag node · scroll zoom · drag bg pan · click node</div>
<script>
const DATA = __DATA__;
const PAL=["#0050EF","#00A300","#E3C800","#A20025","#AA00FF","#1BA1E2","#F09609","#60A917","#D80073","#647687","#825A2C","#6D8764"];
const cv=document.getElementById('cv'),ctx=cv.getContext('2d');
const domColor={};DATA.domains.forEach((d,i)=>domColor[d]=PAL[i%PAL.length]);
const off={};DATA.domains.forEach(d=>off[d]=false);
const N=DATA.nodes.length;
let nodes=DATA.nodes.map((n,i)=>{const a=i/Math.max(1,N)*6.283, R=110+Math.sqrt(i)*20;
  return {...n,x:Math.cos(a)*R,y:Math.sin(a)*R,vx:0,vy:0};});
const byId={};nodes.forEach(n=>byId[n.id]=n);
const edges=DATA.edges.filter(e=>byId[e.s]&&byId[e.t]);
let view={x:0,y:0,k:1},sel=null,filter="",drag=null,pan=null,frame=0,fitted=false;
const dpr=()=>window.devicePixelRatio||1;
// Coordinates are in CSS pixels; the context is dpr-scaled per frame (setTransform).
let W=0,H=0;
function resize(){const r=cv.getBoundingClientRect();W=Math.max(1,Math.round(r.width));H=Math.max(1,Math.round(r.height));cv.width=Math.round(W*dpr());cv.height=Math.round(H*dpr());fitted=false;}
try{new ResizeObserver(resize).observe(cv);}catch(e){}
window.addEventListener('resize',resize);resize();
document.getElementById('stat').textContent=N+" concepts · "+edges.length+" links";
// legend
const leg=document.getElementById('legend');
DATA.domains.forEach(d=>{const el=document.createElement('div');el.className='leg';
el.innerHTML='<span class="sw" style="background:'+domColor[d]+'"></span>'+d+' ('+nodes.filter(n=>n.domain===d).length+')';
el.onclick=()=>{off[d]=!off[d];el.classList.toggle('off',off[d]);};leg.appendChild(el);});
document.getElementById('search').oninput=e=>{filter=e.target.value.trim().toLowerCase();};
function visible(n){if(off[n.domain])return false;if(filter&&!String(n.id).toLowerCase().includes(filter))return false;return true;}
function fin(v){return Number.isFinite(v)?v:0;}
// force sim — clamped + center gravity so it can't fling nodes off-screen
function step(){
  const rep=1600,spring=0.045,grav=0.015,damp=0.85,maxV=28;
  for(const a of nodes){a.vx*=damp;a.vy*=damp;}
  for(let i=0;i<N;i++){const a=nodes[i];
    for(let j=i+1;j<N;j++){const b=nodes[j];
      let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy;if(d2<1)d2=1;
      const inv=1/Math.sqrt(d2),f=rep/d2*0.02,fx=dx*inv*f,fy=dy*inv*f;
      a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}}
  for(const e of edges){const a=byId[e.s],b=byId[e.t];
    let dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;
    const f=(d-70)*spring,fx=dx/d*f,fy=dy/d*f;
    a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy;}
  for(const n of nodes){n.vx-=n.x*grav;n.vy-=n.y*grav;
    if(n.vx>maxV)n.vx=maxV;else if(n.vx<-maxV)n.vx=-maxV;
    if(n.vy>maxV)n.vy=maxV;else if(n.vy<-maxV)n.vy=-maxV;
    if(n===drag)continue;n.x=fin(n.x+n.vx);n.y=fin(n.y+n.vy);}
}
// auto-fit the settled layout into the viewport (so nodes are always visible)
function fitView(){
  let minx=1e9,miny=1e9,maxx=-1e9,maxy=-1e9,any=false;
  for(const n of nodes){if(!visible(n))continue;any=true;
    if(n.x<minx)minx=n.x;if(n.x>maxx)maxx=n.x;if(n.y<miny)miny=n.y;if(n.y>maxy)maxy=n.y;}
  if(!any)return;
  const gw=Math.max(1,maxx-minx),gh=Math.max(1,maxy-miny);
  view.k=Math.max(0.2,Math.min(W/(gw+120),H/(gh+120),2));
  view.x=W/2-((minx+maxx)/2)*view.k;view.y=H/2-((miny+maxy)/2)*view.k;
}
function toScr(n){return{x:n.x*view.k+view.x,y:n.y*view.k+view.y};}
function draw(){
  ctx.setTransform(dpr(),0,0,dpr(),0,0);
  ctx.clearRect(0,0,W,H);
  ctx.lineWidth=1;ctx.strokeStyle="rgba(255,255,255,0.10)";
  for(const e of edges){const a=byId[e.s],b=byId[e.t];if(!visible(a)||!visible(b))continue;
    const pa=toScr(a),pb=toScr(b);ctx.beginPath();ctx.moveTo(pa.x,pa.y);ctx.lineTo(pb.x,pb.y);ctx.stroke();}
  for(const n of nodes){if(!visible(n))continue;const p=toScr(n);const r=(4+n.deg*1.2)*Math.max(0.5,view.k);
    ctx.beginPath();ctx.arc(p.x,p.y,r,0,6.283);ctx.fillStyle=domColor[n.domain]||"#888";ctx.fill();
    if(n===sel){ctx.lineWidth=2;ctx.strokeStyle="#fff";ctx.stroke();}
    if(view.k>0.55||n===sel){ctx.fillStyle="#ddd";ctx.font="11px Segoe UI";ctx.fillText(String(n.id),p.x+r+3,p.y+4);}}
}
function loop(){try{step();frame++;if(frame===70&&!fitted){fitView();fitted=true;}draw();}catch(e){}requestAnimationFrame(loop);}
loop();
// interaction (CSS-pixel coordinates throughout)
function pick(mx,my){let best=null,bd=1e9;for(const n of nodes){if(!visible(n))continue;const p=toScr(n);const d=(p.x-mx)**2+(p.y-my)**2;const r=((8+n.deg*1.2)*Math.max(0.5,view.k))**2;if(d<r&&d<bd){bd=d;best=n;}}return best;}
cv.addEventListener('mousedown',e=>{const mx=e.offsetX,my=e.offsetY;const n=pick(mx,my);if(n){drag=n;sel=n;showDetail(n);}else{pan={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};}});
window.addEventListener('mousemove',e=>{if(drag){drag.x=(e.offsetX-view.x)/view.k;drag.y=(e.offsetY-view.y)/view.k;drag.vx=drag.vy=0;}else if(pan){view.x=pan.vx+(e.clientX-pan.x);view.y=pan.vy+(e.clientY-pan.y);}});
window.addEventListener('mouseup',()=>{drag=null;pan=null;});
cv.addEventListener('wheel',e=>{e.preventDefault();const f=e.deltaY<0?1.1:0.9;const mx=e.offsetX,my=e.offsetY;const k2=Math.max(0.15,Math.min(4,view.k*f));view.x=mx-(mx-view.x)*(k2/view.k);view.y=my-(my-view.y)*(k2/view.k);view.k=k2;},{passive:false});
function showDetail(n){const d=document.getElementById('detail');let s='';if(n.sources&&n.sources.length){s='<ul>'+n.sources.map(x=>'<li>'+String(x).replace(/[<>]/g,'')+'</li>').join('')+'</ul>';}
d.style.display='block';d.innerHTML='<h2>'+String(n.id)+'</h2><div class="d">'+(n.desc||'(no description)')+'</div><div class="d" style="margin-top:8px">domain: <b style="color:'+(domColor[n.domain]||'#888')+'">'+n.domain+'</b> · '+n.deg+' links</div>'+(s?'<div class="d" style="margin-top:8px">sources:</div>'+s:'');}
</script></body></html>"""


def render(graph: dict) -> str:
    html = HTML_TEMPLATE
    html = html.replace("__DATA__", json.dumps(graph, ensure_ascii=False))
    html = html.replace("__TITLE__", graph["title"] or "Knowledge Bundle")
    html = html.replace("__OKFVER__", str(graph.get("okf_version", "0.1")))
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
