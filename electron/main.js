"use strict";

/**
 * pi-web-desktop — Electron main process (v2: bundled Node + self-updating runtime).
 *
 * Architecture:
 *  - A Node.js runtime is BUNDLED in the app (resources/node), so the target
 *    machine needs nothing pre-installed.
 *  - pi-web (the npm package @agegr/pi-web, which ships a prebuilt .next plus its
 *    @earendil-works/pi-coding-agent dependency) lives in a WRITABLE per-user
 *    runtime dir. A seed copy is shipped in the app and copied out on first run
 *    (so first launch works offline).
 *  - "Check for updates" runs `npm install @agegr/pi-web@latest` in that runtime
 *    dir using the bundled npm — updating pi-web + the agent SDK without a
 *    rebuild and without republishing this desktop app.
 *  - The Next.js server is launched hidden (no console window) on a random
 *    127.0.0.1 port and shown in a native window.
 */

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const updater = require("./updater");
const dashboard = require("./features/dashboard");

const isWindows = process.platform === "win32";
const REGISTRY = process.env.PI_WEB_REGISTRY || "https://registry.npmmirror.com";
const AUTO_CHECK = process.env.PI_WEB_AUTO_UPDATE_CHECK !== "0";
// When this app launch began (epoch ms). Captured at main-process load so it
// survives embedded-server restarts; the dashboard counts token usage from
// session turns at/after this moment ("since this pi-agent was opened").
const APP_BOOT_MS = Date.now();

const os = require("os");
const DEBUG_LOG = path.join(os.tmpdir(), "pi-web-desktop-debug.log");
function dbg(msg) {
  try {
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}
function bundledNodeDir() {
  // packaged: resources/node ; dev: vendor/node
  return app.isPackaged
    ? path.join(process.resourcesPath, "node")
    : path.join(__dirname, "..", "vendor", "node");
}
function bundledNodeExe() {
  return path.join(bundledNodeDir(), isWindows ? "node.exe" : "bin/node");
}
function bundledNpmCli() {
  return path.join(bundledNodeDir(), "node_modules", "npm", "bin", "npm-cli.js");
}
// Bundled relocatable Python (python-build-standalone, ppt-master deps
// pre-installed). packaged: resources/python ; dev: vendor/python.
function bundledPythonDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "python")
    : path.join(__dirname, "..", "vendor", "python");
}
function bundledPythonExe() {
  // install_only Windows build keeps python.exe at the dir root.
  return path.join(bundledPythonDir(), isWindows ? "python.exe" : "bin/python3");
}
// PATH dirs to prepend so the bundled python + its console scripts resolve.
// Empty when the bundled Python is absent (dev before `npm run seed:python`).
function bundledPythonPathDirs() {
  const exe = bundledPythonExe();
  if (!fs.existsSync(exe)) return [];
  const pyDir = bundledPythonDir();
  return [pyDir, path.join(pyDir, isWindows ? "Scripts" : "bin")];
}
// Env vars that wire the bundled Python into the pi server's environment so the
// python-workdir-guard extension can (a) create project .venvs FROM it (zero
// system-Python dependency) and (b) allowlist it for app-bundled skills like
// ppt-master — while still forcing the user's own project code through .venv.
// Returns {} when the bundled Python is absent so the guard cleanly falls back
// to a system Python.
function bundledPythonGuardEnv() {
  const exe = bundledPythonExe();
  if (!fs.existsSync(exe)) return {};
  return {
    // Read by ppt-master's SKILL.md to invoke its scripts on the bundled python.
    PI_BUNDLED_PYTHON: exe,
    // python-workdir-guard: interpreter to create project .venv from.
    PI_PY_GUARD_PYTHON: exe,
    // python-workdir-guard: extra interpreter treated as venv-compliant.
    PI_PY_GUARD_BUNDLED_PYTHON: exe,
  };
}
function seedDir() {
  return path.join(resourcesBase(), app.isPackaged ? "runtime-seed" : "runtime-seed");
}
let _runtimeDirCache = null;
function isWritable(dir) {
  try {
    const probe = path.join(dir, `.wtest-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
function runtimeDir() {
  if (_runtimeDirCache) return _runtimeDirCache;
  const seed = seedDir();
  // Preferred: run pi-web IN PLACE from the (writable) install dir — instant, no
  // first-run copy. Per-user installs (%LOCALAPPDATA%\Programs) and the unpacked
  // build are writable. Fallback (read-only install, e.g. Program Files): copy to
  // a writable user dir.
  if (fs.existsSync(seed) && isWritable(seed)) {
    _runtimeDirCache = seed;
    dbg(`runtimeDir = seed (in-place, writable): ${seed}`);
  } else {
    _runtimeDirCache = path.join(app.getPath("userData"), "runtime");
    dbg(`runtimeDir = userData (seed read-only): ${_runtimeDirCache}`);
  }
  return _runtimeDirCache;
}
function piWebPkgDir() {
  return path.join(runtimeDir(), "node_modules", "@cking000", "pi-web");
}
function nextBinPath() {
  return path.join(runtimeDir(), "node_modules", "next", "dist", "bin", "next");
}
function updaterCtx() {
  return {
    bundledNode: bundledNodeExe(),
    npmCli: bundledNpmCli(),
    nodeDir: bundledNodeDir(),
    runtimeDir: runtimeDir(),
    registry: REGISTRY,
  };
}

// ---------------------------------------------------------------------------
// Runtime seeding (first run copies the bundled seed to a writable dir)
// ---------------------------------------------------------------------------
/**
 * Robustly copy the seed dir CONTENTS into dst.
 * fs.cp aborts partway on huge node_modules trees on Windows (long paths),
 * so we use robocopy on Windows (battle-tested, long-path safe) and cp -a else.
 */
function copyRuntime(src, dst) {
  return new Promise((resolve, reject) => {
    if (isWindows) {
      const p = spawn(
        "robocopy",
        [src, dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"],
        { windowsHide: true }
      );
      p.on("error", reject);
      p.on("exit", (code) => {
        // robocopy: exit code < 8 == success (0=no change, 1=copied, etc.)
        if (code != null && code >= 8) reject(new Error(`robocopy failed (code ${code})`));
        else resolve();
      });
    } else {
      const p = spawn("cp", ["-a", `${src}/.`, dst]);
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cp failed (code ${code})`))));
    }
  });
}

