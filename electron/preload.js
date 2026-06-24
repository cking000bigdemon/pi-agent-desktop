"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Minimal, safe surface exposed to the pi-web frontend. We intentionally expose
// almost nothing — pi-web talks to its own Next.js API over localhost, so it
// needs no privileged bridge. This is here for future use and to keep
// contextIsolation on with a defined boundary.
contextBridge.exposeInMainWorld("piWebDesktop", {
  isDesktop: true,
  platform: process.platform,
  // MCP / extension activation status for the bottom dashboard bar (and for
  // anything else that wants it). Reads ~/.pi config in the main process.
  getDashboardStatus: () => ipcRenderer.invoke("pi-web-desktop:dashboard-status"),
});

// ---------------------------------------------------------------------------
// In-page update-result CTA (top-right toast)
// ---------------------------------------------------------------------------
// pi-web is not forked, so the desktop shell reports its update result by
// injecting a self-contained overlay from this (isolated-world) preload. It
// lives in a Shadow DOM and is styled via element.style props (no <style> /
// inline-style attribute) so it neither collides with pi-web's CSS nor trips
// the page Content-Security-Policy.
//
// To stay visually consistent with pi-web, surfaces/borders/text/accent are
// pulled from pi-web's own CSS custom properties (--bg, --text, --border,
// --accent, …) — these inherit through the shadow boundary — and the card uses
// pi-web's monospace chrome font (--font-mono) and its elevated-card shape
// (14px radius + soft slate shadow). Each var() carries a light-theme fallback,
// and because the tokens are read live the toast follows pi-web's theme.

// pi-web's Metro chrome font — Segoe UI on Windows, Selawik/Open Sans elsewhere.
// Inherits --font-ui through the shadow boundary; the literal fallback mirrors
// pi-web/app/globals.css so the shell reads identically before vars resolve.
const UI =
  "var(--font-ui, 'Segoe UI', Selawik, system-ui, -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif)";

// Semantic status accents drawn from pi-web's Windows Phone tile palette
// (--tile-* in globals.css, inherited through the shadow boundary); literal
// fallbacks are the same WP swatches so colour is right before vars resolve.
const STATUS = {
  updated: "var(--tile-green, #60A917)", // green  — installed a new version
  latest: "var(--accent, #0050EF)", // cobalt — already up to date
  available: "var(--tile-amber, #F0A30A)", // amber  — update available (deferred)
  error: "var(--tile-red, #E51400)", // red    — check/update failed
};

let hostEl = null;

function whenBody(cb) {
  if (document.body) cb();
  else document.addEventListener("DOMContentLoaded", cb, { once: true });
}

function ensureHost() {
  if (hostEl && document.body && document.body.contains(hostEl)) return hostEl;
  hostEl = document.createElement("div");
  hostEl.id = "pi-web-desktop-cta-host";
  const s = hostEl.style;
  s.position = "fixed";
  s.top = "64px";
  s.right = "20px";
  s.zIndex = "2147483647";
  s.display = "flex";
  s.flexDirection = "column";
  s.gap = "10px";
  s.pointerEvents = "none"; // cards re-enable pointer events individually
  hostEl.attachShadow({ mode: "open" });
  document.body.appendChild(hostEl);
  return hostEl;
}

