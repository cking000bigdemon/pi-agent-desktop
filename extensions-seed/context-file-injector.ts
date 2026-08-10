/*
 * Directory Context File Injector for pi
 *
 * Complements pi's native context loader. Pi loads context files from the
 * current working directory and its ancestors; this extension discovers the
 * same files later when the agent works inside a descendant directory.
 *
 * Per-directory precedence matches pi v0.84.0:
 *   AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD
 *
 * This replaces the former agents-md-injector.ts and
 * claude-md-injector.ts extensions. It restores their legacy session state so
 * resumed sessions do not receive duplicate context.
 *
 * Behavior:
 *   - Scans path-like references in the user prompt before the agent starts.
 *   - Watches file-oriented tool calls and common path argument names.
 *   - Walks from the target directory toward the configured root, selecting
 *     at most one context file per directory using pi's native precedence.
 *   - Injects each selected file at most once per session.
 *   - Blocks a first write/edit that discovers new context, including writes
 *     later in the same parallel tool batch after a read discovered it.
 *
 * Environment variables:
 *   CONTEXT_FILE_INJECTOR_ROOT
 *     Optional absolute boundary. Defaults to ctx.cwd.
 *   CONTEXT_FILE_INJECTOR_SKIP_ROOT
 *     Defaults to true because pi normally loads cwd context natively.
 *   CONTEXT_FILE_INJECTOR_MAX_BYTES
 *     Maximum bytes read per context file. Defaults to 100000.
 *   CONTEXT_FILE_INJECTOR_BLOCK_FIRST_WRITE
 *     Defaults to true.
 *
 * Legacy AGENTS_MD_INJECTOR_* and CLAUDE_MD_INJECTOR_* variables are used as
 * fallbacks when the corresponding CONTEXT_FILE_INJECTOR_* variable is unset.
 */

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTEXT_CANDIDATES = [
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
] as const;

const MESSAGE_TYPE = "directory-context-file";
const STATE_TYPE = "context-file-injector-state";
const LEGACY_STATE_TYPES = new Set([
	"agents-md-injector-state",
	"claude-md-injector-state",
]);
const DEFAULT_MAX_BYTES = 100_000;
const STATUS_ID = "context-files";

type ToolInput = Record<string, unknown>;

type InjectionRecord = {
	absolutePath: string;
	relativePath: string;
	content: string;
};

type InjectResult = {
	injectedCount: number;
	records: InjectionRecord[];
	message?: {
		customType: string;
		content: string;
		display: boolean;
		details: { paths: string[]; trigger: string };
	};
};

function firstDefined(...values: Array<string | undefined>): string | undefined {
	return values.find((value) => value !== undefined);
}

function isFalseyEnv(value: string | undefined): boolean {
	return value === "0" || value?.toLowerCase() === "false" || value?.toLowerCase() === "no";
}

function getCompatEnv(current: string, agentsLegacy: string, claudeLegacy: string): string | undefined {
	return firstDefined(
		process.env[current],
		process.env[agentsLegacy],
		process.env[claudeLegacy],
	);
}