async function ensureRuntime() {
  const rt = runtimeDir();
  const seed = seedDir();
  const inPlace = path.resolve(rt) === path.resolve(seed);

  if (inPlace) {
    // Running directly from the writable install dir — no copy needed.
    const v = updater.getInstalledVersion(rt);
    const reactOk = fs.existsSync(path.join(rt, "node_modules", "react", "package.json"));
    dbg(`ensureRuntime in-place v=${v} reactOk=${reactOk}`);
    if (!v || !reactOk) throw new Error(`in-place runtime incomplete at ${rt}`);
    return v;
  }

  // Fallback (read-only install): copy seed -> writable user dir.
  const marker = path.join(rt, ".seeded");
  if (fs.existsSync(marker)) {
    const v = updater.getInstalledVersion(rt);
    if (v) return v;
  }
  if (!fs.existsSync(path.join(seed, "node_modules", "@cking000", "pi-web", ".next"))) {
    throw new Error(`runtime seed not found or incomplete at ${seed}`);
  }
  await fs.promises.mkdir(rt, { recursive: true });
  dbg(`seeding runtime via robust copy: ${seed} -> ${rt}`);
  await copyRuntime(seed, rt);

  const v = updater.getInstalledVersion(rt);
  const reactOk = fs.existsSync(path.join(rt, "node_modules", "react", "package.json"));
  dbg(`seed copy done: version=${v} reactOk=${reactOk}`);
  if (!v || !reactOk) {
    throw new Error(`seed copy incomplete (version=${v}, react=${reactOk})`);
  }
  fs.writeFileSync(marker, v);
  return v;
}

