"use strict";

/**
 * Sub-agent data source — reports how many subagent (child pi) sessions the
 * running pi-web instance currently has in flight, plus a short record of the
 * ones that finished during this app session. Feeds the "Sub-agents" chip on the
 * bottom dashboard bar (see preload.js).
 *
 * Why a separate signal from MCP/extensions: subagents are spawned by the
 * `pi-subagents` package as CHILD `pi` PROCESSES (foreground or background). The
 * Electron shell is a different process from the pi-web Next.js server that owns
 * the live in-memory run state, so the only thing the shell can observe is the
 * filesystem and the OS process table. Three sources, in order of reliability:
 *
 *  1. LIVE PROCESS TREE (authoritative for "running now", covers foreground AND
 *     background). Every running subagent is a live child process executing
 *     `@earendil-works/pi-coding-agent/dist/cli.js`, descended from the pi-web
 *     server process. We walk the process table from the server pid and count
 *     those. Foreground top-level runs write NO status file (their state lives
 *     only in the server's memory), so this is the one signal that sees them.
 *
 *  2. ASYNC STATUS FILES (`<tmp>/pi-subagents-<scope>/async-subagent-runs/<id>/
 *     status.json`) — background/async runs persist rich state here (state, pid,
 *     mode, per-step agents). Used to NAME running background runs and as a
 *     fallback count when process enumeration is unavailable.
 *
 *  3. RUN HISTORY (`~/.pi/agent/run-history.jsonl`) — append log of COMPLETED
 *     runs ({agent, task, ts, status, duration}). Used for the "done this
 *     session" / "failed" counts and the recent list.
 *
 * Never throws — always returns a partial result plus an `error` string.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// ---------------------------------------------------------------------------
// Temp-dir scoping — mirror pi-subagents' resolveTempScopeId() exactly so the
// paths we read line up with what the package writes (shared/types.ts).
// ---------------------------------------------------------------------------
function sanitizeScopeSegment(value) {
  const sanitized = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function resolveTempScopeId() {
  // POSIX: uid-based (matches process.getuid()).
  if (typeof process.getuid === "function") {
    try {
      return `uid-${process.getuid()}`;
    } catch {
      /* fall through */
    }
  }
  for (const key of ["USERNAME", "USER", "LOGNAME"]) {
    const v = process.env[key];
    if (v) return `user-${sanitizeScopeSegment(v)}`;
  }
  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeScopeSegment(username)}`;
  } catch {
    /* fall through */
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) return `home-${sanitizeScopeSegment(home)}`;
  return "shared";
}

function tempRootDir() {
  return path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId()}`);
}

function agentDir() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return os.homedir();
  if (configured && configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return configured || path.join(os.homedir(), ".pi", "agent");
}

// ---------------------------------------------------------------------------
// Process table
// ---------------------------------------------------------------------------
// One subagent session == one live `pi` cli.js process. We identify them by the
// pi-coding-agent CLI entry in the command line; the package + bin path are
// stable across versions ("@earendil-works/pi-coding-agent" → "dist/cli.js"),
// so this match doesn't rot the way an arg-shape match would.
const PI_CLI_RE = /pi-coding-agent[\\/](?:dist[\\/])?cli\.js/i;
// pi-web's own server is `node .../next/dist/bin/next start` — never a subagent.
const NEXT_SERVER_RE = /[\\/]next[\\/]dist[\\/]bin[\\/]next\b/i;
// Foreground runs pass the task via a temp prompt file named "<agent>.md"
// (utils.writePrompt). Recover the agent name from the command line when present.
const PROMPT_FILE_RE = /pi-subagent[s]?-[^"'\s]*[\\/]([A-Za-z0-9_.-]+)\.md/i;

function isSubagentCmd(cmd) {
  if (!cmd) return false;
  if (NEXT_SERVER_RE.test(cmd)) return false;
  return PI_CLI_RE.test(cmd);
}

function agentNameFromCmd(cmd) {
  const m = cmd && cmd.match(PROMPT_FILE_RE);
  return m ? m[1] : undefined;
}

/**
 * Snapshot the process table as [{ pid, ppid, cmd }]. Best-effort and
 * cross-platform; resolves to [] (never rejects) if the query fails or times out.
 */
function listProcesses() {
  return new Promise((resolve) => {
    const done = (list) => resolve(Array.isArray(list) ? list : []);

    if (process.platform === "win32") {
      // PowerShell CIM query → JSON. Only the fields we need, to keep it cheap.
      const ps =
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { timeout: 5000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return done([]);
          try {
            let parsed = JSON.parse(stdout);
            if (!Array.isArray(parsed)) parsed = [parsed];
            done(
              parsed.map((p) => ({
                pid: Number(p.ProcessId),
                ppid: Number(p.ParentProcessId),
                cmd: p.CommandLine || "",
              }))
            );
          } catch {
            done([]);
          }
        }
      );
    } else {
      // ps: pid, ppid, full command. `=` headers suppress the column titles.
      execFile(
        "ps",
        ["-eo", "pid=,ppid=,args="],
        { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return done([]);
          const list = [];
          for (const line of stdout.split("\n")) {
            const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
            if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
          }
          done(list);
        }
      );
    }
  });
}