function getMaxBytes(): number {
	const raw = getCompatEnv(
		"CONTEXT_FILE_INJECTOR_MAX_BYTES",
		"AGENTS_MD_INJECTOR_MAX_BYTES",
		"CLAUDE_MD_INJECTOR_MAX_BYTES",
	);
	if (!raw) return DEFAULT_MAX_BYTES;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function shouldSkipRoot(): boolean {
	const raw = getCompatEnv(
		"CONTEXT_FILE_INJECTOR_SKIP_ROOT",
		"AGENTS_MD_INJECTOR_SKIP_ROOT",
		"CLAUDE_MD_INJECTOR_SKIP_ROOT",
	);
	return raw === undefined ? true : !isFalseyEnv(raw);
}

function shouldBlockFirstWrite(): boolean {
	const raw = getCompatEnv(
		"CONTEXT_FILE_INJECTOR_BLOCK_FIRST_WRITE",
		"AGENTS_MD_INJECTOR_BLOCK_FIRST_WRITE",
		"CLAUDE_MD_INJECTOR_BLOCK_FIRST_WRITE",
	);
	return raw === undefined ? true : !isFalseyEnv(raw);
}

function normalizeRoot(cwd: string): string {
	const configured = getCompatEnv(
		"CONTEXT_FILE_INJECTOR_ROOT",
		"AGENTS_MD_INJECTOR_ROOT",
		"CLAUDE_MD_INJECTOR_ROOT",
	);
	const root = configured && path.isAbsolute(configured) ? configured : cwd;
	return path.resolve(root);
}

function pathKey(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
	return path.resolve(cwd, expandHome(cleaned));
}

async function getTargetDirectory(absolutePath: string, rawPath: string): Promise<string> {
	try {
		const stat = await fsp.stat(absolutePath);
		return stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
	} catch {
		if (/[\\/]$/.test(rawPath.trim())) return absolutePath;
		return path.dirname(absolutePath);
	}
}

async function isReadableFile(filePath: string): Promise<boolean> {
	try {
		return (await fsp.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function selectContextFile(directory: string): Promise<string | undefined> {
	for (const filename of CONTEXT_CANDIDATES) {
		const candidate = path.join(directory, filename);
		if (await isReadableFile(candidate)) return path.resolve(candidate);
	}
	return undefined;
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
	const handle = await fsp.open(filePath, "r");
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
		const truncated = bytesRead > maxBytes;
		const usable = buffer.subarray(0, Math.min(bytesRead, maxBytes));
		let text = new StringDecoder("utf8").write(usable);
		if (truncated) {
			text += `\n\n[Context file truncated by context-file-injector at ${maxBytes} bytes.]`;
		}
		return text;
	} finally {
		await handle.close();
	}
}

async function discoverContextFilesForPath(
	rawPath: string,
	cwd: string,
	availableKeys: Set<string>,
): Promise<InjectionRecord[]> {
	const root = normalizeRoot(cwd);
	const absoluteTarget = resolvePathCandidate(rawPath, cwd);
	if (!absoluteTarget || !isInsideOrEqual(absoluteTarget, root)) return [];

	let current = path.resolve(await getTargetDirectory(absoluteTarget, rawPath));
	if (!isInsideOrEqual(current, root)) return [];

	const candidates: string[] = [];
	while (isInsideOrEqual(current, root)) {
		if (!(shouldSkipRoot() && current === root)) {
			const selected = await selectContextFile(current);
			if (selected) candidates.unshift(selected);
		}

		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const records: InjectionRecord[] = [];
	for (const candidate of candidates) {
		if (availableKeys.has(pathKey(candidate))) continue;

		let content: string;
		try {
			content = await readFilePrefix(candidate, getMaxBytes());
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
	const sections = records.map((record) => [
		`=== Auto-injected directory context: ${record.relativePath} ===`,
		record.content.trimEnd(),
	].join("\n"));

	return [
		"Directory-scoped context files were discovered for file work in this session.",
		`Trigger: ${trigger}`,
		"Pi-compatible precedence was applied independently in each directory: AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD.",
		"Treat each file below as instructions for files under its directory. Higher-priority system and developer instructions still take precedence.",
		"",
		...sections,
	].join("\n");
}

function getPathArgsFromToolCall(toolName: string, input: ToolInput): string[] {
	const paths: string[] = [];
	const push = (value: unknown) => {
		if (typeof value === "string" && value.trim()) paths.push(value);
	};

	const simpleName = toolName.split(/[.:/]/).at(-1)?.toLowerCase();
	if (["read", "write", "edit", "ls", "grep", "find"].includes(simpleName ?? "")) {
		push(input.path);
	}

	for (const key of [
		"file",
		"filePath",
		"filepath",
		"notebook_path",
		"notebookPath",
		"target",
		"dir",
		"directory",
	]) {
		push(input[key]);
	}
	return [...new Set(paths)];
}

function isWriteLikeTool(toolName: string): boolean {
	const simpleName = toolName.split(/[.:/]/).at(-1)?.toLowerCase();
	return simpleName === "write" || simpleName === "edit";
}

function extractPathLikeReferences(text: string): string[] {
	const results = new Set<string>();

	for (const match of text.matchAll(/`([^`]+)`/g)) {
		const candidate = match[1]?.trim();
		if (candidate && looksPathLike(candidate)) results.add(candidate);
	}
	for (const match of text.matchAll(/(?:^|\s)@([^\s`'"<>]+)/g)) {
		const candidate = match[1]?.trim();
		if (candidate && looksPathLike(candidate)) results.add(candidate);
	}
	for (const match of text.matchAll(/(?:^|\s)([^\s`'"<>]*[\\/][^\s`'"<>]+)/g)) {
		const candidate = match[1]?.trim().replace(/[.,;:!?)]$/, "");
		if (candidate && looksPathLike(candidate)) results.add(candidate);
	}
	return [...results];
}

function looksPathLike(candidate: string): boolean {
	if (candidate.length > 500 || candidate.includes("\n") || candidate.includes("\0")) return false;
	if (candidate.includes("://")) return false;
	return (
		candidate.includes("/") ||
		candidate.includes("\\") ||
		CONTEXT_CANDIDATES.includes(candidate as (typeof CONTEXT_CANDIDATES)[number]) ||
		candidate.endsWith(".md") ||
		candidate.startsWith("@")
	);
}

function readStatePaths(entry: Record<string, unknown>): string[] {
	if (entry.type !== "custom" || typeof entry.customType !== "string") return [];
	if (entry.customType !== STATE_TYPE && !LEGACY_STATE_TYPES.has(entry.customType)) return [];
	const data = entry.data as { paths?: unknown } | undefined;
	if (!Array.isArray(data?.paths)) return [];
	return data.paths.filter((item): item is string => typeof item === "string");
}

export default function contextFileInjector(pi: ExtensionAPI) {
	let nativePaths = new Map<string, string>();
	let injectedPaths = new Map<string, string>();
	let pendingWriteGuardDirs = new Map<string, string>();

	function availableKeys(): Set<string> {
		return new Set([...nativePaths.keys(), ...injectedPaths.keys()]);
	}

	function updateStatus(ctx: { hasUI: boolean; ui: { setStatus(id: string, text: string | undefined): void } }) {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, `Context files: ${injectedPaths.size} injected`);
	}

	function rememberNativeContextFiles(contextFiles: unknown) {
		if (!Array.isArray(contextFiles)) return;
		for (const item of contextFiles) {
			if (!item || typeof item !== "object") continue;
			const filePath = (item as { path?: unknown }).path;
			if (typeof filePath !== "string") continue;
			nativePaths.set(pathKey(filePath), path.resolve(filePath));
		}
	}

	function persistInjectedState() {
		pi.appendEntry(STATE_TYPE, { paths: [...injectedPaths.values()] });
	}

	async function injectForPaths(
		pathsToCheck: string[],
		cwd: string,
		trigger: string,
		mode: "message" | "sendMessage",
	): Promise<InjectResult> {
		const allRecords: InjectionRecord[] = [];
		const known = availableKeys();

		for (const pathToCheck of pathsToCheck) {
			const records = await discoverContextFilesForPath(pathToCheck, cwd, known);
			for (const record of records) {
				const key = pathKey(record.absolutePath);
				if (known.has(key)) continue;
				known.add(key);
				injectedPaths.set(key, record.absolutePath);
				allRecords.push(record);
			}
		}

		if (allRecords.length === 0) return { injectedCount: 0, records: [] };
		persistInjectedState();
		const content = buildInjectionMessage(allRecords, trigger);
		const message = {
			customType: MESSAGE_TYPE,
			content,
			display: true,
			details: { paths: allRecords.map((record) => record.absolutePath), trigger },
		};

		if (mode === "sendMessage") {
			for (const record of allRecords) {
				const directory = path.dirname(record.absolutePath);
				pendingWriteGuardDirs.set(pathKey(directory), directory);
			}
			pi.sendMessage(message, { deliverAs: "steer" });
			return { injectedCount: allRecords.length, records: allRecords };
		}
		return { injectedCount: allRecords.length, records: allRecords, message };
	}

	function writeTouchesPendingContext(pathsToCheck: string[], cwd: string): boolean {
		for (const rawPath of pathsToCheck) {
			const target = resolvePathCandidate(rawPath, cwd);
			if (!target) continue;
			for (const directory of pendingWriteGuardDirs.values()) {
				if (isInsideOrEqual(target, directory)) return true;
			}
		}
		return false;
	}

	pi.on("session_start", async (_event, ctx) => {
		nativePaths = new Map();
		injectedPaths = new Map();
		pendingWriteGuardDirs = new Map();

		for (const entry of ctx.sessionManager.getEntries() as Array<Record<string, unknown>>) {
			for (const filePath of readStatePaths(entry)) {
				injectedPaths.set(pathKey(filePath), path.resolve(filePath));
			}
		}
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		rememberNativeContextFiles(event.systemPromptOptions?.contextFiles);
		const pathRefs = extractPathLikeReferences(event.prompt);
		if (pathRefs.length === 0) {
			updateStatus(ctx);
			return undefined;
		}

		const result = await injectForPaths(pathRefs, ctx.cwd, "user prompt path reference", "message");
		updateStatus(ctx);
		if (!result.message) return undefined;

		if (ctx.hasUI) {
			ctx.ui.notify(`Injected ${result.injectedCount} directory context file(s)`, "info");
		}
		return { message: result.message };
	});

	pi.on("turn_start", async () => {
		// Tool-call injections use a steering message delivered before the next
		// model turn. Once that next turn starts, writes may proceed normally.
		pendingWriteGuardDirs.clear();
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as ToolInput;
		if (!input || typeof input !== "object") return undefined;

		const pathsToCheck = getPathArgsFromToolCall(event.toolName, input);
		if (pathsToCheck.length === 0) return undefined;

		await injectForPaths(pathsToCheck, ctx.cwd, `${event.toolName} tool call`, "sendMessage");
		updateStatus(ctx);

		if (
			shouldBlockFirstWrite() &&
			isWriteLikeTool(event.toolName) &&
			writeTouchesPendingContext(pathsToCheck, ctx.cwd)
		) {
			return {
				block: true,
				reason:
					"New directory-scoped context was injected during this tool batch. Re-read the injected instructions and retry this write/edit if still appropriate.",
			};
		}
		return undefined;
	});

	const showStatus = async (_args: string, ctx: any) => {
		const injected = [...injectedPaths.values()].sort();
		const native = [...nativePaths.values()].sort();
		const lines = [
			`Dynamically injected (${injected.length}):`,
			...(injected.length > 0 ? injected : ["(none)"]),
			"",
			`Known native context files (${native.length}):`,
			...(native.length > 0 ? native : ["(none recorded yet)"]),
		];
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const resetStatus = async (_args: string, ctx: any) => {
		injectedPaths.clear();
		pendingWriteGuardDirs.clear();
		updateStatus(ctx);
		ctx.ui.notify("Directory context injector in-memory dedup state cleared.", "info");
	};

	pi.registerCommand("context-files-status", {
		description: "Show dynamically injected and natively loaded context files",
		handler: showStatus,
	});
	pi.registerCommand("context-files-reset", {
		description: "Clear directory context injector in-memory dedup state",
		handler: resetStatus,
	});

	// Backward-compatible aliases for the two retired extensions.
	pi.registerCommand("agents-md-status", { description: "Alias of /context-files-status", handler: showStatus });
	pi.registerCommand("claude-md-status", { description: "Alias of /context-files-status", handler: showStatus });
	pi.registerCommand("agents-md-reset", { description: "Alias of /context-files-reset", handler: resetStatus });
	pi.registerCommand("claude-md-reset", { description: "Alias of /context-files-reset", handler: resetStatus });
}
