/**
 * CLAUDE.md Directory Context Injector for pi
 *
 * Sister extension to agents-md-injector.ts. It treats CLAUDE.md (the project
 * standard file used by Claude Code-maintained repositories) as an AGENTS.md
 * equivalent, so that when pi works inside a Claude-managed repo it still picks
 * up the directory-scoped instructions.
 *
 * Why this exists:
 *   - pi's native context loader walks cwd + ancestors and, per directory,
 *     loads the FIRST of AGENTS.md / CLAUDE.md it finds. So a CLAUDE.md at the
 *     project root (or an ancestor) is already loaded natively.
 *   - But CLAUDE.md files in SUBDIRECTORIES are never loaded natively (the
 *     loader only walks upward). This extension injects those, mirroring what
 *     agents-md-injector does for AGENTS.md.
 *
 * Coexistence with agents-md-injector (no double injection):
 *   - For any given directory, if an AGENTS.md exists there, its CLAUDE.md is
 *     SKIPPED — AGENTS.md wins and agents-md-injector handles that directory.
 *   - A directory's CLAUDE.md is injected only when that directory has NO
 *     AGENTS.md (i.e. a genuinely Claude-managed directory).
 *   - All state keys, message types, commands and env vars are namespaced
 *     separately from agents-md-injector, so the two never collide.
 *
 * Install:
 *   Copy this file to ~/.pi/agent/extensions/claude-md-injector.ts
 *   or to <project>/.pi/extensions/claude-md-injector.ts, then run /reload.
 *
 * Behavior:
 *   - Watches file-oriented tool calls such as read, write, edit, ls, grep, find.
 *   - Optionally scans path-like references in the user's prompt before the
 *     agent starts, so obvious path mentions get context earlier.
 *   - Walks from the target directory up to the configured root, collecting
 *     CLAUDE.md files from outermost to innermost (skipping any directory that
 *     also has an AGENTS.md).
 *   - Injects each CLAUDE.md at most once per pi session.
 *   - Persists the injected-path set through /reload by appending custom state.
 *
 * Environment variables:
 *   CLAUDE_MD_INJECTOR_ROOT       Optional absolute root. Defaults to ctx.cwd.
 *   CLAUDE_MD_INJECTOR_SKIP_ROOT  Defaults to true: skips the CLAUDE.md at the
 *                                  root, since pi already loads the root
 *                                  context file natively. Set to 0/false to
 *                                  also inject the root file.
 *   CLAUDE_MD_INJECTOR_MAX_BYTES  Max bytes read per CLAUDE.md. Default 100000.
 *   CLAUDE_MD_INJECTOR_BLOCK_FIRST_WRITE
 *                                  Defaults to true. Blocks the first write/edit
 *                                  that discovers new CLAUDE.md context so the
 *                                  agent can retry after seeing the injected rules.
 *   CLAUDE_MD_INJECTOR_RESPECT_AGENTS_MD
 *                                  Defaults to true. When a directory also has
 *                                  an AGENTS.md, that directory's CLAUDE.md is
 *                                  skipped (AGENTS.md wins). Set to 0/false to
 *                                  inject CLAUDE.md regardless.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTEXT_FILENAME = "CLAUDE.md";
const SIBLING_FILENAME = "AGENTS.md";
const MESSAGE_TYPE = "claude-md-context";
const STATE_TYPE = "claude-md-injector-state";
const DEFAULT_MAX_BYTES = 100_000;

type ToolInput = Record<string, unknown>;

type InjectionRecord = {
	absolutePath: string;
	relativePath: string;
	content: string;
};

type InjectResult = {
	injectedCount: number;
	message?: {
		customType: string;
		content: string;
		display: boolean;
		details: { paths: string[]; trigger: string };
	};
};

function isFalseyEnv(value: string | undefined): boolean {
	return value === "0" || value?.toLowerCase() === "false" || value?.toLowerCase() === "no";
}

function getMaxBytes(): number {
	const raw = process.env.CLAUDE_MD_INJECTOR_MAX_BYTES;
	if (!raw) return DEFAULT_MAX_BYTES;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function normalizeRoot(cwd: string): string {
	const configured = process.env.CLAUDE_MD_INJECTOR_ROOT;
	const root = configured && path.isAbsolute(configured) ? configured : cwd;
	return path.resolve(root);
}

function isInsideOrEqual(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripAtPrefix(input: string): string {
	return input.startsWith("@") ? input.slice(1) : input;
}

function expandHome(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith(`~${path.sep}`) || input.startsWith("~/")) {
		return path.join(os.homedir(), input.slice(2));
	}
	return input;
}

function resolvePathCandidate(rawPath: string, cwd: string): string | undefined {
	const cleaned = stripAtPrefix(rawPath.trim()).replace(/^['"]|['"]$/g, "");
	if (!cleaned || cleaned.includes("\n") || cleaned.includes("\0")) return undefined;

	const expanded = expandHome(cleaned);
	return path.resolve(cwd, expanded);
}

async function getTargetDirectory(absolutePath: string): Promise<string> {
	try {
		const stat = await fsp.stat(absolutePath);
		return stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
	} catch {
		return path.dirname(absolutePath);
	}
}

async function isReadableFile(filePath: string): Promise<boolean> {
	try {
		const stat = await fsp.stat(filePath);
		return stat.isFile();
	} catch {
		return false;
	}
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
	const handle = await fsp.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		const truncated = bytesRead > maxBytes;
		const usable = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		// StringDecoder.write emits only complete UTF-8 sequences and buffers any
		// partial trailing multibyte char; since we never call end(), a char split
		// at the byte boundary is dropped rather than corrupted (important for CJK
		// CLAUDE.md content).
		let text = new StringDecoder("utf8").write(usable);
		if (truncated) {
			text += `\n\n[CLAUDE.md truncated by claude-md-injector at ${maxBytes} bytes.]`;
		}
		return text;
	} finally {
		await handle.close();
	}
}

async function discoverContextFilesForPath(
	rawPath: string,
	cwd: string,
	alreadyInjected: Set<string>,
): Promise<InjectionRecord[]> {
	const root = normalizeRoot(cwd);
	const absoluteTarget = resolvePathCandidate(rawPath, cwd);
	if (!absoluteTarget || !isInsideOrEqual(absoluteTarget, root)) return [];

	let current = await getTargetDirectory(absoluteTarget);
	current = path.resolve(current);
	if (!isInsideOrEqual(current, root)) return [];

	// Default to skipping the root CLAUDE.md (pi loads the root context file
	// natively); set CLAUDE_MD_INJECTOR_SKIP_ROOT=0/false to inject it too.
	const skipRoot = !isFalseyEnv(process.env.CLAUDE_MD_INJECTOR_SKIP_ROOT);
	// Default to respecting AGENTS.md: if a directory also has AGENTS.md, skip
	// that directory's CLAUDE.md so agents-md-injector owns it (no double inject).
	const respectAgentsMd = !isFalseyEnv(process.env.CLAUDE_MD_INJECTOR_RESPECT_AGENTS_MD);
	const maxBytes = getMaxBytes();
	const candidates: string[] = [];

	while (isInsideOrEqual(current, root)) {
		if (!(skipRoot && current === root)) {
			const siblingAgents = path.join(current, SIBLING_FILENAME);
			const hasAgentsMd = respectAgentsMd && (await isReadableFile(siblingAgents));
			if (!hasAgentsMd) {
				const candidate = path.join(current, CONTEXT_FILENAME);
				if (await isReadableFile(candidate)) {
					candidates.unshift(path.resolve(candidate));
				}
			}
		}

		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const records: InjectionRecord[] = [];
	for (const candidate of candidates) {
		if (alreadyInjected.has(candidate)) continue;

		let content: string;
		try {
			content = await readFilePrefix(candidate, maxBytes);
		} catch {
			continue;
		}
		if (!content.trim()) continue;

		records.push({
			absolutePath: candidate,
			relativePath: path.relative(root, candidate) || path.basename(candidate),
			content,
		});
	}

	return records;
}

function buildInjectionMessage(records: InjectionRecord[], trigger: string): string {
	const sections = records.map((record) => {
		return [
			`=== Auto-injected directory-scoped guide (CLAUDE.md, treated as AGENTS.md equivalent): ${record.relativePath} ===`,
			record.content.trimEnd(),
		].join("\n");
	});

	return [
		"Directory-scoped CLAUDE.md context was discovered for file work in this session.",
		"CLAUDE.md is the project-standard instruction file used by Claude Code-maintained repositories; treat it exactly as you would an AGENTS.md.",
		`Trigger: ${trigger}`,
		"Treat the following CLAUDE.md content as instructions that apply to files under the corresponding directories. If these instructions conflict with higher-priority system or developer instructions, follow the higher-priority instructions.",
		"",
		...sections,
	].join("\n");
}

function getPathArgsFromToolCall(toolName: string, input: ToolInput): string[] {
	const paths: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim()) paths.push(value);
	};

	if (["read", "write", "edit", "ls", "grep", "find"].includes(toolName)) {
		push(input.path);
	}

	// Some custom or SDK tools use other common names. This keeps the extension
	// useful without depending on a specific project or tool provider.
	for (const key of ["file", "filePath", "filepath", "notebook_path", "notebookPath", "target", "dir", "directory"]) {
		push(input[key]);
	}

	return [...new Set(paths)];
}

function extractPathLikeReferences(text: string): string[] {
	const results = new Set<string>();

	// Backticked paths: `src/foo.ts`, `docs/CLAUDE.md`.
	for (const match of text.matchAll(/`([^`]+)`/g)) {
		const candidate = match[1]?.trim();
		if (candidate && looksPathLike(candidate)) results.add(candidate);
	}

	// @path references commonly used by coding agents.
	for (const match of text.matchAll(/(?:^|\s)@([^\s`'"<>]+)/g)) {
		const candidate = match[1]?.trim();
		if (candidate && looksPathLike(candidate)) results.add(candidate);
	}

	// Conservative bare paths with slash or backslash. Avoid ordinary prose.
	for (const match of text.matchAll(/(?:^|\s)([^\s`'"<>]*[\\/][^\s`'"<>]+)/g)) {
		const candidate = match[1]?.trim().replace(/[.,;:!?)]$/, "");
		if (candidate && looksPathLike(candidate)) results.add(candidate);
	}

	return [...results];
}

function looksPathLike(candidate: string): boolean {
	if (candidate.length > 500) return false;
	if (candidate.includes("\n") || candidate.includes("\0")) return false;
	// Exclude URLs (http://, file://, etc.) — the bare-path regex would otherwise
	// capture them and resolve to spurious paths under cwd. Uses "://" only, so
	// Windows drive paths like C:\foo are not affected.
	if (candidate.includes("://")) return false;
	return (
		candidate.includes("/") ||
		candidate.includes("\\") ||
		candidate === CONTEXT_FILENAME ||
		candidate.endsWith(".md") ||
		candidate.startsWith("@")
	);
}

export default function claudeMdInjector(pi: ExtensionAPI) {
	let injected = new Set<string>();

	async function injectForPaths(
		pathsToCheck: string[],
		cwd: string,
		trigger: string,
		mode: "message" | "sendMessage",
	): Promise<InjectResult> {
		const allRecords: InjectionRecord[] = [];

		for (const pathToCheck of pathsToCheck) {
			const records = await discoverContextFilesForPath(pathToCheck, cwd, injected);
			for (const record of records) {
				if (!injected.has(record.absolutePath)) {
					injected.add(record.absolutePath);
					allRecords.push(record);
				}
			}
		}

		if (allRecords.length === 0) return { injectedCount: 0 };

		pi.appendEntry(STATE_TYPE, { paths: [...injected] });
		const content = buildInjectionMessage(allRecords, trigger);

		const message = {
			customType: MESSAGE_TYPE,
			content,
			display: true,
			details: { paths: allRecords.map((record) => record.absolutePath), trigger },
		};

		if (mode === "sendMessage") {
			pi.sendMessage(message, { deliverAs: "steer" });
			return { injectedCount: allRecords.length };
		}

		return { injectedCount: allRecords.length, message };
	}

	pi.on("session_start", async (_event, ctx) => {
		injected = new Set<string>();

		for (const entry of ctx.sessionManager.getEntries() as Array<Record<string, unknown>>) {
			if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
			const data = entry.data as { paths?: unknown } | undefined;
			if (!Array.isArray(data?.paths)) continue;
			for (const item of data.paths) {
				if (typeof item === "string") injected.add(item);
			}
		}

		if (ctx.hasUI) {
			ctx.ui.setStatus("claude-md", `CLAUDE.md: ${injected.size} loaded`);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const pathRefs = extractPathLikeReferences(event.prompt);
		if (pathRefs.length === 0) return undefined;

		const result = await injectForPaths(pathRefs, ctx.cwd, "user prompt path reference", "message");
		if (!result.message) return undefined;

		if (ctx.hasUI) {
			ctx.ui.setStatus("claude-md", `CLAUDE.md: ${injected.size} loaded`);
			ctx.ui.notify(`Injected ${result.injectedCount} CLAUDE.md file(s) for path context`, "info");
		}

		return { message: result.message };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as ToolInput;
		if (!input || typeof input !== "object") return undefined;

		const pathsToCheck = getPathArgsFromToolCall(event.toolName, input);
		if (pathsToCheck.length === 0) return undefined;

		const result = await injectForPaths(pathsToCheck, ctx.cwd, `${event.toolName} tool call`, "sendMessage");

		if (ctx.hasUI) {
			ctx.ui.setStatus("claude-md", `CLAUDE.md: ${injected.size} loaded`);
		}

		const shouldBlockFirstWrite = !isFalseyEnv(process.env.CLAUDE_MD_INJECTOR_BLOCK_FIRST_WRITE);
		if (shouldBlockFirstWrite && result.injectedCount > 0 && ["write", "edit"].includes(event.toolName)) {
			return {
				block: true,
				reason:
					"New directory-scoped CLAUDE.md context was injected. Re-read the injected instructions and retry this write/edit if still appropriate.",
			};
		}

		return undefined;
	});

	pi.registerCommand("claude-md-status", {
		description: "Show CLAUDE.md directory-context injection status",
		handler: async (_args, ctx) => {
			const lines = [...injected].sort();
			if (lines.length === 0) {
				ctx.ui.notify("No CLAUDE.md files have been injected in this session.", "info");
				return;
			}
			ctx.ui.notify(`Injected CLAUDE.md files:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("claude-md-reset", {
		description: "Clear the in-memory CLAUDE.md injection dedup set for this extension runtime",
		handler: async (_args, ctx) => {
			injected.clear();
			ctx.ui.setStatus("claude-md", "CLAUDE.md: 0 loaded");
			ctx.ui.notify("CLAUDE.md injection dedup set cleared for this runtime.", "info");
		},
	});
}