// ---------------------------------------------------------------------------
// Bundled extensions sync (repo extensions-seed/ is the source of truth)
// ---------------------------------------------------------------------------
// Six single-file `.ts` extensions ship with the app. The repo's
// `extensions-seed/` is their CANONICAL SOURCE — they are developed there, never
// hand-edited in the data dir. On every launch we sync the bundle into
// ~/.pi/agent/extensions/ so the deployed copies always match the installed
// version: each managed file is (over)written whenever its content differs from
// the bundle, which is what makes the "edit in the repo → reinstall (or re-run)"
// loop actually deploy changes. The shared node_modules is deployed when missing
// or when the bundled lockfile changed; at runtime only @modelcontextprotocol/sdk
// (+ transitive deps) is needed — pi injects @earendil-works/pi-coding-agent into
// the extension loader itself, so it is intentionally NOT bundled.
//
// Only these managed names are touched (any other file in the dir is left
// alone), and any failure here is logged and swallowed so it can never block boot.
const DEFAULT_EXTENSIONS = [
  "agents-md-injector.ts",
  "auto-session-title.ts",
  "general-agent-prompt.ts",
  "mcp-bridge.ts",
  "python-workdir-guard.ts",
  "skill-shell-injection.ts",
  "variflight-web-search.ts",
];

function extensionsSeedDir() {
  return path.join(resourcesBase(), "extensions-seed");
}

