/**
 * VariFlight Web Search for pi
 *
 * pi 引擎不原生支持服务端 web_search（provider 切 openai-responses 也只是聊天，
 * 不会自动注入 tools:[{web_search}]）。本扩展注册一个 `variflight_web_search` 工具，
 * agent 调用时通过 VariFlight AI 网关的 **Responses API**（/api/v1/responses）携带
 * 内置 web_search 工具完成联网搜索，并把带来源的答案文本返回。
 *
 * 凭证来源：直接读 ~/.pi/agent/models.json 里**已配置的 provider**（默认 `variflight`）
 * 的 apiKey + baseURL —— 不新增密钥、不硬编码。apiKey 支持字面量 / `!shell命令` /
 * 环境变量名 三种形式（与 pi 自身一致）。
 *
 * 可选环境变量：
 *   VF_WEB_SEARCH_PROVIDER  models.json 里用作凭证来源的 provider 名，默认 "variflight"
 *   VF_WEB_SEARCH_MODEL     调用的模型，默认 "azure/gpt-5.5"
 *   VF_WEB_SEARCH_TIMEOUT   单次搜索超时(ms)，默认 90000
 *
 * 无外部依赖（只用 node 内置 + 全局 fetch），不需要 npm install。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = process.env.VF_WEB_SEARCH_PROVIDER || "variflight";
const MODEL = process.env.VF_WEB_SEARCH_MODEL || "azure/gpt-5.5";
const TIMEOUT_MS = Number(process.env.VF_WEB_SEARCH_TIMEOUT) > 0 ? Number(process.env.VF_WEB_SEARCH_TIMEOUT) : 90_000;

function modelsConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "models.json");
}

// 解析 apiKey：字面量 / "!shell命令"(取 stdout) / 环境变量名
function resolveApiKey(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  if (raw.startsWith("!")) {
    try { return execSync(raw.slice(1), { encoding: "utf8" }).trim() || null; } catch { return null; }
  }
  if (/^[A-Z_][A-Z0-9_]*$/.test(raw) && process.env[raw]) return process.env[raw]!;
  return raw; // 字面量
}

type Creds = { baseURL: string; apiKey: string };

function readProviderCreds(): Creds | { error: string } {
  const p = modelsConfigPath();
  if (!fs.existsSync(p)) return { error: `models.json 不存在: ${p}` };
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { error: `models.json 解析失败: ${e instanceof Error ? e.message : String(e)}` }; }
  const prov = cfg?.providers?.[PROVIDER];
  if (!prov) return { error: `models.json 里未找到 provider "${PROVIDER}"（请先在 Models 配置里添加）` };
  const apiKey = resolveApiKey(prov.apiKey);
  if (!apiKey) return { error: `provider "${PROVIDER}" 未配置可用的 apiKey` };
  const rawBase = prov.baseURL || prov.baseUrl || prov.base_url || "https://aigateway.variflight.com/api";
  const baseURL = String(rawBase).replace(/\/+$/, "");
  return { baseURL, apiKey };
}

// Responses API 输出抽取：output[] 里 message 项的 content[].output_text 拼接
function extractText(data: any): string {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const out = Array.isArray(data?.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

async function doSearch(query: string, creds: Creds, signal?: AbortSignal): Promise<string> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${creds.baseURL}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
      body: JSON.stringify({ model: MODEL, tools: [{ type: "web_search" }], input: `联网搜索。${query}` }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`VariFlight 网关 HTTP ${res.status}: ${body.slice(0, 500)}`);
    }
    const data = await res.json();
    return extractText(data) || "(无搜索结果)";
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export default async function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "variflight_web_search",
    label: "VariFlight Web Search",
    description:
      "通过 VariFlight AI 网关进行联网搜索，返回带来源的实时答案。适用于查询最新新闻、实时数据、" +
      "需要联网核实的事实，或获取公开披露文件/页面的真实 URL。输入自然语言查询；如需链接可在 query 中要求返回来源 URL。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "自然语言搜索查询（中文/英文均可）。可在其中明确要求返回真实来源 URL、限定来源等。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const creds = readProviderCreds();
      if ("error" in creds) {
        return { content: [{ type: "text", text: `VariFlight 联网搜索不可用：${creds.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], isError: true };
      }
      try {
        const answer = await doSearch(query, creds, signal);
        return { content: [{ type: "text", text: answer }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "联网搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `VariFlight 联网搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });
}