/** All pids descended (any depth) from rootPid, via the parent links. */
function descendantPids(procs, rootPid) {
  const childrenByParent = new Map();
  for (const p of procs) {
    if (!childrenByParent.has(p.ppid)) childrenByParent.set(p.ppid, []);
    childrenByParent.get(p.ppid).push(p);
  }
  const out = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenByParent.get(cur) || []) {
      if (out.has(child.pid)) continue; // guard against pid-reuse cycles
      out.add(child.pid);
      stack.push(child.pid);
    }
  }
  return out;
}

/**
 * Live subagent sessions = pi cli.js processes descended from the server. If no
 * serverPid is known (or it's not in the table), fall back to matching every pi
 * cli.js process EXCEPT the obvious unrelated ones — less precise, but better
 * than reporting nothing.
 */
function findRunningSubagents(procs, serverPid) {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let candidates;
  if (serverPid && byPid.has(serverPid)) {
    const desc = descendantPids(procs, serverPid);
    candidates = procs.filter((p) => desc.has(p.pid));
  } else {
    candidates = procs;
  }
  return candidates
    .filter((p) => isSubagentCmd(p.cmd))
    .map((p) => ({ pid: p.pid, agent: agentNameFromCmd(p.cmd), source: "process" }));
}

// ---------------------------------------------------------------------------
// Async run status files (background runs — rich detail + fallback count)
// ---------------------------------------------------------------------------
const TERMINAL_STATES = new Set(["complete", "failed", "paused"]);

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ exists but owned by another user (still alive); ESRCH ⇒ gone.
    return e && e.code === "EPERM";
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Scan async-subagent-runs/. Returns { active, done } where a run is "active"
 * iff its state is non-terminal AND its pid is still alive (mirrors the
 * package's stale-run reconciliation, so a crashed run isn't stuck "running").
 */
function readAsyncRuns() {
  const root = path.join(tempRootDir(), "async-subagent-runs");
  const active = [];
  const done = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { active, done }; // dir absent ⇒ no async runs this machine/session
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const status = readJson(path.join(root, ent.name, "status.json"));
    if (!status) continue;
    const agents = Array.isArray(status.steps)
      ? status.steps.map((s) => s && s.agent).filter(Boolean)
      : [];
    const run = {
      id: status.runId || ent.name,
      state: status.state,
      mode: status.mode,
      pid: typeof status.pid === "number" ? status.pid : undefined,
      agents,
      startedAt: status.startedAt,
      lastUpdate: status.lastUpdate,
    };
    const live = !TERMINAL_STATES.has(status.state) && pidAlive(run.pid);
    if (live) active.push(run);
    else done.push(run);
  }
  return { active, done };
}

// ---------------------------------------------------------------------------
// Run history (completed runs this session)
// ---------------------------------------------------------------------------
/**
 * Tally run-history.jsonl. `sinceMs` (app boot, epoch ms) scopes the ok/failed
 * counts to "this app session"; ts in the file is epoch SECONDS. `recent` is the
 * last few entries regardless of session, newest first, for the popover.
 */
