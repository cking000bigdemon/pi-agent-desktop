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
 *
 * NOTE ON WHERE INSTALLS LAND: `installInto()` is the entry point used by
 * runtime-guard.js, which always points it at a STAGING directory and only
 * swaps the result into place once it verifies. `installLatest()` — the old
 * in-place install — is kept only for callers that explicitly want the legacy
 * behaviour; new code should not use it, because an interruption mid-install
 * corrupts the live runtime (exactly the failure this module's staging path
 * was added to prevent).
 */

const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const PKG = "@agegr/pi-web";
// Bundled inside @agegr/pi-web; surfaced in the update CTA so the result names
// both packages the user cares about.
const AGENT_PKG = "@earendil-works/pi-coding-agent";

function getInstalledVersion(runtimeDir) {
  try {
    const p = path.join(runtimeDir, "node_modules", "@agegr", "pi-web", "package.json");
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

/**
 * Install into an arbitrary directory (in practice: runtime-guard's staging dir).
 *
 * `spec` selects the two modes that matter:
 *   - a package spec (e.g. "@agegr/pi-web@latest") → an UPDATE. npm resolves the
 *     new version and rewrites package.json/package-lock.json in the staging dir,
 *     so the manifests travel with the tree they describe when it is swapped in.
 *   - null → a REINSTALL of what the copied lockfile already pins. Used by the
 *     self-heal path: reproduce the current version exactly rather than silently
 *     turning "your install is damaged" into "you also got upgraded".
 *
 * `npm ci` is preferred for the null case because it installs strictly from the
 * lockfile into an empty tree — the most reproducible option available. It
 * refuses to run when the lockfile is absent or out of sync with package.json,
 * so fall back to `npm install` there.
 */
async function installInto(ctx, dir, spec, onProgress) {
  const common = ["--omit=dev", "--no-audit", "--no-fund"];
  const opts = { cwd: dir, timeout: 900000, onProgress };

  if (spec) {
    return runNpm(ctx, ["install", spec, ...common], opts);
  }

  const fs = require("fs");
  const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));
  if (hasLock) {
    try {
      return await runNpm(ctx, ["ci", ...common], opts);
    } catch (e) {
      // Out-of-sync lockfile (EUSAGE) — fall through to a normal install rather
      // than leaving the user with an unrepairable runtime.
      const msg = String((e && e.stderr) || (e && e.message) || "");
      if (!/EUSAGE|can only install packages when|lock ?file/i.test(msg)) throw e;
    }
  }
  return runNpm(ctx, ["install", ...common], opts);
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
  installInto,
  isNewer,
};
