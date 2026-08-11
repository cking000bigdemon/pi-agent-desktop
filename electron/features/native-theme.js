"use strict";

/**
 * Native theme sync — keeps the OS window chrome in step with the theme the
 * user picks INSIDE pi-web.
 *
 * The window is a normal framed BrowserWindow, so its title bar is drawn by
 * Windows/DWM, not by the page. Electron colours that frame from
 * `nativeTheme.shouldUseDarkColors`, which defaults to `themeSource: "system"`
 * — i.e. the OS theme. pi-web's own light/dark toggle only touches the page, so
 * on a light-themed Windows the title bar stayed white above a dark pi-web UI
 * (and vice versa). This module drives `themeSource` from the page's theme
 * instead, which repaints the frame immediately (verified on Electron 33 /
 * Windows 11 — no window recreation needed).
 *
 * Where the signal comes from: pi-web marks dark mode with a `dark` class on
 * `<html>` (persisted in `localStorage["pi-theme"]`). `preload.js` watches that
 * class and sends `pi-web-desktop:theme-changed`; main.js routes it here.
 *
 * The last theme is persisted under userData so the NEXT launch paints the
 * right frame from the start, instead of showing the OS theme for the second or
 * two before pi-web finishes loading and reports in.
 *
 * Caveat: `nativeTheme` is app-global, so the shell's own secondary windows
 * (extensions picker, OKF graph) get the same frame. Their pages are dark-only,
 * so in light mode they end up with a light frame over dark content. Fixing
 * that means making those pages theme-aware — deliberately out of scope here.
 */

const fs = require("fs");
const path = require("path");
const { nativeTheme } = require("electron");

/**
 * Window background per theme — pi-web's own `--bg` (globals.css `:root` /
 * `.dark`). Only used to repaint the areas Chromium exposes before the page
 * paints (mainly resize), so it never flashes the opposite colour.
 */
const BG = { dark: "#1a1a1a", light: "#ffffff" };

const STATE_FILE = "theme-state.json";

/** @returns {"dark" | "light" | null} the value if it is a theme we understand */
function normalize(theme) {
  return theme === "dark" || theme === "light" ? theme : null;
}

function stateFile(userDataDir) {
  return path.join(userDataDir, STATE_FILE);
}

/** @returns {"dark" | "light" | null} the persisted theme, or null if none/unreadable */
function readPersisted(userDataDir) {
  try {
    // We always write BOM-less UTF-8, but this file is small enough to be hand
    // edited and every Windows PowerShell text cmdlet adds a BOM — which
    // JSON.parse rejects outright. Strip it rather than silently reverting to
    // the OS theme.
    const text = fs.readFileSync(stateFile(userDataDir), "utf8").replace(/^\uFEFF/, "");
    const raw = JSON.parse(text);
    return normalize(raw && raw.theme);
  } catch {
    return null; // absent (first run) or corrupt — fall back to the OS theme
  }
}

function persist(userDataDir, theme) {
  try {
    fs.writeFileSync(stateFile(userDataDir), JSON.stringify({ theme }, null, 2) + "\n", "utf8");
  } catch {
    // Best-effort: a failed write only costs the correct frame on next boot.
  }
}

/**
 * Apply the last known theme to the window frame. Call before the window is
 * created so the very first paint is right.
 * @param {string} userDataDir app.getPath("userData")
 * @returns {"dark" | "light" | null} what was applied, or null when nothing was recorded
 */
function restore(userDataDir) {
  const theme = readPersisted(userDataDir);
  if (theme) nativeTheme.themeSource = theme;
  return theme;
}

/**
 * Adopt the theme the page just reported.
 * @param {string} theme "dark" | "light" — anything else is ignored
 * @param {{ userDataDir: string, win?: import("electron").BrowserWindow | null }} ctx
 * @returns {"dark" | "light" | null} the applied theme, or null when `theme` was not one
 */
function set(theme, ctx) {
  const t = normalize(theme);
  if (!t) return null;
  const changed = nativeTheme.themeSource !== t;
  if (changed) {
    nativeTheme.themeSource = t;
    persist(ctx.userDataDir, t);
  }
  // Kept in sync even when themeSource already matched: the window is created
  // with the dark splash colour regardless of theme, so the first report after
  // a light-theme launch has to repaint it.
  const win = ctx.win;
  if (win && !win.isDestroyed()) {
    try {
      win.setBackgroundColor(BG[t]);
    } catch {
      // Non-fatal: cosmetic only.
    }
  }
  return t;
}

module.exports = { restore, set, BG };
