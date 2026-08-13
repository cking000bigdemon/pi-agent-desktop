/**
 * Windows Encoding Guard for pi
 *
 * User-level pi extension port of the Claude Code PreToolUse hook:
 *   .claude/hooks/guard-windows-encoding.ps1
 *
 * It statically checks PowerShell and Python source before pi's built-in
 * `write` / `edit` tools mutate a file. Fatal PowerShell encoding traps block
 * the tool call; advisory findings are injected into the next model request.
 *
 * Install:
 *   Save as ~/.pi/agent/extensions/windows-encoding-guard.ts and run /reload.
 *
 * Environment variables:
 *   PI_WINDOWS_ENCODING_GUARD=0   Disable the extension.
 *
 * Slash command:
 *   /windows-encoding-audit [path]
 *   Audit one file or a directory recursively. Defaults to .claude/hooks when
 *   present, otherwise the current working directory.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const EXTENSION_NAME = "windows-encoding-guard";
const SELF_NAMES = new Set(["windows-encoding-guard.ts", "guard-windows-encoding.ps1"]);
const MAX_AUDIT_REPORT_ISSUES = 100;

interface Finding {
  level: "BLOCK" | "WARN";
  message: string;
}

interface AuditResult {
  path: string;
  findings: Finding[];
}

function isDisabled(): boolean {
  const value = process.env.PI_WINDOWS_ENCODING_GUARD;
  return value === "0" || value?.toLowerCase() === "false" || value?.toLowerCase() === "no";
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function resolveToolPath(rawPath: unknown, cwd: string): string | undefined {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return undefined;
  const cleaned = rawPath.trim().replace(/^@/, "");
  return path.resolve(cwd, cleaned);
}

function isSourcePath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ps1" || ext === ".py";
}

/**
 * Best-effort PowerShell comment stripper.
 *
 * This deliberately preserves quoted strings and removes line comments plus
 * block comments outside strings. It is not a full PowerShell tokenizer, but
 * it preserves the hook's important property: documenting a bad pattern in a
 * normal comment is not treated as committing that pattern in executable code.
 */