function piAgentDir() {
  // Same resolution the running agent (and features/dashboard.js) uses.
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// Byte-equal compare so we only write when the bundle actually changed (no
// needless writes / mtime churn on every launch). A missing file compares unequal.
function sameContent(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

async function ensureBundledExtensions() {
  const seed = extensionsSeedDir();
  if (!fs.existsSync(seed)) {
    dbg(`extensions seed missing at ${seed} — skipping extension sync`);
    return;
  }
  const dest = path.join(piAgentDir(), "extensions");
  await fs.promises.mkdir(dest, { recursive: true });

  // Shared deps: deploy when dest has none yet, or when the bundled lockfile
  // differs from the deployed one (a dependency changed). robocopy /E (in
  // copyRuntime) overwrites changed files; rare stale leftovers are harmless.
  const seedNm = path.join(seed, "node_modules");
  const destNm = path.join(dest, "node_modules");
  const depsChanged =
    fs.existsSync(seedNm) &&
    (!fs.existsSync(destNm) ||
      !sameContent(path.join(seed, "package-lock.json"), path.join(dest, "package-lock.json")));
  if (depsChanged) {
    dbg(`syncing extension deps: ${seedNm} -> ${destNm}`);
    await fs.promises.mkdir(destNm, { recursive: true });
    await copyRuntime(seedNm, destNm);
    for (const manifest of ["package.json", "package-lock.json"]) {
      const s = path.join(seed, manifest);
      if (fs.existsSync(s)) {
        try {
          fs.copyFileSync(s, path.join(dest, manifest));
        } catch {
          /* ignore */
        }
      }
    }
  }

  // The managed extension files: (over)write whenever content differs from the
  // bundle. The user no longer edits these in the data dir — the repo wins.
  let synced = 0;
  for (const file of DEFAULT_EXTENSIONS) {
    const s = path.join(seed, file);
    if (!fs.existsSync(s)) continue;
    const d = path.join(dest, file);
    if (sameContent(s, d)) continue;
    try {
      fs.copyFileSync(s, d);
      synced++;
      dbg(`synced managed extension: ${file}`);
    } catch (e) {
      dbg(`failed to sync ${file}: ${(e && e.message) || e}`);
    }
  }
  dbg(`ensureBundledExtensions done; synced ${synced} file(s) to ${dest}`);
}

// ---------------------------------------------------------------------------
// Bundled skills sync (repo skills-seed/ is the source of truth)
// ---------------------------------------------------------------------------
// The OKF knowledge skills ship with the app so a fresh install has them active
// out of the box in ~/.pi/agent/skills/ (pi auto-discovers skills there, so they
// work in EVERY workspace). The repo's `skills-seed/` is their CANONICAL SOURCE —
// developed there, never hand-edited in the data dir. On every launch we sync each
// managed skill DIRECTORY into ~/.pi/agent/skills/<name>/: any file whose content
// differs from the bundle is (over)written, which is what makes the "edit in the
// repo -> reinstall (or re-run) loop" deploy changes. These skills are pure
// stdlib Python (no node_modules, no pip deps).
//
// Only these managed skill names are touched (any other skill in the dir is left
// alone). Files under __pycache__/ and *.pyc are never deployed. Any failure here
// is logged and swallowed so it can never block boot.
const DEFAULT_SKILLS = [
  "wiki-init",
  "wiki-compile",
  "wiki-query",
  "wiki-lint",
  "okf-visualizer",
  "ppt-master",
];

function skillsSeedDir() {
  return path.join(resourcesBase(), "skills-seed");
}

// Cheap content signature of a bundled skill tree: hash of (relpath|size|mtime)
// over all files — STAT ONLY, no file-body reads. Used to skip the deep per-file
// sync when the bundle is unchanged (critical for ppt-master's ~12k icon files,
// where deep-diffing every launch would be far too slow). Bundle mtimes change
// on reinstall/app-update and on a dev edit, so a real change always re-syncs.
function skillBundleSignature(dir) {
  const crypto = require("crypto");
  const parts = [];
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === "__pycache__") continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(full, r);
      } else if (e.isFile()) {
        if (e.name.endsWith(".pyc")) continue;
        try {
          const st = fs.statSync(full);
          parts.push(`${r}|${st.size}|${Math.floor(st.mtimeMs)}`);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir, "");
  return crypto.createHash("md5").update(parts.join("\n")).digest("hex");
}

async function ensureBundledSkills() {
  const seed = skillsSeedDir();
  if (!fs.existsSync(seed)) {
    dbg(`skills seed missing at ${seed} — skipping skill sync`);
    return;
  }
  const dest = path.join(piAgentDir(), "skills");
  await fs.promises.mkdir(dest, { recursive: true });

  let synced = 0;
  let skipped = 0;
  for (const name of DEFAULT_SKILLS) {
    const s = path.join(seed, name);
    if (!fs.existsSync(s)) continue;
    const skillDest = path.join(dest, name);
    // Fast path: skip the deep per-file diff when the bundle signature matches
    // the one recorded at last deploy (.seed-version).
    const sig = skillBundleSignature(s);
    const stampFile = path.join(skillDest, ".seed-version");
    let deployedSig = null;
    try {
      deployedSig = fs.readFileSync(stampFile, "utf8").trim();
    } catch {
      /* not deployed yet */
    }
    if (deployedSig === sig) {
      skipped++;
      continue;
    }
    // Copy via robocopy/cp (a SPAWNED process) rather than a synchronous
    // fs.copyFileSync loop: a large skill like ppt-master (~12k files) would
    // otherwise block the main thread for tens of seconds and freeze the window
    // ("not responding") on first deploy. `await` here yields to the event loop
    // while the child process runs, so the window stays responsive.
    try {
      await copyRuntime(s, skillDest);
      synced++;
      fs.writeFileSync(stampFile, sig);
      dbg(`synced skill ${name} (full copy)`);
    } catch (e) {
      dbg(`failed to sync skill ${name}: ${(e && e.message) || e}`);
    }
  }
  dbg(`ensureBundledSkills done; synced ${synced} skill(s), ${skipped} up-to-date, to ${dest}`);
}

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------
let serverProc = null;
let win = null;
let serverUrl = null;
let serverLog = "";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("server not ready in time"));
        else setTimeout(tryOnce, 300);
      });
      req.setTimeout(2500, () => req.destroy());
    };
    tryOnce();
  });
}

