"use strict";

/**
 * Runtime self-updater for the bundled pi-web.
 *
 * pi-web (and its dependency @earendil-works/pi-coding-agent) lives in a
 * writable per-user runtime dir, installed from the published npm package which
 * ships a prebuilt `.next` — so updating is a plain `npm install`, no compile.
 *
 * All npm calls go through the BUNDLED node + npm so the target machine needs
 * nothing pre-installed.
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const PKG = "@cking000/pi-web";
// Bundled inside @agegr/pi-web; surfaced in the update CTA so the result names
// both packages the user cares about.
const AGENT_PKG = "@earendil-works/pi-coding-agent";

function getInstalledVersion(runtimeDir) {
  try {
    const p = path.join(runtimeDir, "node_modules", "@cking000", "pi-web", "package.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).version;
  } catch {
    return null;
  }
}

function getInstalledAgentVersion(runtimeDir) {
  try {
    const p = path.join(
      runtimeDir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json"
    );
    return JSON.parse(fs.readFileSync(p, "utf8")).version;
  } catch {
    return null;
  }
}

function runNpm(ctx, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const fullArgs = [ctx.npmCli, ...args, `--registry=${ctx.registry}`];
    const child = execFile(
      ctx.bundledNode,
      fullArgs,
      {
        cwd: opts.cwd || ctx.runtimeDir,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeout || 0,
        env: {
          ...process.env,
          // Make sure any child node/npx the install spawns resolves to bundled node.
          PATH: ctx.nodeDir + path.delimiter + (process.env.PATH || ""),
          npm_config_yes: "true",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout || "");
          err.stderr = String(stderr || "");
          reject(err);
        } else {
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        }
      }
    );
    if (opts.onProgress && child.stderr) {
      child.stderr.on("data", (d) => opts.onProgress(String(d)));
    }
  });
}

async function getLatestVersion(ctx) {
  const { stdout } = await runNpm(ctx, ["view", PKG, "version"], { timeout: 60000 });
  return stdout.trim();
}

async function installLatest(ctx, onProgress) {
  return runNpm(
    ctx,
    ["install", `${PKG}@latest`, "--omit=dev", "--no-audit", "--no-fund"],
    { timeout: 600000, onProgress }
  );
}

/** Compare dotted versions (x.y.z[-tag]); returns true if `latest` > `installed`. */
function isNewer(latest, installed) {
  if (!installed) return true;
  if (!latest) return false;
  const norm = (v) => v.split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const a = norm(latest);
  const b = norm(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

module.exports = {
  PKG,
  AGENT_PKG,
  getInstalledVersion,
  getInstalledAgentVersion,
  getLatestVersion,
  installLatest,
  isNewer,
};