export function removePowerShellComments(source: string): string {
  let output = "";
  let i = 0;
  let quote: "single" | "double" | null = null;
  let blockComment = false;
  let lineComment = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (blockComment) {
      if (ch === "#" && next === ">") {
        output += "  ";
        i += 2;
        blockComment = false;
        continue;
      }
      output += ch === "\n" || ch === "\r" ? ch : " ";
      i += 1;
      continue;
    }

    if (lineComment) {
      if (ch === "\n" || ch === "\r") {
        output += ch;
        lineComment = false;
      } else {
        output += " ";
      }
      i += 1;
      continue;
    }

    if (quote === "single") {
      output += ch;
      if (ch === "'" && next === "'") {
        output += next;
        i += 2;
        continue;
      }
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }

    if (quote === "double") {
      output += ch;
      if (ch === "`") {
        if (next !== undefined) {
          output += next;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }

    if (ch === "<" && next === "#") {
      output += "  ";
      i += 2;
      blockComment = true;
      continue;
    }
    if (ch === "#") {
      output += " ";
      i += 1;
      lineComment = true;
      continue;
    }
    if (ch === "'") quote = "single";
    if (ch === '"') quote = "double";
    output += ch;
    i += 1;
  }

  return output;
}

function hasUtf8Bom(buffer: Buffer | undefined): boolean {
  return !!buffer && buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function block(message: string): Finding {
  return { level: "BLOCK", message };
}

function warn(message: string): Finding {
  return { level: "WARN", message };
}

export function testSource(filePath: string, text: string, options?: { existingBytes?: Buffer }): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  const name = path.basename(filePath);
  if (SELF_NAMES.has(name)) return findings;

  const ext = path.extname(filePath).toLowerCase();
  const normalizedPath = normalizeSlashes(filePath).toLowerCase();
  const inHooksDir = normalizedPath.includes("/hooks/");

  if (ext === ".ps1") {
    const code = removePowerShellComments(text);

    if (/\[Console\]::In\b/.test(code)) {
      findings.push(block(
        `[BLOCK] ${name}: reads stdin via [Console]::In.\n` +
          `[Console]::In decodes with the console ANSI codepage (GBK on this machine). ` +
          `This machine's home path contains full-width parentheses; a UTF-8 byte can pair ` +
          `with a following backslash and corrupt the JSON escape before ConvertFrom-Json.\n` +
          `Use an explicit UTF-8 StreamReader instead:\n` +
          `    $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false)))\n` +
          `    $raw = $reader.ReadToEnd()`,
      ));
    }

    const nonAscii = code.match(/[^\x00-\x7f]/);
    const existingBytes = options?.existingBytes;
    const fileHasBom = hasUtf8Bom(existingBytes);
    if (nonAscii && !fileHasBom) {
      findings.push(block(
        `[BLOCK] ${name}: non-ASCII character ${JSON.stringify(nonAscii[0])} appears in PowerShell code ` +
          `(outside comments), but the file has no UTF-8 BOM. powershell.exe 5.1 reads a BOM-less .ps1 ` +
          `with the ANSI codepage (GBK here), so string literals can be corrupted or cause ParserError.\n` +
          `Either keep executable code ASCII-only, or write the complete file with a UTF-8 BOM. ` +
          `Pi's built-in write tool emits UTF-8 without BOM (edit preserves one the file already has), ` +
          `so prefer ASCII-only executable code unless another BOM-aware writer is used.`,
      ));
    }

    if (inHooksDir && /ConvertFrom-Json/.test(code) && !/OpenStandardInput/.test(code)) {
      findings.push(warn(
        `[WARN] ${name}: parses stdin JSON but never calls [Console]::OpenStandardInput(). ` +
          `$input and Get-Content - go through the same ANSI codepage and can hit the same trap.`,
      ));
    }

    if (
      /CLAUDE_PROJECT_DIR/.test(code) &&
      /(StartsWith|Equals\s*\()/.test(code) &&
      !/GetFullPath/.test(code)
    ) {
      findings.push(warn(
        `[WARN] ${name}: compares paths against $env:CLAUDE_PROJECT_DIR without ` +
          `[System.IO.Path]::GetFullPath(). Claude Code can provide forward slashes while ` +
          `GetFullPath returns backslashes, so the comparison may always be false.`,
      ));
    }

    if (inHooksDir && /(Write-Host|Write-Output)/.test(code) && !/hookSpecificOutput/.test(code)) {
      findings.push(warn(
        `[WARN] ${name}: writes bare text to stdout. Bare stdout from a Claude PreToolUse/PostToolUse ` +
          `hook is transcript-only; inject context with a hookSpecificOutput envelope instead.`,
      ));
    }
  } else if (ext === ".py") {
    if (/subprocess\.(run|Popen|call|check_call|check_output)/.test(text)) {
      const envLiterals = text.match(/env\s*=\s*\{[^}]*\}/gs) ?? [];
      const preservesParentEnv = /\*\*\s*os\.environ|os\.environ\.items\s*\(|os\.environ\.copy\s*\(|dict\s*\(\s*os\.environ/;
      for (const matched of envLiterals) {
        if (!/PYTHONIOENCODING/.test(matched) && !preservesParentEnv.test(matched)) {
          findings.push(warn(
            `[WARN] ${name}: subprocess gets an env={...} literal, which replaces the child environment. ` +
              `PYTHONIOENCODING / PYTHONUTF8 may be dropped and the child can fall back to GBK output. ` +
              `Add 'PYTHONIOENCODING': 'utf-8' or spread {**os.environ, ...}. Matched: ${matched}`,
          ));
        }
      }
    }
  }

  return findings;
}

function readExistingBytes(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return undefined;
  }
}

function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
}

/**
 * Reconstruct the exact content that pi's built-in tool is about to write.
 *
 * For edit, all replacements are matched against the same original file, just
 * like pi's built-in edit implementation. If reconstruction is not possible,
 * fall back to checking only the inserted chunks rather than blocking unrelated
 * edit validation errors.
 */
function getProposedSource(event: ToolCallEvent, filePath: string, existingBytes: Buffer | undefined): string | undefined {
  if (isToolCallEventType("write", event)) {
    return typeof event.input.content === "string" ? event.input.content : undefined;
  }
  if (!isToolCallEventType("edit", event) || !Array.isArray(event.input.edits)) return undefined;

  const newChunks = event.input.edits
    .map((edit) => edit?.newText)
    .filter((text): text is string => typeof text === "string");
  const fallback = newChunks.join("\n");
  if (!existingBytes) return fallback;

  const raw = existingBytes.toString("utf8").replace(/^\uFEFF/, "");
  const original = normalizeToLf(raw);
  const edits = event.input.edits.map((edit) => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }));

  const matches: Array<{ index: number; length: number; newText: string }> = [];
  for (const edit of edits) {
    if (!edit.oldText || countOccurrences(original, edit.oldText) !== 1) return fallback;
    const index = original.indexOf(edit.oldText);
    matches.push({ index, length: edit.oldText.length, newText: edit.newText });
  }

  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i - 1].index + matches[i - 1].length > matches[i].index) return fallback;
  }

  let proposed = original;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    proposed = proposed.slice(0, match.index) + match.newText + proposed.slice(match.index + match.length);
  }
  return proposed;
}

function formatFindings(findings: Finding[]): string {
  return findings.map((finding) => finding.message).join("\n\n");
}

