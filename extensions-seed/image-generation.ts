/**
 * Image Generation for pi —— 生图工具插件
 *
 * pi 引擎本身没有生图（图片输出）通路：它对模型只走 chat/completions、responses、
 * messages、generateContent，响应侧只解析文本 + tool_calls，不会调用 images 端点、
 * 也不会读取 message.images。所以把生图模型写进 models.json 当"模型"用是拿不到图的。
 * 本扩展用自定义工具补齐这一能力，让 agent 通过工具调用来生图并落盘。
 *
 * 注册两个工具（对应 DMIT CLIProxyAPI 反代里的两条生图链路，均已实测）：
 *
 *  1) `generate_image_gpt`     —— OpenAI gpt-image-2，走 POST /v1/images/generations，
 *     返回 data[0].b64_json（PNG base64）。适合写实/通用生图、指定尺寸。
 *
 *  2) `generate_image_gemini`  —— gemini-3.1-flash-image，走 POST /v1/chat/completions，
 *     图片在 choices[0].message.images[0].image_url.url（data:image/...;base64, 内联）。
 *     适合按自然语言对话式描述生图。
 *
 * 生成的图片保存到【当前 workspace】的 ai-output/temporary/pictures/ 目录下，
 * 文件名带时间戳 + 模型标识 + 序号，不会互相覆盖。返回给 agent 的是保存后的
 * 相对/绝对路径（不是把 base64 塞回对话，避免污染上下文）。
 *
 * === 凭证来源 ===
 * 读 ~/.pi/agent/models.json 里【已配置的 provider】(默认 cliproxy-dmit) 的
 * apiKey + baseUrl —— 不新增密钥、不硬编码。apiKey 三态：字面量 / "!shell命令"(取
 * stdout) / 环境变量名（与 pi 自身及 variflight-web-search 扩展一致）。
 *
 * === 可选环境变量 ===
 *   IMAGE_GEN_PROVIDER    models.json 里用作凭证来源的 provider 名，默认 "cliproxy-dmit"
 *   IMAGE_GEN_GPT_MODEL   generate_image_gpt 用的模型，默认 "gpt-image-2"
 *   IMAGE_GEN_GEMINI_MODEL generate_image_gemini 用的模型，默认 "gemini-3.1-flash-image"
 *   IMAGE_GEN_TIMEOUT     单次生图超时(ms)，默认 180000（3 分钟，生图较慢）
 *   IMAGE_GEN_OUTPUT_DIR  覆盖输出目录（相对 cwd 或绝对路径），默认 ai-output/temporary/pictures
 *
 * 无外部依赖（只用 node 内置 + 全局 fetch），不需要 npm install。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = process.env.IMAGE_GEN_PROVIDER || "cliproxy-dmit";
const GPT_MODEL = process.env.IMAGE_GEN_GPT_MODEL || "gpt-image-2";
const GEMINI_MODEL = process.env.IMAGE_GEN_GEMINI_MODEL || "gemini-3.1-flash-image";
const TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT) > 0 ? Number(process.env.IMAGE_GEN_TIMEOUT) : 180_000;
const DEFAULT_OUTPUT_SUBDIR = "ai-output/temporary/pictures";

function modelsConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}

// 解析 apiKey：字面量 / "!shell命令"(取 stdout) / 环境变量名（三态，与 pi 一致）
function resolveApiKey(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (raw.startsWith("!")) {
    try {
      return execSync(raw.slice(1), { encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(raw) && process.env[raw]) return process.env[raw]!;
  return raw; // 字面量
}

type Creds = { baseURL: string; apiKey: string };

// 从 models.json 读取 provider 的 baseUrl + apiKey（不硬编码密钥）
function readProviderCreds(): Creds | { error: string } {
  const p = modelsConfigPath();
  if (!fs.existsSync(p)) return { error: `models.json 不存在: ${p}` };
  let cfg: any;
  try {
    cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { error: `models.json 解析失败: ${e instanceof Error ? e.message : String(e)}` };
  }
  const prov = cfg?.providers?.[PROVIDER];
  if (!prov) return { error: `models.json 里未找到 provider "${PROVIDER}"（请先在 Models 配置里添加）` };
  const apiKey = resolveApiKey(prov.apiKey);
  if (!apiKey) return { error: `provider "${PROVIDER}" 未配置可用的 apiKey` };
  const baseURL = String(prov.baseUrl || "").replace(/\/+$/, "");
  if (!baseURL) return { error: `provider "${PROVIDER}" 未配置 baseUrl` };
  return { baseURL, apiKey };
}

// 解析输出目录（相对 cwd 或绝对路径），确保存在后返回绝对路径
function resolveOutputDir(ctx: ExtensionContext): string {
  const raw = process.env.IMAGE_GEN_OUTPUT_DIR || DEFAULT_OUTPUT_SUBDIR;
  const abs = path.isAbsolute(raw) ? raw : path.join(ctx.cwd, raw);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

// 时间戳片段：YYYYMMDD-HHMMSS
function timestamp(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

// 从 prompt 生成一个安全的文件名片段（截断，去掉特殊字符）
function slugFromPrompt(prompt: string): string {
  const cleaned = prompt
    .replace(/[\r\n]+/g, " ")
    .replace(/[^\p{L}\p{N}\- ]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return cleaned.slice(0, 40) || "image";
}

// base64（可能带 data: 前缀）解出扩展名与纯 base64
function parseBase64(raw: string): { ext: string; b64: string } {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(raw);
  if (m) {
    let ext = m[1].toLowerCase();
    if (ext === "jpeg") ext = "jpg";
    return { ext, b64: m[2] };
  }
  // 无前缀：按内容猜扩展名（PNG 头 iVBOR，JPEG 头 /9j/）
  const ext = raw.startsWith("iVBOR") ? "png" : raw.startsWith("/9j/") ? "jpg" : "png";
  return { ext, b64: raw };
}

type SavedImage = { path: string; bytes: number };

function saveImage(outDir: string, tag: string, prompt: string, index: number, rawB64: string): SavedImage {
  const { ext, b64 } = parseBase64(rawB64);
  const buf = Buffer.from(b64, "base64");
  const name = `${timestamp()}_${tag}_${slugFromPrompt(prompt)}_${index + 1}.${ext}`;
  const full = path.join(outDir, name);
  fs.writeFileSync(full, buf);
  return { path: full, bytes: buf.length };
}

// 带超时的 fetch（叠加外部 signal 与内部 timeout）
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
): Promise<Response> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

// ---- gpt-image-2: POST /v1/images/generations -> data[].b64_json ----
async function generateGpt(
  prompt: string,
  size: string,
  n: number,
  creds: Creds,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const body: Record<string, unknown> = { model: GPT_MODEL, prompt, n };
  if (size && size !== "auto") body.size = size;
  const resp = await fetchWithTimeout(
    `${creds.baseURL}/images/generations`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    signal,
  );
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON: ${text.slice(0, 300)}`);
  }
  if (json?.error) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error).slice(0, 500));
  const data = Array.isArray(json?.data) ? json.data : [];
  const out = data.map((d: any) => d?.b64_json).filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
  if (out.length === 0) throw new Error(`响应里没有图片数据（data[].b64_json 为空）`);
  return out;
}

// ---- gemini-3.1-flash-image: POST /v1/chat/completions -> message.images[].image_url.url ----
async function generateGemini(
  prompt: string,
  creds: Creds,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const resp = await fetchWithTimeout(
    `${creds.baseURL}/chat/completions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    signal,
  );
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 500)}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应非 JSON: ${text.slice(0, 300)}`);
  }
  if (json?.error) throw new Error(typeof json.error === "string" ? json.error : JSON.stringify(json.error).slice(0, 500));
  const msg = json?.choices?.[0]?.message;
  const images = Array.isArray(msg?.images) ? msg.images : [];
  const out = images
    .map((im: any) => im?.image_url?.url)
    .filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
  if (out.length === 0) {
    const note = typeof msg?.content === "string" && msg.content ? `（模型仅返回文本：${msg.content.slice(0, 200)}）` : "";
    throw new Error(`响应里没有图片数据（choices[0].message.images 为空）${note}`);
  }
  return out;
}

function relTo(ctx: ExtensionContext, abs: string): string {
  const rel = path.relative(ctx.cwd, abs);
  return rel.startsWith("..") ? abs : rel.split(path.sep).join("/");
}

export default function imageGeneration(pi: ExtensionAPI) {
  // ---------------------------------------------------------------------
  // 工具 1：generate_image_gpt（OpenAI gpt-image-2，/v1/images/generations）
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "generate_image_gpt",
    label: "生图 (gpt-image-2)",
    description:
      "用 OpenAI gpt-image-2 模型根据文本描述生成图片，保存到当前 workspace 的 " +
      "ai-output/temporary/pictures/ 目录，返回保存路径。适合写实、通用、可指定尺寸的生图需求。" +
      "prompt 用英文通常质量更好，但中文也可。",
    promptSnippet: "根据文本描述用 gpt-image-2 生成图片并保存到 workspace",
    promptGuidelines: [
      "当用户要求生成/绘制图片且倾向写实或需要指定尺寸时，用 generate_image_gpt。",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片内容的文本描述（英文质量通常更好，中文亦可）。",
        },
        size: {
          type: "string",
          description: "图片尺寸，如 1024x1024 / 1024x1536 / 1536x1024 / auto。默认 1024x1024。",
        },
        n: {
          type: "number",
          description: "生成张数，默认 1（1-4）。",
        },
      },
      required: ["prompt"],
    },
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const creds = readProviderCreds();
      if ("error" in creds) {
        return { content: [{ type: "text", text: `生图不可用：${creds.error}` }], isError: true };
      }
      const prompt = String(params?.prompt ?? "").trim();
      if (!prompt) return { content: [{ type: "text", text: "prompt 不能为空" }], isError: true };
      const size = String(params?.size ?? "1024x1024").trim() || "1024x1024";
      let n = Number(params?.n);
      if (!Number.isFinite(n) || n < 1) n = 1;
      if (n > 4) n = 4;

      try {
        const outDir = resolveOutputDir(ctx);
        const b64s = await generateGpt(prompt, size, n, creds, signal);
        const saved = b64s.map((b64, i) => saveImage(outDir, "gpt-image-2", prompt, i, b64));
        const lines = saved.map((s) => `- ${relTo(ctx, s.path)} (${(s.bytes / 1024).toFixed(0)} KB)`);
        return {
          content: [{ type: "text", text: `已生成 ${saved.length} 张图片，保存到：\n${lines.join("\n")}` }],
          details: { model: GPT_MODEL, size, files: saved.map((s) => s.path) },
          isError: false,
        };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "生图已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `生图失败（${GPT_MODEL}）：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // ---------------------------------------------------------------------
  // 工具 2：generate_image_gemini（gemini-3.1-flash-image，/v1/chat/completions）
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "generate_image_gemini",
    label: "生图 (gemini-3.1-flash-image)",
    description:
      "用 gemini-3.1-flash-image 模型根据文本描述生成图片，保存到当前 workspace 的 " +
      "ai-output/temporary/pictures/ 目录，返回保存路径。适合对话式/创意描述生图。中文描述友好。",
    promptSnippet: "根据文本描述用 gemini-3.1-flash-image 生成图片并保存到 workspace",
    promptGuidelines: [
      "当用户要求生成/绘制图片且偏创意或用中文自然语言描述时，可用 generate_image_gemini。",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片内容的文本描述（中英文均可）。",
        },
      },
      required: ["prompt"],
    },
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
      const creds = readProviderCreds();
      if ("error" in creds) {
        return { content: [{ type: "text", text: `生图不可用：${creds.error}` }], isError: true };
      }
      const prompt = String(params?.prompt ?? "").trim();
      if (!prompt) return { content: [{ type: "text", text: "prompt 不能为空" }], isError: true };

      try {
        const outDir = resolveOutputDir(ctx);
        const urls = await generateGemini(prompt, creds, signal);
        const saved = urls.map((u, i) => saveImage(outDir, "gemini-flash-image", prompt, i, u));
        const lines = saved.map((s) => `- ${relTo(ctx, s.path)} (${(s.bytes / 1024).toFixed(0)} KB)`);
        return {
          content: [{ type: "text", text: `已生成 ${saved.length} 张图片，保存到：\n${lines.join("\n")}` }],
          details: { model: GEMINI_MODEL, files: saved.map((s) => s.path) },
          isError: false,
        };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "生图已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `生图失败（${GEMINI_MODEL}）：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // 状态查询命令
  pi.registerCommand("image-gen", {
    description: "显示生图工具的 provider / 模型 / 输出目录配置",
    handler: async (_args, ctx) => {
      const creds = readProviderCreds();
      const lines = [
        `凭证 provider: ${PROVIDER}`,
        "error" in creds ? `  状态: 不可用 — ${creds.error}` : `  baseUrl: ${creds.baseURL}  (apiKey 已就绪)`,
        `gpt 工具模型: ${GPT_MODEL}`,
        `gemini 工具模型: ${GEMINI_MODEL}`,
        `输出目录: ${resolveOutputDir(ctx)}`,
        `单次超时: ${TIMEOUT_MS} ms`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
