import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
const CUSTOM_TYPE = "auto-session-title";
const MAX_QUERY_CHARS = 4000;
const TIMEOUT_MS = 45_000;
const FALLBACK_MAX_CHARS = 40;

interface TitleEntryData {
	title: string;
	firstQuery: string;
	generatedAt: string;
	generator: "pi-subprocess" | "fallback";
	error?: string;
}

export default function (pi: ExtensionAPI) {
	let titleRequested = false;
	let runtimeActive = true;

	pi.on("session_start", async (_event, ctx) => {
		runtimeActive = true;
		titleRequested = sessionAlreadyHasTitle(ctx);
	});

	// /reload、/new、/resume 等会使当前扩展实例的 pi/ctx 立即失效。
	// 标题生成是后台异步任务，必须在旧实例关闭后丢弃结果，不能继续写会话。
	pi.on("session_shutdown", async () => {
		runtimeActive = false;
	});

	pi.on("input", async (event, ctx) => {
		if (titleRequested || sessionAlreadyHasTitle(ctx)) {
			titleRequested = true;
			return { action: "continue" as const };
		}
		if (event.source === "extension") return { action: "continue" as const };

		const query = event.text.trim();
		if (!query) return { action: "continue" as const };

		// Built-in/extension commands such as /new, /resume, /model should not name a session.
		// Prompt-template and skill commands are also skipped because at this point they have
		// not expanded yet, so they are not the user's actual task text.
		if (query.startsWith("/")) return { action: "continue" as const };

		titleRequested = true;
		void generateAndRecordTitle(pi, ctx, query, () => runtimeActive).catch((err) => {
			// reload/session replacement 与后台标题生成竞态时，旧 ctx 失效属于预期取消。
			if (!runtimeActive || isStaleExtensionContextError(err)) return;
			console.error("auto-session-title failed:", err);
		});

		return { action: "continue" as const };
	});

	pi.registerCommand("retitle", {
		description: "Generate a session title from text, or set title directly with --set <title>",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (!input) {
				ctx.ui.notify("Usage: /retitle <text> or /retitle --set <title>", "info");
				return;
			}

			if (input.startsWith("--set ")) {
				const title = sanitizeTitle(input.slice(6)) || fallbackTitle(input.slice(6));
				recordTitle(pi, ctx, title, input.slice(6), "fallback");
				ctx.ui.notify(`Session title set: ${title}`, "info");
				return;
			}

			const title = await generateTitle(input).catch(() => fallbackTitle(input));
			recordTitle(pi, ctx, title, input, "pi-subprocess");
			ctx.ui.notify(`Session title set: ${title}`, "info");
		},
	});
}

function sessionAlreadyHasTitle(ctx: ExtensionContext): boolean {
	if (ctx.sessionManager.getSessionName()) return true;
	return ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE);
}

async function generateAndRecordTitle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	query: string,
	isActive: () => boolean,
): Promise<void> {
	let title: string;
	let generator: TitleEntryData["generator"] = "pi-subprocess";
	let error: string | undefined;

	try {
		title = await generateTitle(query);
	} catch (err) {
		generator = "fallback";
		error = err instanceof Error ? err.message : String(err);
		title = fallbackTitle(query);
	}

	// 生成期间可能执行了 /reload 或切换会话；旧实例的 pi/ctx 此时不可再使用。
	if (!isActive()) return;

	recordTitle(pi, ctx, title, query, generator, error);

	if (ctx.hasUI) {
		const suffix = error ? " (fallback)" : "";
		ctx.ui.notify(`Session title: ${title}${suffix}`, error ? "warning" : "info");
	}
}

async function generateTitle(query: string): Promise<string> {
	const systemPrompt = "You are a session title generator. Output exactly one concise Chinese title only. No acknowledgements. No explanations. No markdown. No quotes. Use 4 to 18 Chinese characters if possible. Capture the user's concrete task, not generic words like 新会话 or 帮助. Do not end with punctuation.";

	const prompt = `Generate a concise title for this coding-agent session. First user query: ${query.slice(0, MAX_QUERY_CHARS)}`;

	const stdout = await runPi([
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-tools",
		"--no-context-files",
		"--system-prompt",
		systemPrompt,
		prompt,
	]);

	const title = sanitizeTitle(stdout);
	if (!title) throw new Error("pi subprocess returned an empty title");
	return title;
}

/**
 * 起标题用的子 pi 该用哪个可执行文件。
 *
 * 桌面端(Pi Agent)启动服务时会把内置 pi 包的根目录注入
 * PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT（与 pi-subagents 共用同一个变量，
 * 外壳那边已校验过 package.json）。命中就用 <本进程的 node> <该包>/dist/cli.js
 * —— 与父进程同一份 pi、同一个 node，继承同一份配置与模型认证。
 *
 * 这不是锦上添花：打包版的机器上 PATH 里往往压根没有全局 pi（子进程直接 ENOENT，
 * 标题静默退化成截断首句），装了也常常版本对不上（实测父 0.84.0 / 全局 0.81.1）。
 * 在终端里直接跑 pi 时该变量不存在，按原样回退到 PATH 查找。
 */
function piSpawnCommand(args: string[]): { command: string; args: string[] } {
	const root = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT?.trim();
	if (root) {
		const cli = path.join(root, "dist", "cli.js");
		if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args] };
	}
	// PATH 回退。Windows 上 pi 是 pi.cmd：直接 spawn("pi") 报 ENOENT、spawn("pi.cmd")
	// 报 EINVAL，所以显式经 cmd.exe 调用。
	return process.platform === "win32"
		? { command: "cmd.exe", args: ["/d", "/s", "/c", "pi.cmd", ...args] }
		: { command: "pi", args };
}

function runPi(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const { command, args: finalArgs } = piSpawnCommand(args);
		const child = spawn(command, finalArgs, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			settled = true;
			child.kill();
			reject(new Error(`pi subprocess timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(err);
		});

		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code === 0) {
				resolve(stdout);
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			reject(new Error(`pi subprocess failed with ${reason}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

function recordTitle(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	title: string,
	firstQuery: string,
	generator: TitleEntryData["generator"],
	error?: string,
): void {
	const finalTitle = sanitizeTitle(title) || fallbackTitle(firstQuery);

	pi.setSessionName(finalTitle);
	pi.appendEntry(CUSTOM_TYPE, {
		title: finalTitle,
		firstQuery,
		generatedAt: new Date().toISOString(),
		generator,
		error,
	} satisfies TitleEntryData);

	ctx.ui.setTitle(finalTitle);
}

function isStaleExtensionContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("This extension ctx is stale after session replacement or reload");
}

function sanitizeTitle(raw: string): string {
	return raw
		.trim()
		.split(/\r?\n/)[0]
		.replace(/^\s*["'“”‘’`]+|["'“”‘’`]+\s*$/g, "")
		.replace(/^标题[:：]\s*/i, "")
		.replace(/[。.!！?？；;，,、]+$/g, "")
		.trim()
		.slice(0, 80);
}

function fallbackTitle(query: string): string {
	return sanitizeTitle(query).slice(0, FALLBACK_MAX_CHARS) || "未命名会话";
}