function startServer(port) {
  const nextBin = nextBinPath();
  const pkgDir = piWebPkgDir();
  dbg(
    `startServer node=${bundledNodeExe()} nodeExists=${fs.existsSync(bundledNodeExe())} ` +
      `nextBin=${nextBin} nextExists=${fs.existsSync(nextBin)} pkgDir=${pkgDir} ` +
      `nextDirExists=${fs.existsSync(path.join(pkgDir, ".next"))} port=${port}`
  );
  if (!fs.existsSync(path.join(pkgDir, ".next"))) {
    throw new Error(`pi-web .next not found in runtime: ${pkgDir}`);
  }
  serverProc = spawn(
    bundledNodeExe(),
    [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: pkgDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        // Prepend bundled node + bundled python dirs so agent tool subprocesses
        // (node/npx, and python for the guard / ppt-master) resolve to the
        // bundled runtimes. PI_* python hints are added when vendor/python ships.
        PATH: [bundledNodeDir(), ...bundledPythonPathDirs(), process.env.PATH || ""]
          .filter(Boolean)
          .join(path.delimiter),
        ...bundledPythonGuardEnv(),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !isWindows,
    }
  );

  const capture = (chunk) => {
    const text = chunk.toString();
    serverLog += text;
    if (serverLog.length > 20000) serverLog = serverLog.slice(-20000);
    dbg(`[server] ${text.replace(/\s+$/, "")}`);
    process.stdout.write(`[pi-web] ${text}`);
  };
  serverProc.stdout.on("data", capture);
  serverProc.stderr.on("data", capture);
  serverProc.on("error", (e) => dbg(`server spawn ERROR ${e && e.message}`));
  serverProc.on("exit", (code, signal) => {
    dbg(`server exit code=${code} signal=${signal}`);
    // Suppress the error popup for INTENTIONAL stops: app quit, a restart, or an
    // update that kills the old server before reinstalling. Only a genuinely
    // unexpected crash should alarm the user.
    if (!app.isQuitting && !restarting && !stoppingForUpdate) {
      dialog.showErrorBox(
        "Pi Agent 服务已停止",
        `内嵌服务意外退出 (code=${code}, signal=${signal})。\n\n最近输出:\n${serverLog.slice(-2000)}`
      );
    }
  });
}

function killServer() {
  if (!serverProc || serverProc.killed) return;
  const pid = serverProc.pid;
  try {
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        process.kill(pid, "SIGTERM");
      }
    }
  } catch {
    /* ignore */
  }
  serverProc = null;
}

let restarting = false;
// True while applyUpdate has intentionally stopped the server to reinstall, so
// the server-exit handler doesn't mistake the deliberate kill for a crash.
let stoppingForUpdate = false;
async function startOrRestartServer() {
  restarting = true;
  killServer();
  await new Promise((r) => setTimeout(r, 400)); // let file handles release
  const port = await getFreePort();
  serverUrl = `http://127.0.0.1:${port}`;
  startServer(port);
  await waitForServer(`${serverUrl}/`);
  restarting = false;
  if (win) win.loadURL(serverUrl);
  console.log(`[pi-web-desktop] server up at ${serverUrl}`);
}

// ---------------------------------------------------------------------------
// Update-result CTA (in-page, top-right corner)
// ---------------------------------------------------------------------------
// Because pi-web is not forked, the desktop shell surfaces the outcome of every
// update check as an overlay injected by preload.js. The main process only has
// to hand the renderer a small notice object; delivery is timing-aware because
// a successful update reloads the embedded server (and thus the page) before we
// can report it.
let pendingNotice = null;

/** Send the queued CTA to the renderer once a pi-web page is present. */
function flushUpdateNotice() {
  if (!pendingNotice || !win || win.isDestroyed()) return;
  try {
    win.webContents.send("pi-web-desktop:update-notice", pendingNotice);
    pendingNotice = null;
  } catch {
    /* not ready yet — did-finish-load will retry */
  }
}

/**
 * Queue an update-result CTA. Delivered immediately if the page is idle; if a
 * navigation is in flight (e.g. the post-update reload) it is held until the
 * did-finish-load handler flushes it.
 */