function injectWarnings(pi: ExtensionAPI, filePath: string, warnings: Finding[]): void {
  if (warnings.length === 0) return;
  const message =
    `Windows encoding guard warnings for ${filePath}:\n\n${formatFindings(warnings)}\n\n` +
    `Review and fix these warnings before treating the source as safe.`;
  pi.sendMessage(
    {
      customType: EXTENSION_NAME,
      content: message,
      display: true,
      details: { filePath, warnings },
    },
    { deliverAs: "steer" },
  );
}

async function collectAuditTargets(target: string): Promise<string[]> {
  const stat = await fsp.stat(target);
  if (stat.isFile()) return isSourcePath(target) ? [target] : [];
  if (!stat.isDirectory()) return [];

  const results: string[] = [];
  const skipDirs = new Set([".git", ".venv", "venv", "node_modules", "site-packages", "__pycache__"]);
  const stack = [target];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(child);
      } else if (entry.isFile() && isSourcePath(child)) {
        results.push(child);
      }
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

async function auditPath(target: string): Promise<{ scanned: number; results: AuditResult[] }> {
  const targets = await collectAuditTargets(target);
  const results: AuditResult[] = [];

  for (const filePath of targets) {
    const bytes = await fsp.readFile(filePath);
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "");
    const findings = testSource(filePath, text, { existingBytes: bytes });
    if (findings.length > 0) results.push({ path: filePath, findings });
  }

  return { scanned: targets.length, results };
}

function defaultAuditTarget(cwd: string): string {
  const hooks = path.join(cwd, ".claude", "hooks");
  return fs.existsSync(hooks) ? hooks : cwd;
}

function auditSummary(target: string, scanned: number, results: AuditResult[], cwd: string): string {
  const issueCount = results.reduce((sum, result) => sum + result.findings.length, 0);
  const lines = [`Windows encoding audit: ${scanned} file(s) scanned, ${issueCount} issue(s).`, `Target: ${target}`];

  let emitted = 0;
  for (const result of results) {
    const displayPath = path.relative(cwd, result.path) || result.path;
    lines.push("", displayPath);
    for (const finding of result.findings) {
      if (emitted >= MAX_AUDIT_REPORT_ISSUES) break;
      lines.push(finding.message);
      emitted += 1;
    }
    if (emitted >= MAX_AUDIT_REPORT_ISSUES) break;
  }

  if (issueCount > emitted) {
    lines.push("", `Report truncated after ${emitted} issue(s); ${issueCount - emitted} more issue(s) omitted.`);
  }
  return lines.join("\n");
}

export default function windowsEncodingGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (isDisabled()) return;
    if (!isToolCallEventType("write", event) && !isToolCallEventType("edit", event)) return;

    const filePath = resolveToolPath(event.input.path, ctx.cwd);
    if (!filePath || !isSourcePath(filePath)) return;

    const existingBytes = readExistingBytes(filePath);
    const proposedSource = getProposedSource(event, filePath, existingBytes);
    if (!proposedSource) return;

    // pi's two file-mutating tools disagree about the BOM: `edit` strips it for
    // matching and restores it on write (dist/core/tools/edit.js:
    // `finalContent = bom + ...`), while `write` emits plain UTF-8 and drops it.
    // Only credit an existing BOM when it will actually survive this tool call —
    // otherwise a `write` over a BOM-ful .ps1 silently produces exactly the
    // BOM-less, non-ASCII file this guard exists to stop.
    const bomSurvives = isToolCallEventType("edit", event);
    const findings = testSource(filePath, proposedSource, {
      existingBytes: bomSurvives ? existingBytes : undefined,
    });
    if (findings.length === 0) return;

    const blocks = findings.filter((finding) => finding.level === "BLOCK");
    const warnings = findings.filter((finding) => finding.level === "WARN");

    if (blocks.length > 0) {
      const reason =
        `Blocked by ${EXTENSION_NAME} (Windows encoding guard):\n\n` +
        formatFindings([...blocks, ...warnings]);
      if (ctx.hasUI) ctx.ui.notify(`Blocked unsafe source write: ${path.basename(filePath)}`, "warning");
      return { block: true, reason };
    }

    injectWarnings(pi, filePath, warnings);
  });

  pi.registerCommand("windows-encoding-audit", {
    description: "Audit PowerShell/Python source for Windows encoding traps",
    handler: async (args, ctx) => {
      if (isDisabled()) {
        ctx.ui.notify(`${EXTENSION_NAME} is disabled by PI_WINDOWS_ENCODING_GUARD=0.`, "warning");
        return;
      }

      const rawTarget = args.trim();
      const target = rawTarget ? path.resolve(ctx.cwd, rawTarget.replace(/^@/, "")) : defaultAuditTarget(ctx.cwd);
      try {
        const { scanned, results } = await auditPath(target);
        const report = auditSummary(target, scanned, results, ctx.cwd);
        ctx.ui.notify(report, results.length > 0 ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(
          `Windows encoding audit failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
