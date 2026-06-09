"use strict";

/**
 * Dashboard data source — reads the pi runtime config from ~/.pi (the stable,
 * documented data dir) and reports which MCP servers and extensions are
 * currently ACTIVE vs INACTIVE. No pi-web internals are touched; this only
 * reads files the agent itself reads, so the numbers match what pi loads.
 *
 * Activation semantics (kept identical to how pi actually loads things):
 *
 *  MCP servers — ~/.pi/agent/mcp.json `mcpServers` (consumed by the user's
 *  mcp-bridge.ts extension). A server is INACTIVE iff `disabled === true`
 *  (mcp-bridge skips it); otherwise it is ACTIVE (bridge connects + registers
 *  its tools). PI_MCP_CONFIG overrides the path, matching mcp-bridge.
 *
 *  Extensions — ~/.pi/agent/extensions/. pi auto-discovers `*.ts` files and
 *  `<dir>/index.ts`; those are ACTIVE. There is no native "disabled" flag, so
 *  the convention (already used in this repo, e.g. variflight-provider.ts.
 *  disabled.bak) is to rename a file so it no longer matches `*.ts` — those
 *  shadowed files are reported as INACTIVE. Extra explicit paths from
 *  settings.json `extensions` are also counted as active when they exist.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

function homeDir() {
  return os.homedir();
}

/** Resolve the pi data dir / config paths exactly as the running agent does. */
function paths() {
  const home = homeDir();
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  // mcp-bridge.ts hardcodes ~/.pi/agent/mcp.json (ignores PI_CODING_AGENT_DIR),
  // honoring only PI_MCP_CONFIG — mirror that so our count matches the bridge.
  const mcpConfigPath = process.env.PI_MCP_CONFIG || path.join(home, ".pi", "agent", "mcp.json");
  const extensionsDir = path.join(agentDir, "extensions");
  const settingsPath = path.join(agentDir, "settings.json");
  return { agentDir, mcpConfigPath, extensionsDir, settingsPath };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------
/** One-line summary of a server's target (url for http/sse, command for stdio). */
function mcpTarget(cfg) {
  if (!cfg || typeof cfg !== "object") return "";
  const type = cfg.type || "stdio";
  if (type === "http" || type === "sse") return String(cfg.url || "");
  const args = Array.isArray(cfg.args) ? cfg.args.join(" ") : "";
  return [cfg.command, args].filter(Boolean).join(" ").trim();
}

function readMcp(mcpConfigPath) {
  const active = [];
  const inactive = [];
  const parsed = readJson(mcpConfigPath);
  const servers = (parsed && parsed.mcpServers) || {};
  for (const [name, cfg] of Object.entries(servers)) {
    const entry = { name, type: (cfg && cfg.type) || "stdio", target: mcpTarget(cfg) };
    if (cfg && cfg.disabled === true) inactive.push({ ...entry, reason: "disabled" });
    else active.push(entry);
  }
  const sort = (a, b) => a.name.localeCompare(b.name);
  return { active: active.sort(sort), inactive: inactive.sort(sort) };
}

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------
// A file is a "disabled extension" if its name is a `.ts` extension shadowed by
// a trailing marker so pi's `*.ts` glob no longer matches it:
//   foo.ts.disabled | foo.ts.bak | foo.ts.off | foo.ts.disabled.bak
//   foo.disabled.ts | foo.off.ts
// Returns the base extension name, or null if the file isn't a disabled ext.
function disabledExtBase(name) {
  let m = name.match(/^(.+?)\.ts\.(disabled|bak|off)(?:\..*)?$/i);
  if (m) return m[1];
  m = name.match(/^(.+?)\.(disabled|off)\.ts$/i);
  if (m) return m[1];
  return null;
}

function isActiveExtFile(name) {
  return /\.ts$/i.test(name) && !/\.d\.ts$/i.test(name) && disabledExtBase(name) === null;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "disabled"]);