function renderNotice(notice) {
  whenBody(() => {
    const accent = STATUS[notice.status] || STATUS.latest;
    const root = ensureHost().shadowRoot;

    const card = document.createElement("div");
    const cs = card.style;
    cs.pointerEvents = "auto";
    cs.boxSizing = "border-box";
    cs.width = "340px";
    cs.padding = "13px 15px";
    cs.borderRadius = "0"; // Metro tiles are square — no rounding
    cs.background = "var(--bg-panel, #ffffff)";
    cs.color = "var(--text, #1a1a1a)";
    cs.border = "1px solid var(--border, rgba(0,0,0,0.06))";
    cs.borderLeft = "3px solid " + accent; // WP left accent bar carries the status colour
    cs.boxShadow = "0 2px 14px rgba(0,0,0,0.22)"; // minimal float separation, no soft slate
    cs.fontFamily = UI;
    cs.fontSize = "13px";
    cs.lineHeight = "1.5";
    cs.opacity = "0";
    cs.transform = "translateY(-10px)";
    cs.transition = "opacity .22s ease, transform .26s cubic-bezier(0.1,0.9,0.2,1)";

    // --- header: status dot + title + close ---
    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.gap = "8px";

    const dot = document.createElement("span");
    const ds = dot.style;
    ds.flex = "0 0 auto";
    ds.width = "8px";
    ds.height = "8px";
    ds.borderRadius = "0"; // square WP status indicator
    ds.background = accent;
    // subtle halo in the status colour (ignored if color-mix is unsupported)
    ds.boxShadow = "0 0 0 3px color-mix(in srgb, " + accent + " 15%, transparent)";

    const title = document.createElement("div");
    title.textContent = notice.title || "检查更新";
    title.style.flex = "1 1 auto";
    title.style.fontWeight = "600";
    title.style.fontSize = "13.5px";
    title.style.letterSpacing = "0.2px";

    const close = document.createElement("button");
    close.textContent = "✕";
    close.setAttribute("aria-label", "关闭");
    const xs = close.style;
    xs.flex = "0 0 auto";
    xs.cursor = "pointer";
    xs.border = "none";
    xs.background = "transparent";
    xs.color = "var(--text-dim, #9ca3af)";
    xs.fontFamily = UI;
    xs.fontSize = "12px";
    xs.lineHeight = "1";
    xs.padding = "2px 4px";
    xs.borderRadius = "0";
    close.addEventListener("mouseenter", () => (close.style.color = "var(--text, #1a1a1a)"));
    close.addEventListener("mouseleave", () => (close.style.color = "var(--text-dim, #9ca3af)"));

    head.appendChild(dot);
    head.appendChild(title);
    head.appendChild(close);
    card.appendChild(head);

    // --- body ---
    if (notice.message) {
      const msg = document.createElement("div");
      msg.textContent = notice.message;
      msg.style.marginTop = "9px";
      msg.style.fontSize = "13px";
      msg.style.color = "var(--text, #1a1a1a)";
      card.appendChild(msg);
    }
    if (notice.detail) {
      const det = document.createElement("div");
      det.textContent = notice.detail;
      det.style.marginTop = "3px";
      det.style.fontSize = "12px";
      det.style.color = "var(--text-muted, #6b7280)";
      card.appendChild(det);
    }

    // --- dismissal ---
    let timer = null;
    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      card.style.opacity = "0";
      card.style.transform = "translateY(-8px)";
      setTimeout(() => card.remove(), 220);
    };
    close.addEventListener("click", dismiss);

    // --- optional action (genuine CTA, e.g. deferred update) ---
    if (notice.action && notice.action.id) {
      const act = document.createElement("button");
      act.textContent = notice.action.label || "更新";
      const as = act.style;
      as.marginTop = "12px";
      as.width = "100%";
      as.cursor = "pointer";
      as.padding = "9px 12px";
      as.border = "none";
      as.borderRadius = "0"; // square Metro command button
      as.background = "var(--accent, #0050EF)";
      as.color = "#ffffff";
      as.fontFamily = UI;
      as.fontSize = "12.5px";
      as.fontWeight = "600";
      as.letterSpacing = "0.3px";
      act.addEventListener("mouseenter", () => (act.style.background = "var(--accent-hover, #2F6BFF)"));
      act.addEventListener("mouseleave", () => (act.style.background = "var(--accent, #0050EF)"));
      act.addEventListener("click", () => {
        act.disabled = true;
        act.textContent = "正在更新…";
        act.style.opacity = "0.75";
        act.style.cursor = "default";
        ipcRenderer.send("pi-web-desktop:" + notice.action.id);
      });
      card.appendChild(act);
    }

    root.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
    });

    // Auto-dismiss informational toasts; keep errors / actionable CTAs until the
    // user dismisses or acts on them.
    const sticky = notice.status === "error" || !!(notice.action && notice.action.id);
    if (!sticky) timer = setTimeout(dismiss, 8000);
  });
}

ipcRenderer.on("pi-web-desktop:update-notice", (_e, notice) => {
  if (notice) renderNotice(notice);
});

