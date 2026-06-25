/**
 * Skill Shell Injection for pi  —  动态上下文注入（!`cmd` / ```! ... ```）
 *
 * Pi 原生不支持 Claude Code 那种「在 SKILL.md 被送进模型之前，先在 shell 里执行
 * 内嵌命令、把 stdout 内联替换进内容」的动态上下文注入。Pi 的 prompt-template 只有
 * $1/$ARGUMENTS 参数替换，skill 是纯静态 markdown 渐进式披露。本扩展把这个能力补上。
 *
 * 蓝本（Claude Code 源码）：
 *   src/utils/promptShellExecution.ts  →  executeShellCommandsInPrompt()
 *   src/skills/loadSkillsDir.ts:375     →  在 skill 内容加载时调用、送模型前完成替换
 * 本文件忠实移植其两条正则、预过滤、函数式替换（避免 $& / $` 被解释）、${SKILL_DIR}
 * 预替换、[stderr]/[Error] 错误格式，并按 Claude Code 的安全约束（远程/不受信内容绝不
 * 执行）映射到 Pi 的扩展生命周期。
 *
 * 两条语法（与 Claude Code 完全一致）：
 *   - 行内：   !`git branch --show-current`
 *   - 代码块： ```!
 *              git log --oneline -5
 *              ```
 *   行内 ! 必须位于行首或空白之后（lookbehind），避免误伤 `!!`、$! 等。
 *
 * 在 Pi 中「skill 运行」的两条真实路径，本扩展都覆盖：
 *   1) 模型用 `read` 工具加载 SKILL.md（Pi 文档里的标准渐进式披露路径）
 *      → 钩 `tool_result`，在结果送回模型前对该文件做注入替换。
 *   2) 用户显式直调
 *      → 提供 `/skillx <name> [args]` 命令，定位并加载该 skill、完成注入后注入会话，
 *        与 Claude Code `/pr-create` 式直调对标。args 按 Pi 约定追加为 `User: <args>`。
 *
 * 安全模型（对齐蓝本的「MCP 远程 skill 绝不执行」）：
 *   - 只对「受信 skill/prompt 根目录」下的文件执行：全局 ~/.pi/agent/{skills,prompts}、
 *     ~/.agents/skills，以及 settings.json 里登记的 skills/prompts 路径。
 *   - 项目本地根（.pi/skills、.agents/skills、.pi/prompts）仅在 ctx.isProjectTrusted()
 *     为真时才执行。
 *   - 任意会话消息 / 网页内容 / 模型输出一律不碰（provenance 丢失即不执行）。
 *   - 会话级 memo：同一条命令一个会话只执行一次（幂等，保护 git commit 等有副作用命令）。
 *   - 单次替换、不对命令输出二次扫描（与蓝本一致，杜绝注入再注入）。
 *
 * 安装：
 *   随 pi-web-desktop 打包，启动时由 ensureBundledExtensions() 同步到
 *   ~/.pi/agent/extensions/skill-shell-injection.ts。手动安装则复制到该目录后 /reload。
 *
 * 环境变量：
 *   PI_SKILL_SHELL_INJECTION   设为 0/false/no/off 时整体禁用（对标 disableSkillShellExecution）。默认开。
 *   PI_SKILL_SHELL_DEFAULT     frontmatter 未指定 shell 时的默认值：bash | powershell。
 *                              不设则按平台探测：Windows → powershell，mac/Linux → bash。设此变量可强制覆盖。
 *   PI_SKILL_SHELL_TIMEOUT     单条命令超时(ms)。默认 30000。
 *   PI_SKILL_SHELL_MAX_OUTPUT  单条命令输出字符上限，超出截断。默认 30000。
 *   PI_SKILL_SHELL_CONFIRM     设为 1/true 时，每条「首次出现」的命令执行前弹确认（需 UI）。默认关。
 *   PI_SKILL_SHELL_BASH        bash 可执行路径。默认 "bash"。
 *   PI_SKILL_SHELL_POWERSHELL  powershell 可执行路径。默认 win32: powershell.exe，其它: pwsh。
 *   PI_SKILL_SHELL_EXTRA_ROOTS 追加受信根目录，路径分隔符分隔（win: ;  其它: :）。
 *   PI_SKILL_SHELL_DEBUG       设为 1/true 时输出调试 notify。默认关。
 *
 * 无外部依赖：仅用 node 内置模块。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 正则：直接移植自 promptShellExecution.ts（保持字节级一致）
// ---------------------------------------------------------------------------

// 代码块： ```! command ```
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;

// 行内： !`command` —— lookbehind 要求 ! 前是行首或空白，避免误伤 `!!`、相邻 span、$! 等
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

type ShellKind = "bash" | "powershell";

// ---------------------------------------------------------------------------
// 配置（env）
// ---------------------------------------------------------------------------

function isFalsey(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "0" || s === "false" || s === "no" || s === "off";
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function injectionEnabled(): boolean {
  return !isFalsey(process.env.PI_SKILL_SHELL_INJECTION);
}

function defaultShell(): ShellKind {
  // 显式 env 覆盖优先；否则按平台探测：Windows → powershell，mac/Linux → bash
  const forced = (process.env.PI_SKILL_SHELL_DEFAULT || "").toLowerCase();
  if (forced === "powershell" || forced === "bash") return forced;
  return process.platform === "win32" ? "powershell" : "bash";
}

function timeoutMs(): number {
  const n = Number.parseInt(process.env.PI_SKILL_SHELL_TIMEOUT || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

function maxOutput(): number {
  const n = Number.parseInt(process.env.PI_SKILL_SHELL_MAX_OUTPUT || "", 10);
  return Number.isFinite(n) && n > 0 ? n : 30_000;
}

function debugEnabled(): boolean {
  return isTruthy(process.env.PI_SKILL_SHELL_DEBUG);
}

function bashBin(): string {
  return process.env.PI_SKILL_SHELL_BASH || "bash";
}

function powershellBin(): string {
  return process.env.PI_SKILL_SHELL_POWERSHELL || (process.platform === "win32" ? "powershell.exe" : "pwsh");
}

// ---------------------------------------------------------------------------
// 命令执行（替代蓝本里的 BashTool.call —— 扩展运行在完整 Node，用 spawn）
// ---------------------------------------------------------------------------

type ShellResult = { stdout: string; stderr: string; code: number | null; error?: string };

function runShell(command: string, shell: ShellKind, cwd: string, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const bin = shell === "powershell" ? powershellBin() : bashBin();
    const args =
      shell === "powershell" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd,
        // PYTHONIOENCODING 显式 utf-8：Windows 下子进程里的 python 输出中文不乱码
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      });
    } catch (e) {
      resolve({ stdout: "", stderr: "", code: null, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ stdout, stderr, code: null, error: `command timed out after ${timeoutMs()}ms` });
    }, timeoutMs());

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      finish({ stdout, stderr, code: null, error: "command interrupted" });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish({ stdout, stderr, code: null, error: e.message }));
    child.on("close", (code) => finish({ stdout, stderr, code }));
  });
}

// 输出格式化：移植蓝本 formatBashOutput / formatBashError 的语义
function formatResult(r: ShellResult): string {
  if (r.error) return `[Error: ${r.error}]`;
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push(`[stderr: ${r.stderr.trim()}]`);
  // 退出码非 0 但有输出：仍返回输出（贴近 Claude Code «失败也带 stdout/stderr»）
  if (parts.length === 0 && r.code !== 0 && r.code !== null) parts.push(`[exit ${r.code}]`);
  let out = parts.join("\n");
  const cap = maxOutput();
  if (out.length > cap) out = `${out.slice(0, cap)}\n…[truncated ${out.length - cap} chars]`;
  return out;
}

// ---------------------------------------------------------------------------
// 注入引擎：移植 executeShellCommandsInPrompt 的扫描/替换流程
// ---------------------------------------------------------------------------

type ExecFn = (command: string, shell: ShellKind, cwd: string) => Promise<string>;
type ConfirmFn = (command: string) => Promise<boolean>;

interface InjectOptions {
  shell: ShellKind;
  cwd: string; // 命令执行目录（= skillDir）
  skillDir: string; // 用于 ${SKILL_DIR} / ${CLAUDE_SKILL_DIR} 替换
  exec: ExecFn;
  confirm?: ConfirmFn;
}

/** 文本里是否存在任一注入标记（cheap pre-check，对应蓝本的 includes('!`') 门控）。 */
function hasInjectionMarker(text: string): boolean {
  return text.includes("!`") || /```!/.test(text);
}

async function executeShellInjection(text: string, opts: InjectOptions): Promise<string> {
  // ${SKILL_DIR}/${CLAUDE_SKILL_DIR} 预替换：win32 下反斜杠转正斜杠，避免被 shell 当转义
  const skillDir = process.platform === "win32" ? opts.skillDir.replace(/\\/g, "/") : opts.skillDir;
  let working = text.replace(/\$\{(?:CLAUDE_SKILL_DIR|SKILL_DIR)\}/g, skillDir);

  // BLOCK_PATTERN 总扫描；INLINE 仅在出现 !` 时才扫（lookbehind 昂贵，对应蓝本注释）
  const blockMatches = [...working.matchAll(BLOCK_PATTERN)];
  const inlineMatches = working.includes("!`") ? [...working.matchAll(INLINE_PATTERN)] : [];
  const matches = [...blockMatches, ...inlineMatches];
  if (matches.length === 0) return working;

  // 收集「整段匹配文本 → 替换文本」，命令去重由 exec 层 memo 负责
  const replacements: Array<{ pattern: string; output: string }> = [];
  await Promise.all(
    matches.map(async (m) => {
      const pattern = m[0];
      const command = m[1]?.trim();
      if (!command) return;
      if (opts.confirm && !(await opts.confirm(command))) {
        replacements.push({ pattern, output: "[blocked: shell command not approved]" });
        return;
      }
      const output = await opts.exec(command, opts.shell, opts.cwd);
      replacements.push({ pattern, output });
    }),
  );

  // 用 split/join 做整串替换：天然规避 String.replace 对 $&、$` 的特殊解释（蓝本用函数 replacer 达到同样目的）
  for (const { pattern, output } of replacements) {
    working = working.split(pattern).join(output);
  }
  return working;
}

