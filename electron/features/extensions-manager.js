"use strict";

/**
 * Bundled-extension manager — selective install + non-destructive sync.
 *
 * The app ships a set of pi extensions in `extensions-seed/` (catalogued by
 * `extensions-seed/manifest.json`) and deploys the ones the user picked into
 * ~/.pi/agent/extensions/.
 *
 * Two rules define the whole module:
 *
 *  1. SELECTIVE — the user chooses which extensions to install (first-run
 *     picker, re-openable from App → 扩展管理…). Deselecting never deletes: the
 *     file is renamed to `<name>.ts.disabled`, which is pi's own convention for
 *     an inactive extension (and what features/dashboard.js already counts as
 *     INACTIVE), so re-enabling restores the user's own copy verbatim.
 *
 *  2. NEVER CLOBBER USER EDITS — this replaces the old "the repo always wins,
 *     overwrite on every launch" policy, which silently ate hand edits made in
 *     ~/.pi. We remember the hash of exactly what we wrote (`deployedHash`);
 *     on later launches a deployed file is only overwritten while it still
 *     matches that hash (i.e. untouched). Once the user edits it, the bundle
 *     never overwrites it again — the newer bundled version is merely reported
 *     as "有新版可用" in the picker, where an explicit 「恢复内置版本」 (which
 *     backs the user's copy up first) is the only path that overwrites.
 *
 * Hashes are computed on CRLF-normalized content: `core.autocrlf` can check the
 * seed out as CRLF while the deployed copy is LF, and a pure line-ending delta
 * must not read as "the user edited this" (nor as "an update is available").
 *
 * All state lives in ONE json under userData (see stateFile in the ctx); ~/.pi
 * stays exactly as pi itself expects it — no sidecar files in the data dir.
 *
 * Every entry point is defensive: a corrupt manifest/state or an unreadable
 * seed degrades to "do nothing" rather than throwing, because the caller runs
 * this on the boot path.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STATE_VERSION = 1;

/**
 * @typedef {Object} ExtCtx
 * @property {string} seedDir   bundled extensions-seed dir (resources/ or repo)
 * @property {string} destDir   ~/.pi/agent/extensions
 * @property {string} stateFile userData/extensions-state.json
 * @property {(src: string, dst: string) => Promise<void>} copyDir robocopy/cp helper
 * @property {(msg: string) => void} dbg debug logger
 */

// ---------------------------------------------------------------------------
// Hashing / small fs helpers
// ---------------------------------------------------------------------------

// EOL-insensitive content digest — see the module header for why.
function hashFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    return crypto.createHash("md5").update(text).digest("hex");
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

// ---------------------------------------------------------------------------
// Catalog (extensions-seed/manifest.json)
// ---------------------------------------------------------------------------

/**
 * Read the bundled catalog. Falls back to "every .ts in the seed dir, all
 * default-on" so an older/hand-assembled bundle without a manifest still works.
 * @param {ExtCtx} ctx
 * @returns {{ ok: boolean, extensions: Array<Object> }}
 */
function loadCatalog(ctx) {
  if (!exists(ctx.seedDir)) return { ok: false, extensions: [] };

  const manifest = readJson(path.join(ctx.seedDir, "manifest.json"));
  if (manifest && Array.isArray(manifest.extensions)) {
    const extensions = manifest.extensions
      .filter((e) => e && e.id && e.file)
      .map((e) => ({
        id: String(e.id),
        file: String(e.file),
        name: e.name || e.file,
        summary: e.summary || "",
        description: e.description || "",
        default: e.default !== false,
        deps: Array.isArray(e.deps) ? e.deps : [],
      }));
    if (extensions.length) return { ok: true, extensions };
  }

  ctx.dbg("extensions manifest missing/invalid — falling back to seed dir scan");
  let files = [];
  try {
    files = fs
      .readdirSync(ctx.seedDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.ts$/i.test(e.name) && !/\.d\.ts$/i.test(e.name))
      .map((e) => e.name);
  } catch {
    files = [];
  }
  return {
    ok: files.length > 0,
    extensions: files.map((file) => ({
      id: file.replace(/\.ts$/i, ""),
      file,
      name: file,
      summary: "",
      description: "",
      default: true,
      deps: [],
    })),
  };
}

// ---------------------------------------------------------------------------
// Persisted selection state
// ---------------------------------------------------------------------------

/** @param {ExtCtx} ctx */
function readState(ctx) {
  const state = readJson(ctx.stateFile);
  if (!state || typeof state !== "object" || !state.extensions) return null;
  return state;
}

/** True once the user has made a choice (i.e. the first-run picker is done). */
function hasSelection(ctx) {
  return readState(ctx) !== null;
}

