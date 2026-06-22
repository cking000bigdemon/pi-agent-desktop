import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
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

	pi.on("session_start", async (_event, ctx) => {
		titleRequested = sessionAlreadyHasTitle(ctx);
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
		void generateAndRecordTitle(pi, ctx, query);

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

async function generateAndRecordTitle(pi: ExtensionAPI, ctx: ExtensionContext, query: string): Promise<void> {
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

function runPi(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const command = process.platform === "win32" ? "cmd.exe" : "pi";
		const finalArgs = process.platform === "win32" ? ["/d", "/s", "/c", "pi.cmd", ...args] : args;
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