function notifyUpdate(notice) {
  pendingNotice = notice;
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) flushUpdateNotice();
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
let updating = false;
let lastKnownLatest = null;

async function checkForUpdates(interactive) {
  if (updating) return;
  const ctx = updaterCtx();
  const installed = updater.getInstalledVersion(runtimeDir());

  let latest;
  try {
    latest = await updater.getLatestVersion(ctx);
  } catch (e) {
    if (interactive) {
      dialog.showErrorBox("检查更新失败", String((e && e.stderr) || (e && e.message) || e).slice(-1500));
    }
    notifyUpdate({
      status: "error",
      title: "检查更新失败",
      message: "无法获取最新版本信息",
      detail: "请检查网络连接后重试。",
    });
    return;
  }
  lastKnownLatest = latest;

  if (!updater.isNewer(latest, installed)) {
    const agentV = updater.getInstalledAgentVersion(runtimeDir());
    notifyUpdate({
      status: "latest",
      title: "已是最新版本",
      message: `pi-web ${installed || "未知"}`,
      detail: agentV ? `pi-coding-agent ${agentV} · 无需更新` : "无需更新",
    });
    return;
  }

  // A newer version exists. The boot-time auto check updates silently; a manual
  // "检查更新…" asks first so the user controls the restart.
  if (interactive) {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["更新并重启", "以后再说"],
      defaultId: 0,
      cancelId: 1,
      title: "发现新版本",
      message: `发现 pi-web 新版本 ${latest}`,
      detail: `当前 ${installed || "未知"} → 最新 ${latest}\n\n将下载并自动重启内嵌服务（含 pi-coding-agent）。`,
    });
    if (choice !== 0) {
      // Deferred — leave an actionable CTA the user can trigger later.
      notifyUpdate({
        status: "available",
        title: "发现新版本",
        message: `pi-web ${latest} 可更新`,
        detail: `当前 ${installed || "未知"} → ${latest}`,
        action: { id: "apply-update", label: "更新并重启" },
      });
      return;
    }
  }

  await applyUpdate(ctx, installed, latest, interactive);
}

async function applyUpdate(ctx, installed, latest, interactive) {
  if (updating) return;
  updating = true;
  stoppingForUpdate = true; // deliberate stop below — don't show the crash popup
  try {
    if (win) await win.loadFile(path.join(__dirname, "updating.html")).catch(() => {});
    killServer();
    await new Promise((r) => setTimeout(r, 600));
    await updater.installLatest(ctx);
    // Install done; the new server is brought up via startOrRestartServer, whose
    // own `restarting` guard covers its lifecycle from here on.
    stoppingForUpdate = false;
    await startOrRestartServer();
    const v = updater.getInstalledVersion(runtimeDir());
    const agentV = updater.getInstalledAgentVersion(runtimeDir());
    notifyUpdate({
      status: "updated",
      title: "更新完成",
      message: `pi-web 已更新到 ${v || latest}`,
      detail: `${installed || "未知"} → ${v || latest}${agentV ? ` · pi-coding-agent ${agentV}` : ""}`,
    });
  } catch (e) {
    if (interactive) {
      dialog.showErrorBox("更新失败", String((e && e.stderr) || (e && e.message) || e).slice(-2000));
    }
    // Recover: bring the (old) server back up, then report on the reloaded page.
    try {
      await startOrRestartServer();
    } catch {
      /* ignore */
    }
    notifyUpdate({
      status: "error",
      title: "更新失败",
      message: "自动更新未完成，已恢复当前版本",
      detail: "可稍后通过菜单「检查更新…」重试。",
    });
  } finally {
    updating = false;
    stoppingForUpdate = false;
  }
}

// CTA action: user clicked "更新并重启" on a deferred-update notice.
ipcMain.on("pi-web-desktop:apply-update", () => {
  if (updating) return;
  const ctx = updaterCtx();
  const installed = updater.getInstalledVersion(runtimeDir());
  applyUpdate(ctx, installed, lastKnownLatest, true).catch(() => {});
});