// ---------------------------------------------------------------------------
// frontmatter：仅取 shell 字段（避免引入 yaml 依赖）
// ---------------------------------------------------------------------------

function parseShellFrontmatter(content: string): ShellKind | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return undefined;
  const line = /^\s*shell\s*:\s*("?)(bash|powershell)\1\s*$/im.exec(m[1]);
  if (!line) return undefined;
  return line[2].toLowerCase() as ShellKind;
}

// ---------------------------------------------------------------------------
// 受信 skill/prompt 根目录发现（provenance 安全门）
// ---------------------------------------------------------------------------

function isInsideOrEqual(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJsonSafe(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** 从一个 settings.json 里收集 skills/prompts 路径条目，解析为绝对目录。 */
function rootsFromSettings(settingsFile: string, baseDir: string): string[] {
  const cfg = readJsonSafe(settingsFile);
  if (!cfg || typeof cfg !== "object") return [];
  const out: string[] = [];
  for (const key of ["skills", "prompts"] as const) {
    const arr = cfg[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      if (typeof entry !== "string" || !entry) continue;
      const expanded = entry.startsWith("~") ? path.join(os.homedir(), entry.slice(1)) : entry;
      const abs = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
      // 指向文件则取其所在目录作为根
      try {
        const st = fs.statSync(abs);
        out.push(st.isDirectory() ? abs : path.dirname(abs));
      } catch {
        out.push(abs);
      }
    }
  }
  return out;
}

/** 收集当前会话的受信根目录。projectTrusted=false 时不纳入项目本地根。 */
function discoverTrustedRoots(cwd: string, projectTrusted: boolean): string[] {
  const roots = new Set<string>();
  const agent = piAgentDir();

  // 全局根（用户自装，视为受信）
  roots.add(path.join(agent, "skills"));
  roots.add(path.join(agent, "prompts"));
  roots.add(path.join(os.homedir(), ".agents", "skills"));
  for (const r of rootsFromSettings(path.join(agent, "settings.json"), agent)) roots.add(r);

  // 项目本地根：仅受信项目纳入；从 cwd 向上走到 git/fs 根
  if (projectTrusted) {
    let dir = path.resolve(cwd);
    while (true) {
      roots.add(path.join(dir, ".pi", "skills"));
      roots.add(path.join(dir, ".pi", "prompts"));
      roots.add(path.join(dir, ".agents", "skills"));
      for (const r of rootsFromSettings(path.join(dir, ".pi", "settings.json"), dir)) roots.add(r);
      const parent = path.dirname(dir);
      if (parent === dir || fs.existsSync(path.join(dir, ".git"))) break;
      dir = parent;
    }
  }

  // 手动追加
  const extra = process.env.PI_SKILL_SHELL_EXTRA_ROOTS;
  if (extra) {
    for (const p of extra.split(path.delimiter)) {
      if (p) roots.add(path.resolve(p));
    }
  }

  return [...roots].map((r) => path.resolve(r));
}

function isTrustedSkillFile(absPath: string, roots: string[]): boolean {
  return roots.some((root) => isInsideOrEqual(absPath, root));
}

// ---------------------------------------------------------------------------
// 会话级状态：受信根 + 命令输出 memo（保证同命令每会话只执行一次）+ 已确认集合
// ---------------------------------------------------------------------------

interface SessionState {
  roots: string[];
  memo: Map<string, Promise<string>>;
  confirmed: Set<string>;
  denied: Set<string>;
}

function freshState(): SessionState {
  return { roots: [], memo: new Map(), confirmed: new Set(), denied: new Set() };
}

// ---------------------------------------------------------------------------
// 扩展入口
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let state = freshState();

  function dbg(ctx: ExtensionContext, msg: string) {
    if (debugEnabled() && ctx.hasUI) ctx.ui.notify(`[skill-shell] ${msg}`, "info");
  }

  function rebuildRoots(ctx: ExtensionContext) {
    let trusted = true;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      trusted = false;
    }
    state.roots = discoverTrustedRoots(ctx.cwd, trusted);
  }

  // memo 化的执行器：key = shell\0cwd\0command —— 同一会话同一命令只真正跑一次
  function makeExec(ctx: ExtensionContext): ExecFn {
    return (command, shell, cwd) => {
      const key = `${shell} ${cwd} ${command}`;
      const cached = state.memo.get(key);
      if (cached) return cached;
      const p = (async () => {
        dbg(ctx, `exec(${shell}) ${command}`);
        const r = await runShell(command, shell, cwd, ctx.signal);
        return formatResult(r);
      })();
      state.memo.set(key, p);
      return p;
    };
  }

  // 可选：每条「首次出现」命令执行前确认
  function makeConfirm(ctx: ExtensionContext): ConfirmFn | undefined {
    if (!isTruthy(process.env.PI_SKILL_SHELL_CONFIRM)) return undefined;
    return async (command) => {
      if (state.confirmed.has(command)) return true;
      if (state.denied.has(command)) return false;
      if (!ctx.hasUI) return false; // 无 UI 又要求确认 → 保守拒绝
      const ok = await ctx.ui.confirm("Skill shell injection", `执行该命令？\n\n${command}`);
      if (ok) state.confirmed.add(command);
      else state.denied.add(command);
      return ok;
    };
  }

  pi.on("session_start", async (_event, ctx) => {
    state = freshState();
    rebuildRoots(ctx);
  });

  // ── 主路径：模型用 read 加载 SKILL.md，结果送回模型前做注入替换 ──────────────
  pi.on("tool_result", async (event: any, ctx) => {
    if (!injectionEnabled()) return;
    if (event.toolName !== "read") return;
    if (event.isError) return;

    const input = event.input ?? {};
    // 仅整文件读：带 offset/limit 的切片读语义不同，跳过
    if (input.offset != null || input.limit != null) return;
    const rawPath = typeof input.path === "string" ? input.path : undefined;
    if (!rawPath) return;

    if (state.roots.length === 0) rebuildRoots(ctx);
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(ctx.cwd, rawPath);
    if (!isTrustedSkillFile(absPath, state.roots)) return; // provenance 门：非受信 skill/prompt 文件不碰

    let content: string;
    try {
      content = await fsp.readFile(absPath, "utf8"); // 从磁盘重读权威原文，规避 read 结果里的行号前缀
    } catch {
      return;
    }
    if (!hasInjectionMarker(content)) return;

    const shell = parseShellFrontmatter(content) ?? defaultShell();
    const skillDir = path.dirname(absPath);
    const substituted = await executeShellInjection(content, {
      shell,
      cwd: skillDir,
      skillDir,
      exec: makeExec(ctx),
      confirm: makeConfirm(ctx),
    });
    if (substituted === content) return;

    dbg(ctx, `injected ${path.basename(absPath)}`);
    return { content: [{ type: "text", text: substituted }] };
  });

  // ── 显式直调：/skillx <name> [args] —— 对标 Claude Code /pr-create 式调用 ──────
  pi.registerCommand("skillx", {
    description: "Load a skill with !`cmd` dynamic shell injection applied (then run it)",
    handler: async (args, ctx) => {
      if (!injectionEnabled()) {
        ctx.ui.notify("skill-shell injection 已被 PI_SKILL_SHELL_INJECTION 禁用", "warning");
        return;
      }
      rebuildRoots(ctx);
      const trimmed = (args || "").trim();
      const sp = trimmed.indexOf(" ");
      const name = sp === -1 ? trimmed : trimmed.slice(0, sp);
      const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
      if (!name) {
        ctx.ui.notify("用法：/skillx <name> [args]", "warning");
        return;
      }

      // 在受信根里定位 <name>/SKILL.md 或 <name>.md
      let file: string | undefined;
      for (const root of state.roots) {
        for (const cand of [path.join(root, name, "SKILL.md"), path.join(root, `${name}.md`)]) {
          if (fs.existsSync(cand)) {
            file = cand;
            break;
          }
        }
        if (file) break;
      }
      if (!file) {
        ctx.ui.notify(`未在受信 skill 根目录找到 skill "${name}"`, "warning");
        return;
      }

      let content: string;
      try {
        content = await fsp.readFile(file, "utf8");
      } catch (e) {
        ctx.ui.notify(`读取失败：${e instanceof Error ? e.message : String(e)}`, "error");
        return;
      }

      const shell = parseShellFrontmatter(content) ?? defaultShell();
      const skillDir = path.dirname(file);
      let rendered = await executeShellInjection(content, {
        shell,
        cwd: skillDir,
        skillDir,
        exec: makeExec(ctx),
        confirm: makeConfirm(ctx),
      });
      // 按 Pi 约定，直调参数追加为 User: <args>
      if (rest) rendered += `\n\nUser: ${rest}`;

      dbg(ctx, `/skillx ${name} → ${path.basename(file)}`);
      pi.sendUserMessage(rendered);
    },
  });

  // ── 状态/自检命令 ──────────────────────────────────────────────────────────
  pi.registerCommand("skill-shell-injection", {
    description: "Show skill shell injection status, trusted roots, and config",
    handler: async (_args, ctx) => {
      rebuildRoots(ctx);
      const lines = [
        `enabled:      ${injectionEnabled()}`,
        `default shell:${defaultShell()}`,
        `timeout:      ${timeoutMs()}ms`,
        `confirm:      ${isTruthy(process.env.PI_SKILL_SHELL_CONFIRM)}`,
        `cached cmds:  ${state.memo.size}`,
        "",
        "trusted skill/prompt roots:",
        ...state.roots.map((r) => `  ${fs.existsSync(r) ? "✓" : "·"} ${r}`),
      ];
      ctx.ui.notify(lines.join("\n"), injectionEnabled() ? "info" : "warning");
    },
  });
}