function readRunHistory(sinceMs) {
  const file = path.join(agentDir(), "run-history.jsonl");
  const result = { doneSession: 0, failedSession: 0, recent: [] };
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return result;
  }
  const sinceSec = sinceMs ? Math.floor(sinceMs / 1000) : 0;
  const entries = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!e || typeof e.agent !== "string") continue;
    entries.push(e);
    if (!sinceSec || (typeof e.ts === "number" && e.ts >= sinceSec)) {
      if (e.status === "error") result.failedSession += 1;
      else result.doneSession += 1;
    }
  }
  result.recent = entries
    .slice(-8)
    .reverse()
    .map((e) => ({
      agent: e.agent,
      status: e.status === "error" ? "error" : "ok",
      durationMs: typeof e.duration === "number" ? e.duration : undefined,
      ts: typeof e.ts === "number" ? e.ts : undefined,
    }));
  return result;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------
/**
 * @param {{ serverPid?: number, sinceMs?: number }} [opts]
 *   serverPid — pid of the pi-web Next.js server (so we count only THIS app's
 *   subagents). sinceMs — app boot time, scopes the "done this session" tally.
 * @returns {Promise<{
 *   running: number, runningList: Array, doneSession: number,
 *   failedSession: number, recent: Array, error?: string
 * }>}
 */
async function readSubagents(opts) {
  opts = opts || {};
  const out = {
    running: 0,
    runningList: [],
    doneSession: 0,
    failedSession: 0,
    recent: [],
    error: undefined,
  };

  let procEnumFailed = false;
  let procs = [];
  try {
    procs = await listProcesses();
    if (procs.length === 0) procEnumFailed = true;
  } catch (e) {
    procEnumFailed = true;
    out.error = `进程枚举失败: ${(e && e.message) || e}`;
  }

  let asyncRuns = { active: [], done: [] };
  try {
    asyncRuns = readAsyncRuns();
  } catch (e) {
    out.error = (out.error ? out.error + "; " : "") + `async 状态读取失败: ${(e && e.message) || e}`;
  }

  // Build the running list. Prefer the live process table (sees foreground +
  // background). Enrich a process with its background run's agent names when its
  // pid matches an async run; otherwise use the prompt-file name if we recovered
  // one. When process enumeration is unavailable, fall back to the async active
  // runs so background runs are still reflected.
  if (!procEnumFailed) {
    const running = findRunningSubagents(procs, opts.serverPid);
    const asyncByPid = new Map();
    for (const r of asyncRuns.active) if (r.pid) asyncByPid.set(r.pid, r);
    out.runningList = running.map((p) => {
      const match = asyncByPid.get(p.pid);
      if (match) {
        return {
          pid: p.pid,
          agent: match.agents.length ? match.agents.join(", ") : p.agent,
          mode: match.mode,
          source: "background",
        };
      }
      return { pid: p.pid, agent: p.agent, mode: undefined, source: "foreground" };
    });
    // Async runs whose pid never surfaced in the process table (e.g. a detached
    // run we couldn't link) still count — add any not already represented.
    const seenPids = new Set(out.runningList.map((r) => r.pid));
    for (const r of asyncRuns.active) {
      if (r.pid && seenPids.has(r.pid)) continue;
      out.runningList.push({
        pid: r.pid,
        agent: r.agents.length ? r.agents.join(", ") : undefined,
        mode: r.mode,
        source: "background",
      });
    }
  } else {
    out.runningList = asyncRuns.active.map((r) => ({
      pid: r.pid,
      agent: r.agents.length ? r.agents.join(", ") : undefined,
      mode: r.mode,
      source: "background",
    }));
  }
  out.running = out.runningList.length;

  const history = readRunHistory(opts.sinceMs);
  out.doneSession = history.doneSession;
  out.failedSession = history.failedSession;
  out.recent = history.recent;

  return out;
}

module.exports = { readSubagents };
