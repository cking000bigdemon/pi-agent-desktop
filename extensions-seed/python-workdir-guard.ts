/**
 * Python Workdir Guard for pi
 *
 * Global extension for Python-oriented workspaces:
 * 1. On first use of a working directory, create a basic AGENTS.md and a
 *    project-local Python virtual environment (.venv).
 *    This is attempted on session_start and also lazily before the first
 *    agent turn, so SDK integrations that load extension hooks but do not
 *    emit session_start still initialize correctly.
 * 2. Enforce project-local virtualenv usage for Python scripts and dependency
 *    installation, including Python-based skills under .agents/skills or
 *    .pi/skills. Global pip/global Python execution is blocked.
 *
 * Install:
 *   Save as ~/.pi/agent/extensions/python-workdir-guard.ts and run /reload.
 *
 * Environment variables:
 *   PI_PY_GUARD_VENV_DIR=.venv          Virtualenv directory name/path.
 *   PI_PY_GUARD_CREATE_AGENTS=0         Disable automatic AGENTS.md creation.
 *   PI_PY_GUARD_CREATE_VENV=0           Disable automatic virtualenv creation.
 *   PI_PY_GUARD_BLOCK_GLOBAL_PYTHON=0   Allow global python script execution.
 *   PI_PY_GUARD_BLOCK_GLOBAL_TOOLS=0    Allow global pytest/ruff/etc entrypoints.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const DEFAULT_VENV_DIR = ".venv";
const AGENTS_FILE = "AGENTS.md";
const CUSTOM_MESSAGE_TYPE = "python-workdir-guard";

const PYTHON_RELATED_FILENAMES = new Set([
  "requirements.txt",
  "requirements-dev.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "tox.ini",
  "poetry.lock",
  "pdm.lock",
]);

function isFalsey(value: string | undefined): boolean {
  return value === "0" || value?.toLowerCase() === "false" || value?.toLowerCase() === "no";
}

function venvDirName(): string {
  return process.env.PI_PY_GUARD_VENV_DIR || DEFAULT_VENV_DIR;
}

function normalizeSlashes(input: string): string {
  return input.replace(/\\/g, "/");
}

function quoteForDisplay(input: string): string {
  return input.includes(" ") ? `"${input}"` : input;
}

function getVenvPath(cwd: string): string {
  const configured = venvDirName();
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

function getVenvPythonDisplay(cwd: string): { posix: string; windows: string } {
  const dir = venvDirName();
  const relative = path.isAbsolute(dir) ? path.relative(cwd, dir) || dir : dir;
  return {
    posix: `${normalizeSlashes(relative)}/bin/python`,
    windows: `${relative}\\Scripts\\python.exe`,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isVenvPresent(cwd: string): Promise<boolean> {
  const venv = getVenvPath(cwd);
  const pyvenvCfg = path.join(venv, "pyvenv.cfg");
  if (await exists(pyvenvCfg)) return true;

  const posixPython = path.join(venv, "bin", process.platform === "win32" ? "python.exe" : "python");
  const windowsPython = path.join(venv, "Scripts", "python.exe");
  return (await exists(posixPython)) || (await exists(windowsPython));
}

function buildAgentsContent(cwd: string): string {
  const projectName = path.basename(cwd) || "project";
  const venv = venvDirName();
  return `# AGENTS.md

Project instructions for pi coding agents working in **${projectName}**.

## Baseline
- Keep changes focused and minimal.
- Prefer reading existing files before editing.
- Do not commit secrets, API keys, tokens, virtual environments, caches, or generated logs.

## Python environment policy
- Use the project-local Python virtual environment at \`${venv}\` for all Python work in this working directory.
- If \`${venv}\` is missing, create it before Python work: \`python -m venv ${venv}\`.
- Run Python through the virtualenv interpreter:
  - POSIX/Git Bash: \`${venv}/bin/python\`
  - Windows PowerShell/CMD: \`${venv}\\Scripts\\python.exe\`
- Install dependencies only into this virtualenv, for example:
  - POSIX/Git Bash: \`${venv}/bin/python -m pip install <package>\`
  - Windows PowerShell/CMD: \`${venv}\\Scripts\\python.exe -m pip install <package>\`
- Do **not** use global installs: no \`pip install\`, \`pip install --user\`, \`sudo pip install\`, global \`python -m pip install\`, or \`uv pip install --system\`.
- For Python scripts inside skills, including \`.agents/skills/**\` and \`.pi/skills/**\`, use this same project virtualenv unless the user explicitly asks for an isolated per-skill virtualenv.
`;
}

async function createAgentsIfMissing(cwd: string): Promise<boolean> {
  if (isFalsey(process.env.PI_PY_GUARD_CREATE_AGENTS)) return false;

  const agentsPath = path.join(cwd, AGENTS_FILE);
  if (await exists(agentsPath)) return false;

  await fsp.writeFile(agentsPath, buildAgentsContent(cwd), "utf8");
  return true;
}

async function createVenvIfMissing(cwd: string): Promise<{ created: boolean; error?: string }> {
  if (isFalsey(process.env.PI_PY_GUARD_CREATE_VENV)) return { created: false };
  if (await isVenvPresent(cwd)) return { created: false };

  const venv = getVenvPath(cwd);
  await fsp.mkdir(path.dirname(venv), { recursive: true });

  // PI_PY_GUARD_PYTHON (set by the desktop app to the BUNDLED interpreter) is
  // tried first so a fresh machine with no system Python still gets a .venv —
  // zero system-Python dependency.
  const bundled = process.env.PI_PY_GUARD_PYTHON;
  const fallbacks: Array<{ command: string; args: string[] }> = process.platform === "win32"
    ? [
        { command: "py", args: ["-3", "-m", "venv", venv] },
        { command: "python", args: ["-m", "venv", venv] },
        { command: "python3", args: ["-m", "venv", venv] },
      ]
    : [
        { command: "python3", args: ["-m", "venv", venv] },
        { command: "python", args: ["-m", "venv", venv] },
      ];
  const candidates = bundled
    ? [{ command: bundled, args: ["-m", "venv", venv] }, ...fallbacks]
    : fallbacks;

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate.command, candidate.args, {
        cwd,
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      return { created: true };
    } catch (error) {
      errors.push(`${candidate.command}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    created: false,
    error: `Failed to create ${venvDirName()} with available Python launchers. ${errors.join(" | ")}`,
  };
}

async function ensureWorkspace(cwd: string): Promise<{ agentsCreated: boolean; venvCreated: boolean; venvError?: string }> {
  const agentsCreated = await createAgentsIfMissing(cwd);
  const venv = await createVenvIfMissing(cwd);
  return { agentsCreated, venvCreated: venv.created, venvError: venv.error };
}

function resolveToolPath(rawPath: unknown, cwd: string): string | undefined {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return undefined;
  const cleaned = rawPath.trim().replace(/^@/, "").replace(/^['\"]|['\"]$/g, "");
  return path.resolve(cwd, cleaned);
}

function isPythonRelatedPath(absolutePath: string): boolean {
  const normalized = normalizeSlashes(absolutePath).toLowerCase();
  const base = path.basename(absolutePath).toLowerCase();

  return (
    normalized.endsWith(".py") ||
    normalized.endsWith(".pyw") ||
    normalized.includes("/.agents/skills/") ||
    normalized.includes("/.pi/skills/") ||
    PYTHON_RELATED_FILENAMES.has(base)
  );
}

function escapedVenvName(): string {
  const venv = normalizeSlashes(venvDirName()).toLowerCase().replace(/^\.\//, "");
  return venv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split a command into shell segments so each invocation is judged on its own.
// Includes command-substitution / backtick boundaries so a wrapped
// `pip install` cannot hide behind an outer harmless token.
const SEGMENT_SEP = /&&|\|\||;|\||&|`|\$\(|\)|\n/g;

// Drop shell comments before analysis so a venv mention parked in a trailing
// `# ...` comment can no longer disable enforcement for the live command.
function stripBashComments(command: string): string {
  return command
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

function splitBashSegments(command: string): string[] {
  return stripBashComments(command).split(SEGMENT_SEP);
}

function stripCommandWrappers(segment: string): string {
  return segment.replace(/^(?:sudo\s+|command\s+|env\s+\S+=\S+\s+|time\s+)+/, "");
}

// A segment that activates the project venv; its effect carries to later
// sequential segments (`source .venv/bin/activate && pip install ...`).
function isVenvActivation(segment: string): boolean {
  const s = normalizeSlashes(segment).toLowerCase();
  const v = escapedVenvName();
  return (
    new RegExp(`(?:^|\\s)(?:source\\s+|\\.\\s+)(?:\\./)?${v}/bin/activate(?:\\s|$)`).test(s) ||
    new RegExp(`(?:^|\\s)(?:\\./)?${v}/scripts/activate(?:\\.ps1|\\.bat)?(?:\\s|$)`).test(s)
  );
}

// A segment whose interpreter IS the project venv python, so it is compliant.
// Scoped to a single segment so an unrelated mention elsewhere cannot exempt it.
function segmentUsesVenvInterpreter(segment: string): boolean {
  const s = normalizeSlashes(segment).toLowerCase();
  const v = escapedVenvName();
  return (
    new RegExp(`(?:^|[\\s;&|()])(?:\\./)?${v}/bin/python(?:[0-9.]*)?(?:\\s|$)`).test(s) ||
    new RegExp(`(?:^|[\\s;&|()])(?:\\./)?${v}/scripts/python(?:\\.exe)?(?:\\s|$)`).test(s)
  );
}

// The app-bundled interpreter (set via PI_PY_GUARD_BUNDLED_PYTHON and surfaced
// to skills as $PI_BUNDLED_PYTHON). It carries heavy, app-managed skill deps
// (ppt-master) that intentionally do NOT belong in a user's project .venv. A
// segment whose interpreter IS this trusted bundled python is compliant — the
// guard still blocks arbitrary global python, just not the app's own runtime.
function bundledPythonTokens(): string[] {
  const toks = ["$pi_bundled_python", "${pi_bundled_python}"];
  const p = process.env.PI_PY_GUARD_BUNDLED_PYTHON;
  if (p) toks.push(normalizeSlashes(p).toLowerCase());
  return toks;
}

function segmentUsesBundledPython(segment: string): boolean {
  const s = normalizeSlashes(segment).toLowerCase();
  // Interpreter must be in command position (optionally quoted), so an unrelated
  // mention elsewhere in the segment cannot exempt it.
  const head = stripCommandWrappers(s.trim()).replace(/^["']/, "");
  return bundledPythonTokens().some((t) => head.startsWith(t));
}

function commandHasPipInstall(segment: string): boolean {
  const s = normalizeSlashes(segment).toLowerCase();
  return (
    /(?:^|[\s;&|()])(?:sudo\s+)?pip(?:3(?:\.\d+)?)?\s+install\b/.test(s) ||
    /(?:^|[\s;&|()])(?:sudo\s+)?python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install\b/.test(s) ||
    /(?:^|[\s;&|()])py\s+(?:-3(?:\.\d+)?\s+)?-m\s+pip\s+install\b/.test(s) ||
    /(?:^|[\s;&|()])pipx\s+install\b/.test(s)
  );
}

function commandHasExplicitGlobalInstall(segment: string): boolean {
  const s = normalizeSlashes(segment).toLowerCase();
  return (
    /(?:^|[\s;&|()])uv\s+pip\s+install\b[^\n;&|]*\s--system\b/.test(s) ||
    /(?:^|[\s;&|()])pip(?:3(?:\.\d+)?)?\s+install\b[^\n;&|]*\s--user\b/.test(s) ||
    /(?:^|[\s;&|()])python(?:3(?:\.\d+)?)?\s+-m\s+pip\s+install\b[^\n;&|]*\s--user\b/.test(s)
  );
}

// Dependency managers that target a global/base or a separate (non-.venv)
// environment, so the project-venv policy is not silently bypassed by them.
function commandHasManagedInstall(segment: string): boolean {
  const s = normalizeSlashes(segment).toLowerCase();
  return (
    /(?:^|[\s()])(?:sudo\s+)?(?:conda|mamba|micromamba)\s+install\b/.test(s) ||
    /(?:^|[\s()])poetry\s+(?:add|install|update|sync)\b/.test(s) ||
    /(?:^|[\s()])pipenv\s+(?:install|sync|update)\b/.test(s) ||
    /(?:^|[\s()])pdm\s+(?:add|install|sync|update)\b/.test(s) ||
    /(?:^|[\s()])uv\s+(?:add|sync)\b/.test(s)
  );
}

function commandRunsPythonScriptGlobally(segment: string): boolean {
  if (isFalsey(process.env.PI_PY_GUARD_BLOCK_GLOBAL_PYTHON)) return false;
  const s = normalizeSlashes(segment).toLowerCase();
  const head = stripCommandWrappers(s.trim());
  // (a) global python running a .py file
  if (/(?:^|[\s()])(?:python(?:3(?:\.\d+)?)?|py(?:\s+-3(?:\.\d+)?)?)\s+(?!-m\s+venv\b)(?!-m\s+pip\b)(?!-c\b)(?:"[^"]+\.pyw?"|'[^']+\.pyw?'|[^\s]+\.pyw?)\b/.test(s)) return true;
  // (b) heredoc fed to global python: python <<EOF / python3 <<-'PY'
  if (/(?:^|[\s()])(?:python(?:3(?:\.\d+)?)?|py)\b[^\n]*<<-?\s*['"]?[\w-]/.test(s)) return true;
  // (c) bare interpreter reading a REPL / piped stdin program: python | python3 | py [-]
  if (/^(?:python(?:3(?:\.\d+)?)?|py(?:\s+-3(?:\.\d+)?)?)\s*(?:-\s*)?$/.test(head)) return true;
  // (d) direct execution of a .py script via shebang: ./script.py  path/to/x.py
  if (/^(?:\.?\/)?(?:[^\s]*\/)?[^\s/]+\.pyw?(?:\s|$)/.test(head)) return true;
  return false;
}

const PYTHON_TOOLS = "pytest|ruff|mypy|black|flake8|isort|pylint|pyright|coverage|tox|nox";

function commandRunsPythonToolGlobally(segment: string): boolean {
  if (isFalsey(process.env.PI_PY_GUARD_BLOCK_GLOBAL_TOOLS)) return false;
  const s = normalizeSlashes(segment).toLowerCase();
  const head = stripCommandWrappers(s.trim());
  const firstToken = head.split(/\s+/)[0] ?? "";
  // Bare tool name in command position. A path such as .venv/bin/pytest contains
  // a "/" and is intentionally NOT matched, so venv-local tools stay allowed.
  if (new RegExp(`^(?:${PYTHON_TOOLS})$`).test(firstToken)) return true;
  // Tool launched through a global python module entrypoint (python -m pytest).
  if (new RegExp(`^(?:python(?:3(?:\\.\\d+)?)?|py)\\s+-m\\s+(?:${PYTHON_TOOLS})\\b`).test(head)) return true;
  return false;
}

function getBashViolation(command: string, cwd: string): string | undefined {
  const venvDisplay = getVenvPythonDisplay(cwd);
  let venvActive = false;

  for (const raw of splitBashSegments(command)) {
    const segment = raw.trim();
    if (!segment) continue;

    if (isVenvActivation(segment)) {
      venvActive = true;
      continue;
    }

    // --user / uv --system are wrong even inside the venv: check before exemption.
    if (commandHasExplicitGlobalInstall(segment)) {
      return `Global/user Python installs are not allowed in this workspace. Use ${quoteForDisplay(venvDisplay.posix)} -m pip install <package> or ${quoteForDisplay(venvDisplay.windows)} -m pip install <package>.`;
    }

    // A segment is compliant if the venv is active, it invokes the venv
    // interpreter, or it invokes the trusted app-bundled interpreter (which
    // carries app-managed skill deps like ppt-master). Exemption is scoped to
    // THIS segment.
    if (venvActive || segmentUsesVenvInterpreter(segment) || segmentUsesBundledPython(segment)) continue;

    if (commandHasPipInstall(segment)) {
      return `Python dependencies must be installed into the project virtualenv (${venvDirName()}), not globally. Use ${quoteForDisplay(venvDisplay.posix)} -m pip install <package> or ${quoteForDisplay(venvDisplay.windows)} -m pip install <package>.`;
    }

    if (commandHasManagedInstall(segment)) {
      return `Dependency managers that target a global/base or separate environment (conda/mamba/poetry/pipenv/pdm/uv add|sync) are not allowed in this workspace. Install into ${venvDirName()} with ${quoteForDisplay(venvDisplay.posix)} -m pip install <package> or ${quoteForDisplay(venvDisplay.windows)} -m pip install <package>.`;
    }

    if (commandRunsPythonScriptGlobally(segment)) {
      const bundledHint = process.env.PI_PY_GUARD_BUNDLED_PYTHON
        ? ` App-bundled skills (e.g. ppt-master) may instead use the bundled interpreter "$PI_BUNDLED_PYTHON script.py".`
        : "";
      return `Python in this workspace must run through the project virtualenv. Use ${quoteForDisplay(venvDisplay.posix)} script.py or ${quoteForDisplay(venvDisplay.windows)} script.py (activate ${venvDirName()} first for piped/heredoc input).${bundledHint}`;
    }

    if (commandRunsPythonToolGlobally(segment)) {
      return `Python tool entrypoints must run through the project virtualenv. Use ${quoteForDisplay(venvDisplay.posix)} -m pytest/ruff/mypy/etc., or activate ${venvDirName()} first.`;
    }
  }

  return undefined;
}

function workspacePolicyPrompt(cwd: string): string {
  const venvDisplay = getVenvPythonDisplay(cwd);
  return `Python workspace policy enforced by python-workdir-guard:
- This working directory must use the project-local virtual environment at ${venvDirName()}.
- Before creating or running Python scripts, ensure ${venvDirName()} exists.
- Install dependencies only with the virtualenv Python, e.g. ${venvDisplay.posix} -m pip install <package> or ${venvDisplay.windows} -m pip install <package>.
- Never use global pip installs, pip --user, sudo pip, pipx install, global python -m pip install, or uv pip install --system.
- Python-based skills under .agents/skills or .pi/skills must also use this workspace virtualenv unless the user explicitly requests an isolated per-skill virtualenv.${
    process.env.PI_PY_GUARD_BUNDLED_PYTHON
      ? `\n- App-bundled skills with pre-installed dependencies (e.g. ppt-master) run on the trusted bundled interpreter: invoke their scripts as \`$PI_BUNDLED_PYTHON <script>\` (this is allowed and needs no virtualenv or pip install).`
      : ""
  }`;
}

export default function (pi: ExtensionAPI) {
  const ensurePromises = new Map<string, Promise<Awaited<ReturnType<typeof ensureWorkspace>>>>();
  const notifiedKeys = new Set<string>();

  async function ensureWorkspaceForContext(ctx: ExtensionContext): Promise<Awaited<ReturnType<typeof ensureWorkspace>>> {
    let promise = ensurePromises.get(ctx.cwd);
    if (!promise) {
      promise = ensureWorkspace(ctx.cwd).catch((error) => ({
        agentsCreated: false,
        venvCreated: false,
        venvError: error instanceof Error ? error.message : String(error),
      }));
      ensurePromises.set(ctx.cwd, promise);
    }

    const result = await promise;

    // Do not memoize a failed venv creation: a later turn (e.g. once Python is
    // available, or after the user creates the venv) must be able to retry.
    // Successful results stay cached. The identity check avoids dropping a
    // newer in-flight promise created by a concurrent caller.
    if (result.venvError && ensurePromises.get(ctx.cwd) === promise) {
      ensurePromises.delete(ctx.cwd);
    }

    const messages: string[] = [];

    if (result.agentsCreated) messages.push(`created ${AGENTS_FILE}`);
    if (result.venvCreated) messages.push(`created ${venvDirName()}`);

    const notifyKey = `${ctx.cwd}\0${messages.join(",")}\0${result.venvError ?? ""}`;
    if (!notifiedKeys.has(notifyKey)) {
      notifiedKeys.add(notifyKey);

      if (messages.length > 0) {
        ctx.ui.notify(`Python workdir initialized: ${messages.join(", ")}`, "info");
        pi.sendMessage({
          customType: CUSTOM_MESSAGE_TYPE,
          content: `Python workdir initialized: ${messages.join(", ")}.`,
          display: true,
          details: result,
        }, { deliverAs: "nextTurn" });
      }

      if (result.venvError) {
        ctx.ui.notify(result.venvError, "warning");
      }
    }

    return result;
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureWorkspaceForContext(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Some SDK integrations create/bind enough extension runtime for prompt hooks
    // but skip or miss the session_start lifecycle event. Keep initialization
    // idempotent here so a fresh SDK-backed session still gets AGENTS.md + .venv
    // before the agent starts acting on the user's first prompt.
    await ensureWorkspaceForContext(ctx);

    return {
      systemPrompt: `${event.systemPrompt}\n\n${workspacePolicyPrompt(ctx.cwd)}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("bash", event)) {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const violation = getBashViolation(command, ctx.cwd);
      if (violation) {
        return { block: true, reason: violation };
      }
    }

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const absolutePath = resolveToolPath(event.input.path, ctx.cwd);
      if (!absolutePath || !isPythonRelatedPath(absolutePath)) return;

      const result = await ensureWorkspaceForContext(ctx);
      // Presence is authoritative. A venv created manually after an earlier
      // failed auto-create must unblock writes, so never gate on a stale
      // venvError once the venv actually exists.
      if (await isVenvPresent(ctx.cwd)) return;

      return {
        block: true,
        reason: `Refusing to create or modify Python-related files before the project virtualenv is available. ${result.venvError ?? `Create it with: python -m venv ${venvDirName()}`}`,
      };
    }
  });

  pi.registerCommand("python-workdir-guard", {
    description: "Show Python workdir guard status and policy",
    handler: async (_args, ctx) => {
      await ensureWorkspaceForContext(ctx);
      const venvPresent = await isVenvPresent(ctx.cwd);
      const agentsPresent = await exists(path.join(ctx.cwd, AGENTS_FILE));
      const message = [
        `AGENTS.md: ${agentsPresent ? "present" : "missing"}`,
        `${venvDirName()}: ${venvPresent ? "present" : "missing"}`,
        "",
        workspacePolicyPrompt(ctx.cwd),
      ].join("\n");
      ctx.ui.notify(message, venvPresent && agentsPresent ? "info" : "warning");
    },
  });
}