function writeState(ctx, state) {
  try {
    fs.mkdirSync(path.dirname(ctx.stateFile), { recursive: true });
    fs.writeFileSync(
      ctx.stateFile,
      JSON.stringify({ ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (e) {
    ctx.dbg(`failed to write extensions state: ${(e && e.message) || e}`);
  }
}

function blankRecord(file) {
  return { file, selected: false, deployedHash: null, deployedAt: null, updatePending: false };
}

// ---------------------------------------------------------------------------
// Disabled-variant handling (pi's own convention: rename so `*.ts` misses it)
// ---------------------------------------------------------------------------

function listDest(destDir) {
  try {
    return fs.readdirSync(destDir);
  } catch {
    return [];
  }
}

/**
 * Any rename that makes pi's `*.ts` glob miss the file — the same shapes
 * features/dashboard.js reports as an INACTIVE extension. Detection only.
 */
function disabledVariant(destDir, file) {
  const base = file.replace(/\.ts$/i, "");
  const shadowed = new RegExp(`^${escapeRe(file)}\\.(disabled|bak|off)(\\..*)?$`, "i");
  const infix = new RegExp(`^${escapeRe(base)}\\.(disabled|off)\\.ts$`, "i");
  return listDest(destDir).find((n) => shadowed.test(n) || infix.test(n)) || null;
}

/**
 * The subset we are willing to rename BACK into place when the extension is
 * re-selected: only deliberate "disabled" markers. `.bak` copies are excluded
 * on purpose — those are snapshots (possibly several, possibly stale), and
 * promoting one to the live file would be a guess about the user's intent.
 */
function restorableDisabled(destDir, file) {
  const base = file.replace(/\.ts$/i, "");
  const off = new RegExp(`^${escapeRe(file)}\\.disabled(\\.\\d+)?$`, "i");
  const infix = new RegExp(`^${escapeRe(base)}\\.disabled\\.ts$`, "i");
  return listDest(destDir).find((n) => off.test(n) || infix.test(n)) || null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Never overwrite an existing backup — pick the first free `<file>.disabled[.n]`.
function freeDisabledPath(destDir, file) {
  let candidate = path.join(destDir, `${file}.disabled`);
  let n = 1;
  while (exists(candidate)) candidate = path.join(destDir, `${file}.disabled.${n++}`);
  return candidate;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Per-extension view used by the picker UI and by syncOnLaunch's decisions.
 *  installed        — active `<file>.ts` present in ~/.pi/agent/extensions
 *  disabledFile     — name of the renamed (inactive) copy, when present
 *  modified         — on-disk content is neither the bundle nor what we wrote
 *  updateAvailable  — bundle differs from what is on disk
 * @param {ExtCtx} ctx
 */
function computeStatus(ctx) {
  const { extensions: catalog, ok } = loadCatalog(ctx);
  const state = readState(ctx);
  const records = (state && state.extensions) || {};

  const list = catalog.map((entry) => {
    const seedPath = path.join(ctx.seedDir, entry.file);
    const destPath = path.join(ctx.destDir, entry.file);
    const seedHash = hashFile(seedPath);
    const destHash = hashFile(destPath);
    const rec = records[entry.id];
    const installed = destHash !== null;
    const pristine =
      installed && (destHash === seedHash || (rec && rec.deployedHash && destHash === rec.deployedHash));

    return {
      ...entry,
      seedMissing: seedHash === null,
      // No record yet -> first run: pre-check the defaults. An extension the
      // user explicitly deselected stays unchecked even while its disabled copy
      // sits on disk.
      selected: rec ? rec.selected === true : entry.default,
      known: Boolean(rec),
      installed,
      disabledFile: installed ? null : disabledVariant(ctx.destDir, entry.file),
      modified: installed && !pristine,
      updateAvailable: installed && seedHash !== null && destHash !== seedHash,
      updatePending: Boolean(rec && rec.updatePending),
    };
  });

  return { ok, firstRun: state === null, destDir: ctx.destDir, extensions: list };
}

// ---------------------------------------------------------------------------
// Deployment primitives
// ---------------------------------------------------------------------------

function deployFile(ctx, entry) {
  const seedPath = path.join(ctx.seedDir, entry.file);
  const destPath = path.join(ctx.destDir, entry.file);
  fs.copyFileSync(seedPath, destPath);
  return hashFile(destPath);
}

/**
 * Shared node_modules for the extensions that need one (currently only
 * mcp-bridge's @modelcontextprotocol/sdk). Deployed when the destination has
 * none yet, or when the bundled lockfile differs from the deployed one.
 * Skipped entirely when no SELECTED extension declares a dependency.
 * @param {ExtCtx} ctx
 */
async function ensureDeps(ctx, needed) {
  if (!needed) return false;
  const seedNm = path.join(ctx.seedDir, "node_modules");
  if (!exists(seedNm)) return false;

  const destNm = path.join(ctx.destDir, "node_modules");
  const seedLock = path.join(ctx.seedDir, "package-lock.json");
  const destLock = path.join(ctx.destDir, "package-lock.json");
  const upToDate = exists(destNm) && hashFile(seedLock) !== null && hashFile(seedLock) === hashFile(destLock);
  if (upToDate) return false;

  ctx.dbg(`syncing extension deps: ${seedNm} -> ${destNm}`);
  await fs.promises.mkdir(destNm, { recursive: true });
  await ctx.copyDir(seedNm, destNm);
  for (const manifest of ["package.json", "package-lock.json"]) {
    const s = path.join(ctx.seedDir, manifest);
    if (exists(s)) {
      try {
        fs.copyFileSync(s, path.join(ctx.destDir, manifest));
      } catch {
        /* ignore */
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Apply an explicit selection (first-run picker / 扩展管理 dialog)
// ---------------------------------------------------------------------------

/**
 * Install the selected extensions, disable the deselected ones, and record the
 * choice. Files already present are ADOPTED, never overwritten: if the on-disk
 * copy differs from the bundle we keep it and remember "we did not write this"
 * (deployedHash = null), so the launch sync can never clobber it either.
 * @param {ExtCtx} ctx
 * @param {string[]} selectedIds
 */
async function applySelection(ctx, selectedIds) {
  const { extensions: catalog } = loadCatalog(ctx);
  const wanted = new Set(selectedIds || []);
  const state = readState(ctx) || { extensions: {} };
  const records = { ...state.extensions };
  const result = { installed: [], adopted: [], reenabled: [], disabled: [], failed: [] };

  await fs.promises.mkdir(ctx.destDir, { recursive: true });

  for (const entry of catalog) {
    const destPath = path.join(ctx.destDir, entry.file);
    const seedPath = path.join(ctx.seedDir, entry.file);
    const rec = { ...(records[entry.id] || blankRecord(entry.file)), file: entry.file, updatePending: false };

    try {
      if (wanted.has(entry.id)) {
        rec.selected = true;
        if (!exists(destPath)) {
          // Prefer restoring the user's own disabled copy over the bundle.
          const off = restorableDisabled(ctx.destDir, entry.file);
          if (off) {
            fs.renameSync(path.join(ctx.destDir, off), destPath);
            result.reenabled.push(entry.id);
          } else if (exists(seedPath)) {
            deployFile(ctx, entry);
            result.installed.push(entry.id);
          } else {
            ctx.dbg(`seed file missing for ${entry.id} — cannot install`);
            result.failed.push(entry.id);
            continue;
          }
        } else {
          result.adopted.push(entry.id);
        }
        const destHash = hashFile(destPath);
        const seedHash = hashFile(seedPath);
        // Only claim authorship when the content really is the bundle's.
        rec.deployedHash = destHash !== null && destHash === seedHash ? destHash : null;
        rec.deployedAt = new Date().toISOString();
      } else {
        rec.selected = false;
        if (exists(destPath)) {
          const off = freeDisabledPath(ctx.destDir, entry.file);
          fs.renameSync(destPath, off);
          result.disabled.push(entry.id);
          ctx.dbg(`disabled extension ${entry.file} -> ${path.basename(off)}`);
        }
        rec.deployedHash = null;
        rec.deployedAt = null;
      }
    } catch (e) {
      ctx.dbg(`applySelection failed for ${entry.id}: ${(e && e.message) || e}`);
      result.failed.push(entry.id);
    }

    records[entry.id] = rec;
  }

  const needsDeps = catalog.some((e) => wanted.has(e.id) && e.deps.length > 0);
  try {
    await ensureDeps(ctx, needsDeps);
  } catch (e) {
    ctx.dbg(`ensureDeps failed: ${(e && e.message) || e}`);
  }

  writeState(ctx, { ...state, extensions: records });
  ctx.dbg(
    `applySelection done; installed=${result.installed.length} reenabled=${result.reenabled.length} ` +
      `adopted=${result.adopted.length} disabled=${result.disabled.length} failed=${result.failed.length}`
  );
  return result;
}

// ---------------------------------------------------------------------------
// Explicit restore (the ONLY path that overwrites a user-edited extension)
// ---------------------------------------------------------------------------

/**
 * Overwrite the deployed copy with the bundled one, backing the user's version
 * up to `<file>.userbak.<yyyymmddhhmmss>` first when it differs.
 * @param {ExtCtx} ctx
 * @param {string} id
 */
function restoreFromBundle(ctx, id) {
  const { extensions: catalog } = loadCatalog(ctx);
  const entry = catalog.find((e) => e.id === id);
  if (!entry) return { ok: false, error: `未知扩展：${id}` };

  const seedPath = path.join(ctx.seedDir, entry.file);
  const destPath = path.join(ctx.destDir, entry.file);
  if (!exists(seedPath)) return { ok: false, error: `内置版本缺失：${entry.file}` };

  try {
    let backup = null;
    const destHash = hashFile(destPath);
    if (destHash !== null && destHash !== hashFile(seedPath)) {
      backup = `${entry.file}.userbak.${stamp()}`;
      fs.copyFileSync(destPath, path.join(ctx.destDir, backup));
    }
    const deployedHash = deployFile(ctx, entry);

    const state = readState(ctx) || { extensions: {} };
    const records = { ...state.extensions };
    records[id] = {
      ...(records[id] || blankRecord(entry.file)),
      file: entry.file,
      selected: true,
      deployedHash,
      deployedAt: new Date().toISOString(),
      updatePending: false,
    };
    writeState(ctx, { ...state, extensions: records });
    ctx.dbg(`restored ${entry.file} from bundle${backup ? ` (user copy kept as ${backup})` : ""}`);
    return { ok: true, backup };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Launch-time sync (non-interactive, non-destructive)
// ---------------------------------------------------------------------------

/**
 * Runs on every boot once a selection exists. It may only:
 *   - install a selected extension that is missing (unless the user disabled it
 *     by hand, in which case the rename is respected),
 *   - auto-install an extension a NEWER app version added, if it is default-on
 *     and the user has never seen it,
 *   - update a deployed file that is still byte-identical to what we wrote.
 * A user-edited file is left alone and flagged `updatePending` for the picker.
 * @param {ExtCtx} ctx
 * @returns {Promise<{needsPicker: boolean} & Object>}
 */
async function syncOnLaunch(ctx) {
  const state = readState(ctx);
  if (!state) return { needsPicker: true };
  if (!exists(ctx.seedDir)) {
    ctx.dbg(`extensions seed missing at ${ctx.seedDir} — skipping extension sync`);
    return { needsPicker: false, skipped: true };
  }

  const { extensions: catalog } = loadCatalog(ctx);
  const records = { ...state.extensions };
  const result = { needsPicker: false, installed: [], updated: [], kept: [], added: [] };

  await fs.promises.mkdir(ctx.destDir, { recursive: true });

  for (const entry of catalog) {
    const seedPath = path.join(ctx.seedDir, entry.file);
    const destPath = path.join(ctx.destDir, entry.file);
    const seedHash = hashFile(seedPath);
    if (seedHash === null) continue;

    let rec = records[entry.id];
    if (!rec) {
      // New in this app version: opt the user in only when it is default-on.
      rec = { ...blankRecord(entry.file), selected: entry.default };
      if (entry.default) result.added.push(entry.id);
    }
    if (rec.selected !== true) {
      records[entry.id] = rec;
      continue;
    }

    try {
      const destHash = hashFile(destPath);
      if (destHash === null) {
        // Respect a hand-renamed `.disabled` copy — the user turned it off.
        const off = disabledVariant(ctx.destDir, entry.file);
        if (off) {
          ctx.dbg(`${entry.file} disabled by hand (${off}) — leaving it off`);
        } else {
          rec.deployedHash = deployFile(ctx, entry);
          rec.deployedAt = new Date().toISOString();
          rec.updatePending = false;
          result.installed.push(entry.id);
        }
      } else if (destHash === seedHash) {
        rec.deployedHash = destHash;
        rec.updatePending = false;
      } else if (rec.deployedHash && destHash === rec.deployedHash) {
        // Untouched since we wrote it -> safe to carry the app update through.
        rec.deployedHash = deployFile(ctx, entry);
        rec.deployedAt = new Date().toISOString();
        rec.updatePending = false;
        result.updated.push(entry.id);
      } else {
        // User-edited: hands off. Surface it in the picker instead.
        rec.updatePending = true;
        result.kept.push(entry.id);
      }
    } catch (e) {
      ctx.dbg(`sync failed for ${entry.id}: ${(e && e.message) || e}`);
    }

    records[entry.id] = rec;
  }

  const needsDeps = catalog.some((e) => records[e.id] && records[e.id].selected && e.deps.length > 0);
  try {
    await ensureDeps(ctx, needsDeps);
  } catch (e) {
    ctx.dbg(`ensureDeps failed: ${(e && e.message) || e}`);
  }

  writeState(ctx, { ...state, extensions: records });
  ctx.dbg(
    `syncOnLaunch done; installed=${result.installed.length} updated=${result.updated.length} ` +
      `kept-user-edits=${result.kept.length} new-defaults=${result.added.length}`
  );
  return result;
}

module.exports = {
  loadCatalog,
  readState,
  hasSelection,
  computeStatus,
  applySelection,
  restoreFromBundle,
  syncOnLaunch,
};