// Dashboard action: user clicked "打开知识图谱" in the wiki popover. Generate the
// OKF graph for the ACTIVE workspace with the bundled Python (the okf-visualizer
// skill's build_visualizer.py), then open the self-contained HTML in a standalone
// in-app window (reused across opens). Non-fatal; logs and returns on any miss.
let okfGraphWin = null;
ipcMain.on("pi-web-desktop:open-okf-graph", async () => {
  try {
    const cwd = dashboard.activeCwd();
    if (!cwd) {
      dbg("open-okf-graph: no active workspace cwd");
      return;
    }
    let bundleDir = "wiki";
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(cwd, "okf.config.json"), "utf8"));
      if (cfg && typeof cfg.bundle_dir === "string" && cfg.bundle_dir.trim()) bundleDir = cfg.bundle_dir;
    } catch {
      /* no config — default bundle dir */
    }
    const py = bundledPythonExe();
    const script = path.join(piAgentDir(), "skills", "okf-visualizer", "scripts", "build_visualizer.py");
    if (!fs.existsSync(py) || !fs.existsSync(script)) {
      dbg(`open-okf-graph: missing py=${fs.existsSync(py)} script=${fs.existsSync(script)}`);
      return;
    }
    await new Promise((resolve) => {
      const p = spawn(py, [script, "--vault", cwd], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      });
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("error", (e) => {
        dbg(`open-okf-graph spawn error ${e.message}`);
        resolve();
      });
      p.on("exit", (code) => {
        if (code !== 0) dbg(`build_visualizer exit ${code}: ${err.slice(-300)}`);
        resolve();
      });
    });
    const htmlPath = path.join(cwd, bundleDir, "okf-graph.html");
    if (!fs.existsSync(htmlPath)) {
      dbg(`open-okf-graph: graph not generated at ${htmlPath}`);
      return;
    }
    if (okfGraphWin && !okfGraphWin.isDestroyed()) {
      // Cache-bust: loadFile would serve Chromium's cached copy of the same path
    // after the file is regenerated, so the graph never updates. A unique query
    // forces a fresh read from disk each open.
    okfGraphWin.loadURL(require("url").pathToFileURL(htmlPath).href + "?t=" + Date.now());
      okfGraphWin.focus();
      return;
    }
    okfGraphWin = new BrowserWindow({
      width: 1100,
      height: 760,
      title: "OKF 知识图谱",
      backgroundColor: "#0A0A0A",
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    okfGraphWin.on("closed", () => {
      okfGraphWin = null;
    });
    // Cache-bust: loadFile would serve Chromium's cached copy of the same path
    // after the file is regenerated, so the graph never updates. A unique query
    // forces a fresh read from disk each open.
    okfGraphWin.loadURL(require("url").pathToFileURL(htmlPath).href + "?t=" + Date.now());
    if (process.env.PI_OKF_DEVTOOLS) okfGraphWin.webContents.openDevTools({ mode: "bottom" });
    dbg(`open-okf-graph: opened ${htmlPath}`);
  } catch (e) {
    dbg(`open-okf-graph error ${(e && e.stack) || e}`);
  }
});

// ---------------------------------------------------------------------------
// Dashboard (MCP / extensions activation status)
// ---------------------------------------------------------------------------
// Backend for the bottom dashboard bar injected by preload.js. Reads ~/.pi
// config directly (see features/dashboard.js) and reports active/inactive
// MCP servers and extensions. Never throws — returns a partial result + error.
ipcMain.handle("pi-web-desktop:dashboard-status", async () => {
  try {
    // serverPid scopes subagent counting to THIS app's child processes.
    return await dashboard.readStatus({
      sinceMs: APP_BOOT_MS,
      serverPid: serverProc && !serverProc.killed ? serverProc.pid : undefined,
    });
  } catch (e) {
    dbg(`dashboard-status error ${(e && e.message) || e}`);
    return {
      mcp: { active: [], inactive: [] },
      extensions: { active: [], inactive: [] },
      tokens: { total: 0, input: 0, output: 0, calls: 0, sessions: 0 },
      subagents: { running: 0, runningList: [], doneSession: 0, failedSession: 0, recent: [] },
      error: String((e && e.message) || e),
    };
  }
});