// ---------------------------------------------------------------------------
// Bottom dashboard bar + bottom-right detail popover
// ---------------------------------------------------------------------------
// A slim status bar pinned to the bottom edge shows, for MCP and Extensions, a
// green "active" count and a red "inactive" count. Clicking either group opens
// a floating card in the bottom-right corner that lists the concrete names,
// grouped into 已激活 (green) / 暂未激活 (red).
//
// Same constraints as the update toast above: lives in its own Shadow DOM,
// styled only via element.style (no <style>/inline-style attr → CSP-safe),
// pulls colours/fonts from pi-web's CSS custom properties so it follows the
// theme. The host strip is pointer-events:none so it never steals clicks from
// pi-web's own bottom area — only the right-aligned chips and the popover are
// interactive.
(function mountDashboard() {
  // Only attach to the actual pi-web page (http on 127.0.0.1), never to the
  // shell's own file:// pages (loading/updating/error).
  if (location.protocol !== "http:") return;

  const GREEN = "var(--tile-green, #60A917)"; // 已激活 / 运行中 (WP green tile)
  const RED = "var(--tile-red, #E51400)"; //  暂未激活 / 失败 (WP red tile)
  const GRAY = "var(--text-dim, #9ca3af)"; // 本次会话已完成（中性）
  const REFRESH_MS = 20000; // idle cadence
  const REFRESH_ACTIVE_MS = 3000; // faster cadence while subagents are running
  const BAR_H = 30; // bar height (px); kept in sync with the reserved space
  const reduceMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  let host = null;
  let bar = null;
  let popover = null;
  let openCategory = null; // null | "mcp" | "extensions"
  let status = null;
  let chips = {}; // category -> { active, inactive } count <span>s
  let subagentPulse = null; // WAAPI handle for the running sub-agent live-tile pulse

  function whenBodyReady(cb) {
    if (document.body) cb();
    else document.addEventListener("DOMContentLoaded", cb, { once: true });
  }

  function dot(color, size) {
    const s = document.createElement("span");
    const st = s.style;
    st.flex = "0 0 auto";
    st.display = "inline-block";
    st.width = (size || 7) + "px";
    st.height = (size || 7) + "px";
    st.borderRadius = "0"; // square WP live-tile indicator
    st.background = color;
    return s;
  }

  function ensureHost() {
    if (host && document.body && document.body.contains(host)) return host;
    host = document.createElement("div");
    host.id = "pi-web-desktop-dashboard-host";
    // Fixed strip pinned to the viewport bottom — reliable placement regardless
    // of pi-web's (client-rendered) layout. The page itself is shrunk by BAR_H
    // (see setupReserve) so this strip never covers pi-web's bottom toolbar.
    const s = host.style;
    s.position = "fixed";
    s.left = "0";
    s.right = "0";
    s.bottom = "0";
    s.height = BAR_H + "px";
    s.zIndex = "2147483600"; // below the update toast (max), above pi-web
    s.pointerEvents = "none"; // chips re-enable; the rest stays click-through
    host.attachShadow({ mode: "open" });
    document.body.appendChild(host);
    buildBar();
    return host;
  }

  // Reserve BAR_H at the bottom of the page so the fixed bar doesn't overlap
  // pi-web's own bottom input toolbar. pi-web's app pane is the <body> child
  // carrying inline `height:100dvh`; we tag it with a data-attr we own and a
  // stylesheet shrinks it by BAR_H. !important beats React's inline height, and
  // because we never mutate a React-managed style, re-renders can't undo it.
  function ensureReserveStyle() {
    if (document.getElementById("pi-web-desktop-reserve-style")) return;
    const st = document.createElement("style");
    st.id = "pi-web-desktop-reserve-style";
    st.textContent =
      "[data-piwd-reserve]{height:calc(100dvh - " +
      BAR_H +
      "px) !important;max-height:calc(100dvh - " +
      BAR_H +
      "px) !important;}";
    (document.head || document.documentElement).appendChild(st);
  }

  function tagAppRoot() {
    const kids = (document.body && document.body.children) || [];
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (el === host || el.id === "pi-web-desktop-cta-host" || el.id === "pi-web-desktop-dashboard-host") {
        continue;
      }
      if (el.tagName === "DIV" && el.style && el.style.height === "100dvh") {
        if (!el.hasAttribute("data-piwd-reserve")) el.setAttribute("data-piwd-reserve", "1");
        return true;
      }
    }
    return false;
  }

  function setupReserve() {
    ensureReserveStyle();
    tagAppRoot();
    // pi-web renders client-side, so the app pane mounts after DOMContentLoaded
    // (and may remount on route change). Watch for it and (re)tag it.
    try {
      new MutationObserver(() => tagAppRoot()).observe(document.body, { childList: true });
    } catch {
      /* ignore */
    }
  }

  // --- the bottom bar ---
  function buildBar() {
    const root = host.shadowRoot;

    bar = document.createElement("div");
    const bs = bar.style;
    bs.boxSizing = "border-box";
    bs.width = "100%";
    bs.height = "30px";
    bs.display = "flex";
    bs.alignItems = "center";
    bs.justifyContent = "flex-end";
    bs.gap = "4px";
    bs.padding = "0 14px";
    bs.fontFamily = UI;
    bs.fontSize = "12px";
    bs.color = "var(--text-muted, #6b7280)";
    bs.background = "var(--bg-panel, #ffffff)"; // distinct tile-surface strip
    bs.borderTop = "1px solid var(--border, rgba(0,0,0,0.06))";
    bs.pointerEvents = "none"; // only the chips are interactive (set below)

    // Left-aligned (marginRight:auto) — the active workspace's OKF knowledge base.
    bar.appendChild(buildWikiChip());
    bar.appendChild(buildTotalChip());
    bar.appendChild(buildSep());
    bar.appendChild(buildChip("mcp", "MCP"));
    bar.appendChild(buildSep());
    bar.appendChild(buildChip("extensions", "Extensions"));
    bar.appendChild(buildSep());
    bar.appendChild(buildSubagentChip());

    root.appendChild(bar);
  }

  // Compact token formatter: 300000 -> "300k", 2904 -> "2.9k", 1.5e6 -> "1.5M".
  function formatTokens(t) {
    t = Number(t) || 0;
    if (t >= 1e6) return (t / 1e6).toFixed(t >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (t >= 1e4) return Math.round(t / 1e3) + "k";
    if (t >= 1e3) return (t / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(Math.round(t));
  }

  // Display-only "Total <n>" chip (no popover) — total tokens consumed since the
  // app launched. Hover shows the input/output/call breakdown.
  function buildTotalChip() {
    const chip = document.createElement("div");
    const cs = chip.style;
    cs.pointerEvents = "auto";
    cs.display = "flex";
    cs.alignItems = "center";
    cs.gap = "6px";
    cs.padding = "5px 8px";
    cs.fontFamily = UI;
    cs.fontSize = "12px";
    cs.color = "var(--text, #1a1a1a)";

    const label = document.createElement("span");
    label.textContent = "Total";
    label.style.color = "var(--text-muted, #6b7280)";

    const val = document.createElement("span");
    val.textContent = "–";
    val.style.fontWeight = "600";
    val.style.fontVariantNumeric = "tabular-nums";

    chip.appendChild(label);
    chip.appendChild(val);
    chips.total = { el: chip, val };
    return chip;
  }

  function buildSep() {
    const sep = document.createElement("span");
    const st = sep.style;
    st.flex = "0 0 auto";
    st.width = "1px";
    st.height = "14px";
    st.margin = "0 6px";
    st.background = "var(--border, #e5e7eb)";
    return sep;
  }

  function buildChip(category, label) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-label", `${label} 激活状态`);
    const cs = chip.style;
    cs.pointerEvents = "auto"; // the only interactive part of the strip
    cs.display = "flex";
    cs.alignItems = "center";
    cs.gap = "6px";
    cs.cursor = "pointer";
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "var(--text, #1a1a1a)";
    cs.fontFamily = UI;
    cs.fontSize = "12px";
    cs.lineHeight = "1";
    cs.padding = "5px 8px";
    cs.borderRadius = "0"; // square Metro chip
    cs.transition = "background .15s ease";
    chip.addEventListener(
      "mouseenter",
      () => (chip.style.background = "color-mix(in srgb, var(--text, #1a1a1a) 8%, transparent)")
    );
    chip.addEventListener("mouseleave", () => {
      if (openCategory !== category) chip.style.background = "transparent";
    });
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePopover(category);
    });

    const name = document.createElement("span");
    name.textContent = label;
    name.style.color = "var(--text-muted, #6b7280)";
    name.style.marginRight = "2px";

    const active = document.createElement("span");
    active.textContent = "–";
    active.style.color = GREEN;
    active.style.fontWeight = "600";
    active.style.fontVariantNumeric = "tabular-nums";

    const inactive = document.createElement("span");
    inactive.textContent = "–";
    inactive.style.color = RED;
    inactive.style.fontWeight = "600";
    inactive.style.fontVariantNumeric = "tabular-nums";

    chip.appendChild(name);
    chip.appendChild(dot(GREEN));
    chip.appendChild(active);
    chip.appendChild(dot(RED));
    chip.appendChild(inactive);

    chips[category] = { el: chip, active, inactive };
    return chip;
  }

  // Sub-agents chip: how many child pi sessions are running right now (green)
  // and how many finished during this app session (gray). Same shape/behaviour
  // as buildChip, but its two numbers are running/done rather than active/
  // inactive, and clicking opens a bespoke popover (see renderSubagentPopover).
  function buildSubagentChip() {
    const category = "subagents";
    const chip = document.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-label", "子会话（sub-agent）运行状态");
    const cs = chip.style;
    cs.pointerEvents = "auto";
    cs.display = "flex";
    cs.alignItems = "center";
    cs.gap = "6px";
    cs.cursor = "pointer";
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "var(--text, #1a1a1a)";
    cs.fontFamily = UI;
    cs.fontSize = "12px";
    cs.lineHeight = "1";
    cs.padding = "5px 8px";
    cs.borderRadius = "0"; // square Metro chip
    cs.transition = "background .15s ease";
    chip.addEventListener(
      "mouseenter",
      () => (chip.style.background = "color-mix(in srgb, var(--text, #1a1a1a) 8%, transparent)")
    );
    chip.addEventListener("mouseleave", () => {
      if (openCategory !== category) chip.style.background = "transparent";
    });
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePopover(category);
    });

    const name = document.createElement("span");
    name.textContent = "Sub-agents";
    name.style.color = "var(--text-muted, #6b7280)";
    name.style.marginRight = "2px";

    // green dot: full opacity while something runs, dimmed when idle (set in
    // updateChips) so a live session genuinely stands out.
    const runDot = dot(GREEN);
    const running = document.createElement("span");
    running.textContent = "–";
    running.style.color = GREEN;
    running.style.fontWeight = "600";
    running.style.fontVariantNumeric = "tabular-nums";

    const done = document.createElement("span");
    done.textContent = "–";
    done.style.color = GRAY;
    done.style.fontWeight = "600";
    done.style.fontVariantNumeric = "tabular-nums";

    chip.appendChild(name);
    chip.appendChild(runDot);
    chip.appendChild(running);
    chip.appendChild(dot(GRAY));
    chip.appendChild(done);

    chips[category] = { el: chip, runDot, running, done };
    return chip;
  }

  // Wiki chip: concept count of the ACTIVE workspace's OKF knowledge base.
  // Clicking opens a popover (domain breakdown + "打开知识图谱" action). Left-
  // aligned via marginRight:auto so it sits opposite the right-hand chip group.
  function buildWikiChip() {
    const category = "wiki";
    const chip = document.createElement("button");
    chip.type = "button";
    chip.setAttribute("aria-label", "知识库（OKF）");
    const cs = chip.style;
    cs.pointerEvents = "auto";
    cs.marginRight = "auto"; // push the rest of the bar to the right
    cs.display = "flex";
    cs.alignItems = "center";
    cs.gap = "6px";
    cs.cursor = "pointer";
    cs.border = "none";
    cs.background = "transparent";
    cs.color = "var(--text, #1a1a1a)";
    cs.fontFamily = UI;
    cs.fontSize = "12px";
    cs.lineHeight = "1";
    cs.padding = "5px 8px";
    cs.borderRadius = "0";
    cs.transition = "background .15s ease";
    chip.addEventListener(
      "mouseenter",
      () => (chip.style.background = "color-mix(in srgb, var(--text, #1a1a1a) 8%, transparent)")
    );
    chip.addEventListener("mouseleave", () => {
      if (openCategory !== category) chip.style.background = "transparent";
    });
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePopover(category);
    });

    const name = document.createElement("span");
    name.textContent = "Wiki";
    name.style.color = "var(--text-muted, #6b7280)";
    name.style.marginRight = "2px";

    const val = document.createElement("span");
    val.textContent = "–";
    val.style.color = "var(--accent, #0050EF)";
    val.style.fontWeight = "600";
    val.style.fontVariantNumeric = "tabular-nums";

    chip.appendChild(name);
    chip.appendChild(val);
    chips.wiki = { el: chip, val };
    return chip;
  }

  function counts(cat) {
    const group = status && status[cat];
    return {
      active: group && Array.isArray(group.active) ? group.active.length : 0,
      inactive: group && Array.isArray(group.inactive) ? group.inactive.length : 0,
    };
  }

  function updateChips() {
    for (const cat of ["mcp", "extensions"]) {
      const c = chips[cat];
      if (!c) continue;
      const n = counts(cat);
      c.active.textContent = String(n.active);
      c.inactive.textContent = String(n.inactive);
    }
    if (chips.total) {
      const t = (status && status.tokens) || null;
      const total = t ? t.total : 0;
      chips.total.val.textContent = formatTokens(total);
      chips.total.el.title = t
        ? `自本次启动消耗 ${total.toLocaleString()} tokens\n` +
          `输入 ${(t.input || 0).toLocaleString()} · 输出 ${(t.output || 0).toLocaleString()} · ` +
          `${t.calls || 0} 次调用 / ${t.sessions || 0} 个会话`
        : "本次启动 token 消耗";
    }
    if (chips.subagents) {
      const s = (status && status.subagents) || null;
      const running = s ? s.running || 0 : 0;
      const done = s ? s.doneSession || 0 : 0;
      const failed = s ? s.failedSession || 0 : 0;
      chips.subagents.running.textContent = String(running);
      chips.subagents.done.textContent = String(done);
      // Live-tile pulse: while a sub-agent runs, the green square pulses (WAAPI —
      // CSP-safe, mirrors pi-web's dotPulse keyframe); idle dims it so a running
      // session genuinely stands out. Respects prefers-reduced-motion.
      const rd = chips.subagents.runDot;
      if (running > 0) {
        rd.style.opacity = "1";
        if (!subagentPulse && !reduceMotion) {
          try {
            subagentPulse = rd.animate(
              [
                { opacity: 1, transform: "scale(1)" },
                { opacity: 0.4, transform: "scale(0.65)" },
                { opacity: 1, transform: "scale(1)" },
              ],
              { duration: 1400, iterations: Infinity, easing: "ease-in-out" }
            );
          } catch {
            /* WAAPI unavailable — the static dot is fine */
          }
        }
      } else {
        if (subagentPulse) {
          subagentPulse.cancel();
          subagentPulse = null;
        }
        rd.style.opacity = "0.35";
      }
      chips.subagents.el.title = s
        ? `子会话（sub-agent）：${running} 个运行中\n` +
          `本次启动已完成 ${done} 个${failed ? `，失败 ${failed} 个` : ""}`
        : "子会话（sub-agent）运行状态";
    }
    if (chips.wiki) {
      const w = (status && status.wiki) || null;
      const present = !!(w && w.present);
      chips.wiki.val.textContent = present ? String(w.concepts || 0) : "0";
      chips.wiki.val.style.opacity = present ? "1" : "0.4";
      chips.wiki.el.title = present
        ? `知识库（OKF）：${w.concepts} 个概念 · ${(w.domains || []).length} 个业务域\n` +
          `工作区 ${w.cwd || ""}`
        : "当前工作区无 OKF 知识库（在 pi 里 /wiki-init + /wiki-compile 生成）";
    }
  }

  // --- the bottom-right popover ---
  function togglePopover(category) {
    if (openCategory === category) {
      closePopover();
    } else {
      openPopover(category);
    }
  }

  function openPopover(category) {
    openCategory = category;
    for (const cat of ["mcp", "extensions", "subagents", "wiki"]) {
      if (chips[cat]) {
        chips[cat].el.style.background =
          cat === category ? "color-mix(in srgb, var(--text, #1a1a1a) 8%, transparent)" : "transparent";
      }
    }
    renderPopover(category);
    // Refresh in the background so the list reflects any config edits.
    refresh().then(() => {
      if (openCategory === category) renderPopover(category);
    });
  }

  function closePopover() {
    openCategory = null;
    for (const cat of ["mcp", "extensions", "subagents", "wiki"]) {
      if (chips[cat]) chips[cat].el.style.background = "transparent";
    }
    if (popover) {
      popover.style.opacity = "0";
      popover.style.transform = "translateY(8px)";
      const el = popover;
      popover = null;
      setTimeout(() => el.remove(), 180);
    }
  }

  function renderPopover(category) {
    const root = ensureHost().shadowRoot;
    if (popover) {
      popover.remove();
      popover = null;
    }

    const card = document.createElement("div");
    popover = card;
    const cs = card.style;
    cs.position = "fixed";
    cs.right = "14px";
    cs.bottom = "40px";
    cs.boxSizing = "border-box";
    cs.width = "320px";
    cs.maxHeight = "60vh";
    cs.overflowY = "auto";
    cs.pointerEvents = "auto";
    cs.padding = "13px 15px";
    cs.borderRadius = "0"; // Metro tiles are square — no rounding
    cs.background = "var(--bg-panel, #ffffff)";
    cs.color = "var(--text, #1a1a1a)";
    cs.border = "1px solid var(--border, rgba(0,0,0,0.06))";
    cs.borderLeft = "3px solid var(--accent, #0050EF)"; // WP cobalt accent bar
    cs.boxShadow = "0 2px 16px rgba(0,0,0,0.24)"; // minimal float separation, no soft slate
    cs.fontFamily = UI;
    cs.fontSize = "13px";
    cs.lineHeight = "1.5";
    cs.opacity = "0";
    cs.transform = "translateY(10px)";
    cs.transition = "opacity .18s ease, transform .22s cubic-bezier(0.1,0.9,0.2,1)";

    const data = (status && status[category]) || { active: [], inactive: [] };
    const title =
      category === "mcp"
        ? "MCP"
        : category === "subagents"
          ? "Sub-agents"
          : category === "wiki"
            ? "知识库（OKF）"
            : "Extensions";

    // header
    const head = document.createElement("div");
    head.style.display = "flex";
    head.style.alignItems = "center";
    head.style.gap = "8px";
    head.style.marginBottom = "10px";

    const titleEl = document.createElement("div");
    titleEl.textContent = title;
    titleEl.style.flex = "1 1 auto";
    titleEl.style.fontWeight = "600";
    titleEl.style.fontSize = "13.5px";
    titleEl.style.letterSpacing = "0.2px";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", "关闭");
    const xs = close.style;
    xs.flex = "0 0 auto";
    xs.cursor = "pointer";
    xs.border = "none";
    xs.background = "transparent";
    xs.color = "var(--text-dim, #9ca3af)";
    xs.fontFamily = UI;
    xs.fontSize = "12px";
    xs.lineHeight = "1";
    xs.padding = "2px 4px";
    xs.borderRadius = "0";
    close.addEventListener("mouseenter", () => (close.style.color = "var(--text, #1a1a1a)"));
    close.addEventListener("mouseleave", () => (close.style.color = "var(--text-dim, #9ca3af)"));
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closePopover();
    });

    head.appendChild(titleEl);
    head.appendChild(close);
    card.appendChild(head);

    if (category === "subagents") {
      appendSubagentSections(card);
    } else if (category === "wiki") {
      appendWikiSection(card);
    } else {
      card.appendChild(buildSection("已激活", GREEN, data.active, category));
      card.appendChild(buildSection("暂未激活", RED, data.inactive, category));
    }

    if (status && status.error) {
      const err = document.createElement("div");
      err.textContent = status.error;
      err.style.marginTop = "10px";
      err.style.fontSize = "11.5px";
      err.style.color = RED;
      card.appendChild(err);
    }

    root.appendChild(card);
    requestAnimationFrame(() => {
      card.style.opacity = "1";
      card.style.transform = "translateY(0)";
    });
  }

  function buildSection(label, color, items, category) {
    const wrap = document.createElement("div");
    wrap.style.marginTop = "4px";
    wrap.style.marginBottom = "10px";

    const heading = document.createElement("div");
    heading.style.display = "flex";
    heading.style.alignItems = "center";
    heading.style.gap = "6px";
    heading.style.marginBottom = "6px";
    const hl = document.createElement("span");
    hl.textContent = label;
    hl.style.color = color;
    hl.style.fontWeight = "600";
    hl.style.fontSize = "12px";
    const cnt = document.createElement("span");
    cnt.textContent = String((items && items.length) || 0);
    cnt.style.color = "var(--text-muted, #6b7280)";
    cnt.style.fontSize = "12px";
    heading.appendChild(dot(color));
    heading.appendChild(hl);
    heading.appendChild(cnt);
    wrap.appendChild(heading);

    if (!items || items.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "无";
      empty.style.color = "var(--text-dim, #9ca3af)";
      empty.style.fontSize = "12px";
      empty.style.paddingLeft = "13px";
      wrap.appendChild(empty);
      return wrap;
    }

    for (const item of items) {
      wrap.appendChild(buildRow(item, color, category));
    }
    return wrap;
  }

  function buildRow(item, color, category) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "baseline";
    row.style.gap = "8px";
    row.style.padding = "3px 0 3px 13px";

    const name = document.createElement("span");
    name.textContent = item.name || "(未命名)";
    name.style.color = "var(--text, #1a1a1a)";
    name.style.fontSize = "12.5px";
    name.style.wordBreak = "break-all";
    row.appendChild(name);

    // a small muted tag: MCP transport type, or extension kind/source
    let tagText = "";
    if (category === "mcp") tagText = item.type || "";
    else if (item.kind === "package") tagText = item.source || "pkg"; // npm / git package
    else if (item.source === "settings") tagText = "settings";
    else if (item.kind === "dir") tagText = "dir";
    if (tagText) {
      const tag = document.createElement("span");
      tag.textContent = tagText;
      tag.style.flex = "0 0 auto";
      tag.style.marginLeft = "auto";
      tag.style.fontSize = "10.5px";
      tag.style.color = "var(--text-dim, #9ca3af)";
      tag.style.border = "1px solid var(--border, rgba(0,0,0,0.06))";
      tag.style.borderRadius = "0";
      tag.style.padding = "0 5px";
      row.appendChild(tag);
    }

    // For MCP, show the target (url / command) underneath on hover via title.
    if (category === "mcp" && item.target) {
      row.title = item.target;
    }
    return row;
  }

  // --- subagent popover body ---
  function sectionHeading(label, color, count) {
    const heading = document.createElement("div");
    heading.style.display = "flex";
    heading.style.alignItems = "center";
    heading.style.gap = "6px";
    heading.style.marginBottom = "6px";
    const hl = document.createElement("span");
    hl.textContent = label;
    hl.style.color = color;
    hl.style.fontWeight = "600";
    hl.style.fontSize = "12px";
    const cnt = document.createElement("span");
    cnt.textContent = String(count);
    cnt.style.color = "var(--text-muted, #6b7280)";
    cnt.style.fontSize = "12px";
    heading.appendChild(dot(color));
    heading.appendChild(hl);
    heading.appendChild(cnt);
    return heading;
  }

  function emptyRow(text) {
    const empty = document.createElement("div");
    empty.textContent = text;
    empty.style.color = "var(--text-dim, #9ca3af)";
    empty.style.fontSize = "12px";
    empty.style.paddingLeft = "13px";
    return empty;
  }

  function fmtDuration(ms) {
    if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m${r}s` : `${m}m`;
  }

  function subagentRow(o) {
    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.alignItems = "baseline";
    row.style.gap = "8px";
    row.style.padding = "3px 0 3px 13px";

    const name = document.createElement("span");
    name.textContent = o.name || "(未命名)";
    name.style.color = "var(--text, #1a1a1a)";
    name.style.fontSize = "12.5px";
    name.style.wordBreak = "break-all";
    row.appendChild(name);

    if (o.tag) {
      const tag = document.createElement("span");
      tag.textContent = o.tag;
      tag.style.flex = "0 0 auto";
      tag.style.marginLeft = "auto";
      tag.style.fontSize = "10.5px";
      tag.style.color = o.tagColor || "var(--text-dim, #9ca3af)";
      tag.style.border = "1px solid var(--border, rgba(0,0,0,0.06))";
      tag.style.borderRadius = "0";
      tag.style.padding = "0 5px";
      row.appendChild(tag);
    }
    if (o.title) row.title = o.title;
    return row;
  }

  // Two sections: live runs (green) + finished-this-session (gray). The running
  // list comes from the OS process table (sees foreground AND background runs);
  // the finished list from run-history.jsonl.
  function appendSubagentSections(card) {
    const s = (status && status.subagents) || {
      running: 0,
      runningList: [],
      doneSession: 0,
      failedSession: 0,
      recent: [],
    };

    const runWrap = document.createElement("div");
    runWrap.style.marginTop = "4px";
    runWrap.style.marginBottom = "10px";
    runWrap.appendChild(sectionHeading("正在运行", GREEN, s.running || 0));
    if (!s.runningList || s.runningList.length === 0) {
      runWrap.appendChild(emptyRow("无运行中的子会话"));
    } else {
      for (const r of s.runningList) {
        const tag = r.source === "background" ? r.mode || "bg" : "前台";
        runWrap.appendChild(
          subagentRow({ name: r.agent || "subagent", tag, title: r.pid ? `pid ${r.pid}` : undefined })
        );
      }
    }
    card.appendChild(runWrap);

    const doneWrap = document.createElement("div");
    doneWrap.style.marginTop = "4px";
    doneWrap.style.marginBottom = "6px";
    const doneLabel = (s.failedSession || 0) > 0 ? `本次完成（失败 ${s.failedSession}）` : "本次完成";
    doneWrap.appendChild(sectionHeading(doneLabel, GRAY, s.doneSession || 0));
    if (!s.recent || s.recent.length === 0) {
      doneWrap.appendChild(emptyRow("暂无记录"));
    } else {
      for (const e of s.recent) {
        const ok = e.status !== "error";
        doneWrap.appendChild(
          subagentRow({
            name: e.agent,
            tag: fmtDuration(e.durationMs) || (ok ? "ok" : "error"),
            tagColor: ok ? "var(--text-dim, #9ca3af)" : RED,
          })
        );
      }
    }
    card.appendChild(doneWrap);
  }

  // --- wiki popover body: domain breakdown + "open graph" action ---
  function appendWikiSection(card) {
    const w = (status && status.wiki) || { present: false };

    if (!w.present) {
      const empty = document.createElement("div");
      empty.style.color = "var(--text-dim, #9ca3af)";
      empty.style.fontSize = "12.5px";
      empty.style.lineHeight = "1.6";
      empty.style.padding = "2px 0 4px";
      empty.textContent = w.cwd
        ? "当前工作区还没有 OKF 知识库。在 pi 里运行 /wiki-init，再 /wiki-compile 生成。"
        : "未检测到活动工作区。";
      card.appendChild(empty);
      return;
    }

    const sum = document.createElement("div");
    sum.style.marginBottom = "10px";
    sum.style.fontSize = "12.5px";
    sum.style.color = "var(--text-muted, #6b7280)";
    sum.textContent = `${w.concepts} 个概念 · ${(w.domains || []).length} 个业务域`;
    card.appendChild(sum);

    const wrap = document.createElement("div");
    wrap.style.marginBottom = "12px";
    wrap.appendChild(sectionHeading("业务域", GREEN, (w.domains || []).length));
    if (!w.domains || w.domains.length === 0) {
      wrap.appendChild(emptyRow("无（运行 /wiki-compile 生成概念）"));
    } else {
      for (const d of w.domains) {
        wrap.appendChild(subagentRow({ name: d.name, tag: String(d.count) }));
      }
    }
    card.appendChild(wrap);

    const act = document.createElement("button");
    act.type = "button";
    act.textContent = w.graphExists ? "打开知识图谱（重新生成）" : "打开知识图谱";
    const as = act.style;
    as.width = "100%";
    as.cursor = "pointer";
    as.padding = "9px 12px";
    as.border = "none";
    as.borderRadius = "0";
    as.background = "var(--accent, #0050EF)";
    as.color = "#ffffff";
    as.fontFamily = UI;
    as.fontSize = "12.5px";
    as.fontWeight = "600";
    as.letterSpacing = "0.3px";
    act.addEventListener("mouseenter", () => (act.style.background = "var(--accent-hover, #2F6BFF)"));
    act.addEventListener("mouseleave", () => (act.style.background = "var(--accent, #0050EF)"));
    act.addEventListener("click", (e) => {
      e.stopPropagation();
      act.disabled = true;
      act.textContent = "正在生成图谱…";
      act.style.opacity = "0.75";
      act.style.cursor = "default";
      ipcRenderer.send("pi-web-desktop:open-okf-graph");
      // The graph opens in a separate window from the main process; tidy up here.
      setTimeout(() => closePopover(), 700);
    });
    card.appendChild(act);
  }

  // --- data + lifecycle ---
  async function refresh() {
    try {
      status = await ipcRenderer.invoke("pi-web-desktop:dashboard-status");
    } catch {
      status = { mcp: { active: [], inactive: [] }, extensions: { active: [], inactive: [] } };
    }
    updateChips();
    return status;
  }

  // Self-rescheduling poll: tight cadence while subagents are running (so the
  // live count tracks them), relaxed when idle. Process enumeration is the only
  // non-trivial cost and it only runs at the active cadence during actual runs.
  let refreshTimer = null;
  function nextDelay() {
    const running = status && status.subagents ? status.subagents.running : 0;
    return running > 0 ? REFRESH_ACTIVE_MS : REFRESH_MS;
  }
  function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (document.visibilityState === "visible") refresh().finally(scheduleRefresh);
      else scheduleRefresh();
    }, nextDelay());
  }

  function init() {
    ensureHost();
    setupReserve();
    refresh().finally(scheduleRefresh);
    // Also refresh when the window regains focus so config edits / new runs show
    // up immediately without waiting for the next tick.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refresh().finally(scheduleRefresh);
    });
    // Close the popover on outside click / Esc.
    document.addEventListener("click", (e) => {
      if (!openCategory) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (host && path.indexOf(host) === -1) closePopover();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && openCategory) closePopover();
    });
  }

  whenBodyReady(init);
})();