function readExtensions(extensionsDir, settingsPath) {
  const active = [];
  const inactive = [];
  const seen = new Set(); // resolved paths, to dedupe against settings.json

  let entries = [];
  try {
    entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith(".")) continue;
    const full = path.join(extensionsDir, name);

    if (ent.isFile()) {
      if (isActiveExtFile(name)) {
        active.push({ name: name.replace(/\.ts$/i, ""), kind: "file" });
        seen.add(path.resolve(full));
      } else {
        const base = disabledExtBase(name);
        if (base) inactive.push({ name: base, kind: "file", reason: "renamed-disabled" });
      }
      continue;
    }

    if (ent.isDirectory()) {
      if (IGNORE_DIRS.has(name)) {
        // A `disabled/` folder is a common parking lot for turned-off extensions.
        if (name === "disabled") {
          let inner = [];
          try {
            inner = fs.readdirSync(full, { withFileTypes: true });
          } catch {
            inner = [];
          }
          for (const f of inner) {
            if (f.isFile() && /\.ts$/i.test(f.name) && !/\.d\.ts$/i.test(f.name)) {
              inactive.push({ name: f.name.replace(/\.ts$/i, ""), kind: "file", reason: "in-disabled-dir" });
            } else if (f.isDirectory() && fileExists(path.join(full, f.name, "index.ts"))) {
              inactive.push({ name: f.name, kind: "dir", reason: "in-disabled-dir" });
            }
          }
        }
        continue;
      }
      // Directory extension: active iff it has a discoverable index.ts.
      if (fileExists(path.join(full, "index.ts"))) {
        active.push({ name, kind: "dir" });
        seen.add(path.resolve(path.join(full, "index.ts")));
      } else if (
        fileExists(path.join(full, "index.ts.disabled")) ||
        fileExists(path.join(full, "index.ts.bak")) ||
        fileExists(path.join(full, "index.disabled.ts"))
      ) {
        inactive.push({ name, kind: "dir", reason: "renamed-disabled" });
      }
    }
  }

  // settings.json `extensions: [...]` — explicit extra paths pi loads on top of
  // auto-discovery. Count existing ones as active (deduped against the dir scan).
  const settings = readJson(settingsPath);
  const extra = settings && Array.isArray(settings.extensions) ? settings.extensions : [];
  for (const p of extra) {
    if (typeof p !== "string" || !p.trim()) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(path.dirname(settingsPath), p);
    let target = abs;
    let kind = "file";
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        target = path.join(abs, "index.ts");
        kind = "dir";
      }
    } catch {
      continue; // path doesn't exist — skip
    }
    if (!fileExists(target)) continue;
    const resolved = path.resolve(target);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    active.push({ name: extNameFromPath(abs, kind), kind, source: "settings" });
  }

  const sort = (a, b) => a.name.localeCompare(b.name);
  return { active: active.sort(sort), inactive: inactive.sort(sort) };
}

function extNameFromPath(p, kind) {
  if (kind === "dir") return path.basename(p);
  return path.basename(p).replace(/\.ts$/i, "");
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token usage (since this app launch)
// ---------------------------------------------------------------------------
// pi stores sessions as JSONL under ~/.pi/agent/sessions/--<cwd>--/*.jsonl. Each
// assistant message line carries `message.usage` (see docs/session-format.md):
//   { input, output, cacheRead, cacheWrite, totalTokens, cost }
// "Total consumption since launch" = sum of `totalTokens` over every assistant
// message whose timestamp is >= the app's boot time, across ALL sessions. Each
// LLM call re-sends the growing context as input, so summing per-call totals is
// exactly the tokens actually consumed/billed this run (not the context size).
function num(v) {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

function collectJsonl(dir, out, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonl(full, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

function readTokenUsage(sessionsDir, sinceMs) {
  let total = 0;
  let input = 0;
  let output = 0;
  let calls = 0;
  const sessions = new Set();

  const files = [];
  collectJsonl(sessionsDir, files, 0);

  for (const file of files) {
    // A file untouched since boot can't hold post-boot turns — skip the read.
    if (sinceMs) {
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < sinceMs) continue;
    }

    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    let counted = false;
    for (const line of text.split("\n")) {
      // Cheap prefilter: only assistant lines carry a usage block.
      if (!line || line.indexOf('"usage"') === -1) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const m = entry && entry.message;
      if (!m || m.role !== "assistant" || !m.usage) continue;
      const ts =
        typeof m.timestamp === "number" ? m.timestamp : Date.parse(entry.timestamp || "") || 0;
      if (sinceMs && !(ts >= sinceMs)) continue;
      const u = m.usage;
      const tt =
        u.totalTokens != null
          ? num(u.totalTokens)
          : num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
      total += tt;
      input += num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
      output += num(u.output);
      calls += 1;
      counted = true;
    }
    if (counted) sessions.add(file);
  }

  return { total, input, output, calls, sessions: sessions.size, sinceMs: sinceMs || 0 };
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
/**
 * Read the full dashboard status. Never throws — partial data + error string.
 * @param {{ sinceMs?: number }} [opts] sinceMs = only count token usage from
 *   assistant turns at/after this epoch ms (the app boot time). 0/omitted = all.
 */
function readStatus(opts) {
  opts = opts || {};
  const { agentDir, mcpConfigPath, extensionsDir, settingsPath } = paths();
  const sessionsDir = path.join(agentDir, "sessions");
  let error;
  let mcp = { active: [], inactive: [] };
  let extensions = { active: [], inactive: [] };
  let tokens = { total: 0, input: 0, output: 0, calls: 0, sessions: 0, sinceMs: opts.sinceMs || 0 };
  try {
    mcp = readMcp(mcpConfigPath);
  } catch (e) {
    error = `MCP 读取失败: ${(e && e.message) || e}`;
  }
  try {
    extensions = readExtensions(extensionsDir, settingsPath);
  } catch (e) {
    error = (error ? error + "; " : "") + `扩展读取失败: ${(e && e.message) || e}`;
  }
  try {
    tokens = readTokenUsage(sessionsDir, opts.sinceMs || 0);
  } catch (e) {
    error = (error ? error + "; " : "") + `token 统计失败: ${(e && e.message) || e}`;
  }
  return {
    mcp,
    extensions,
    tokens,
    source: { agentDir, mcpConfigPath, extensionsDir, sessionsDir },
    error,
  };
}

module.exports = { readStatus };
