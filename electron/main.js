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

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const updater = require("./updater");

const isWindows = process.platform === "win32";
const REGISTRY = process.env.PI_WEB_REGISTRY || "https://registry.npmmirror.com";
const AUTO_CHECK = process.env.PI_WEB_AUTO_UPDATE_CHECK !== "0";

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
  return path.join(runtimeDir(), "node_modules", "@agegr", "pi-web");
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
  if (!fs.existsSync(path.join(seed, "node_modules", "@agegr", "pi-web", ".next"))) {
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
        // Prepend bundled node dir so agent tool subprocesses (node/npx) resolve here.
        PATH: bundledNodeDir() + path.delimiter + (process.env.PATH || ""),
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
    if (!app.isQuitting && !restarting) {
      dialog.showErrorBox(
        "pi-web 服务已停止",
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
// Updates
// ---------------------------------------------------------------------------
let updating = false;
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
    return;
  }

  if (!updater.isNewer(latest, installed)) {
    if (interactive) {
      dialog.showMessageBox(win, {
        type: "info",
        title: "检查更新",
        message: "已是最新版本",
        detail: `当前 pi-web 版本：${installed || "未知"}`,
      });
    }
    return;
  }

  const choice = dialog.showMessageBoxSync(win, {
    type: "question",
    buttons: ["更新并重启", "以后再说"],
    defaultId: 0,
    cancelId: 1,
    title: "发现新版本",
    message: `发现 pi-web 新版本 ${latest}`,
    detail: `当前 ${installed || "未知"} → 最新 ${latest}\n\n将下载并自动重启内嵌服务（含 pi-coding-agent）。`,
  });
  if (choice !== 0) return;

  updating = true;
  try {
    if (win) await win.loadFile(path.join(__dirname, "updating.html")).catch(() => {});
    killServer();
    await new Promise((r) => setTimeout(r, 600));
    await updater.installLatest(ctx);
    await startOrRestartServer();
    const v = updater.getInstalledVersion(runtimeDir());
    if (interactive) {
      dialog.showMessageBox(win, { type: "info", title: "更新完成", message: "pi-web 已更新", detail: `当前版本：${v}` });
    }
  } catch (e) {
    dialog.showErrorBox("更新失败", String((e && e.stderr) || (e && e.message) || e).slice(-2000));
    // Recover: bring the (old) server back up.
    try {
      await startOrRestartServer();
    } catch {
      /* ignore */
    }
  } finally {
    updating = false;
  }
}

// ---------------------------------------------------------------------------
// Window + lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0b0c",
    autoHideMenuBar: true,
    title: "pi-web",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "loading.html"));

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