// ---------------------------------------------------------------------------
// Window + lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0A0A0A", // pi-web Metro dark canvas (--bg) — avoids a pre-paint flash
    autoHideMenuBar: true,
    title: "Pi Agent",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "loading.html"));

  // Keep the native window/taskbar title as the app name. The embedded pi-web
  // page sets its own <title> ("Pi Agent Web"); we don't let that propagate to
  // the OS window so the shell consistently presents as "Pi Agent".
  win.on("page-title-updated", (e) => e.preventDefault());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-finish-load", () => {
    const cur = win && win.webContents.getURL();
    if (serverUrl && cur && cur.startsWith(serverUrl)) {
      console.log("[pi-web-desktop] window did-finish-load: pi-web UI rendered");
      // Deliver any update-result CTA queued while the page was (re)loading —
      // e.g. the "更新完成" notice set right after an update reloads the server.
      flushUpdateNotice();
    }
  });

  win.on("closed", () => {
    win = null;
  });
}

async function showError(err) {
  if (!win) return;
  await win.loadFile(path.join(__dirname, "error.html")).catch(() => {});
  win.webContents
    .executeJavaScript(
      `window.__setError(${JSON.stringify(String((err && err.message) || err))}, ${JSON.stringify(serverLog.slice(-3000))})`
    )
    .catch(() => {});
}

async function boot() {
  dbg(`boot start; isPackaged=${app.isPackaged} userData=${app.getPath("userData")}`);
  createWindow();
  try {
    dbg(`ensureRuntime; seedDir=${seedDir()} runtimeDir=${runtimeDir()}`);
    const v = await ensureRuntime();
    dbg(`runtime ready v=${v}`);
    console.log(`[pi-web-desktop] runtime ready, pi-web ${v}`);
    // Sync the bundled extensions (repo extensions-seed/ is the source of truth)
    // into ~/.pi before the server starts. Non-fatal: never block boot.
    try {
      await ensureBundledExtensions();
    } catch (e) {
      dbg(`ensureBundledExtensions error (non-fatal): ${(e && e.stack) || e}`);
    }
    // Sync the bundled OKF knowledge skills (repo skills-seed/ is the source of
    // truth) into ~/.pi/agent/skills/. Non-fatal: never block boot.
    try {
      await ensureBundledSkills();
    } catch (e) {
      dbg(`ensureBundledSkills error (non-fatal): ${(e && e.stack) || e}`);
    }
    await startOrRestartServer();
    dbg("startOrRestartServer returned ok");
    if (AUTO_CHECK) {
      setTimeout(() => checkForUpdates(false).catch(() => {}), 5000);
    }
  } catch (err) {
    dbg(`BOOT ERROR ${(err && err.stack) || err}`);
    await showError(err);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    boot();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) boot();
    });
  });
}

app.on("window-all-closed", () => {
  app.isQuitting = true;
  killServer();
  app.quit();
});
app.on("before-quit", () => {
  app.isQuitting = true;
  killServer();
});
process.on("exit", killServer);

function buildMenu() {
  const template = [
    {
      label: "App",
      submenu: [
        {
          label: "检查更新…",
          click: () => checkForUpdates(true),
        },
        {
          label: "重新加载",
          accelerator: "CmdOrCtrl+R",
          click: () => win && win.webContents.reloadIgnoringCache(),
        },
        {
          label: "重启内嵌服务",
          click: () => startOrRestartServer().catch((e) => dialog.showErrorBox("重启失败", String(e))),
        },
        {
          label: "开发者工具",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => win && win.webContents.toggleDevTools(),
        },
        { type: "separator" },
        { role: "quit", label: "退出" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
