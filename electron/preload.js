"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// Minimal, safe surface exposed to the pi-web frontend. We intentionally expose
// almost nothing — pi-web talks to its own Next.js API over localhost, so it
// needs no privileged bridge. This is here for future use and to keep
// contextIsolation on with a defined boundary.
contextBridge.exposeInMainWorld("piWebDesktop", {
  isDesktop: true,
  platform: process.platform,
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

// pi-web's monospace chrome stack (fallback if --font-mono is unavailable).
const MONO =
  'var(--font-mono, "JetBrains Mono", "Fira Code", Consolas, ui-monospace, "PingFang SC", "Microsoft YaHei", monospace)';

// Semantic status accents. pi-web only ships a single blue --accent token, so
// success/warn/error reuse a harmonising palette; "latest" uses --accent itself.
const STATUS = {
  updated: "#16a34a", // green  — installed a new version
  latest: "var(--accent, #2563eb)", // blue   — already up to date
  available: "#d97706", // amber  — update available (deferred)
  error: "#dc2626", // red    — check/update failed
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
    cs.borderRadius = "14px";
    cs.background = "var(--bg, #ffffff)";
    cs.color = "var(--text, #1a1a1a)";
    cs.border = "1px solid var(--border, #e0e0e0)";
    cs.boxShadow = "rgba(15,23,42,0.04) 0 1px 2px 0, rgba(15,23,42,0.10) 0 8px 24px -12px";
    cs.fontFamily = MONO;
    cs.fontSize = "13px";
    cs.lineHeight = "1.5";
    cs.opacity = "0";
    cs.transform = "translateY(-8px)";
    cs.transition = "opacity .2s ease, transform .2s ease";

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
    ds.borderRadius = "50%";
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
    xs.fontFamily = MONO;
    xs.fontSize = "12px";
    xs.lineHeight = "1";
    xs.padding = "2px 4px";
    xs.borderRadius = "6px";
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
      as.padding = "8px 12px";
      as.border = "none";
      as.borderRadius = "8px";
      as.background = "var(--accent, #2563eb)";
      as.color = "#ffffff";
      as.fontFamily = MONO;
      as.fontSize = "12.5px";
      as.fontWeight = "600";
      as.letterSpacing = "0.3px";
      act.addEventListener("mouseenter", () => (act.style.background = "var(--accent-hover, #1d4ed8)"));
      act.addEventListener("mouseleave", () => (act.style.background = "var(--accent, #2563eb)"));
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
