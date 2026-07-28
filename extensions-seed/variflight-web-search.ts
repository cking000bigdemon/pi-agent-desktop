/**
 * Web Search for pi —— 通用联网搜索插件
 *
 * 本扩展注册三个互补的联网搜索工具，agent 应根据实际任务需要和成本选择：
 *
 *  1) `variflight_web_search`  —— 默认首选、**免费**。走 VariFlight AI 网关的
 *     **Responses API**（/v1/responses）携带内置 web_search 工具，返回“带来源的
 *     prose 答案”。适合要一句话结论 / 已综合好的回答，也是日常默认的搜索入口。
 *
 *  2) `perplexity_search`      —— **收费 $0.005/次**（仅按请求次数，无 token 费）。
 *     直连 Perplexity **Search API**（https://api.perplexity.ai/search，POST），
 *     返回“结构化 ranked results”（title / url / snippet / date），不做 LLM 综述。
 *     适合要多条真实来源 URL、按域名/语言/地区过滤、多角度检索。
 *
 *  3) `perplexity_pro_search`  —— **收费 $0.008/次 + Sonar Pro token 费**，最贵。
 *     走 Perplexity **Sonar Pro 聊天补全**（/chat/completions，流式 + search_type=pro），
 *     模型自动多步检索 + 抓取页面内容后生成“带引用的深度 prose 答案”。
 *     仅在需要多步推理、复杂跨源综合时才用；简单查询不要用它（贵且慢）。
 *
 * pi 引擎不原生支持服务端 web_search（provider 切 openai-responses 也只是聊天，
 * 不会自动注入 tools:[{web_search}]），所以这里用自定义工具补齐能力。
 *
 * === 凭证来源 ===
 * variflight_web_search：读 ~/.pi/agent/models.json 里**已配置的 provider**
 *   （默认 `variflight`）的 apiKey + baseURL —— 不新增密钥、不硬编码。
 * perplexity_search / perplexity_pro_search：优先读环境变量 PERPLEXITY_API_KEY；
 *   若无，则回退读 models.json 里名为 `perplexity` 的 provider 的 apiKey。
 * apiKey 三态：字面量 / `!shell命令`(取 stdout) / 环境变量名（与 pi 自身一致）。
 *
 * === 可选环境变量 ===
 *   VF_WEB_SEARCH_PROVIDER  models.json 里用作凭证来源的 provider 名，默认 "variflight"
 *   VF_WEB_SEARCH_MODEL     variflight_web_search 调用的模型，默认 "azure/gpt-5.5"
 *   VF_WEB_SEARCH_TIMEOUT   单次搜索超时(ms)，默认 90000（三个工具共用）
 *   PERPLEXITY_API_KEY      Perplexity 密钥（search 与 pro search 共用，首选来源）
 *   PERPLEXITY_PROVIDER     models.json 里 Perplexity 凭证兜底的 provider 名，默认 "perplexity"
 *   PERPLEXITY_BASE_URL     Perplexity API base，默认 "https://api.perplexity.ai"
 *   PERPLEXITY_PRO_MODEL    pro search 用的 Sonar 模型，默认 "sonar-pro"
 *   PERPLEXITY_PRO_TIMEOUT  pro search 单次超时(ms)，默认 180000（多步推理较慢）
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
// Pro Search 多步推理较慢，单独给更长超时（默认 180s）
const PRO_TIMEOUT_MS = Number(process.env.PERPLEXITY_PRO_TIMEOUT) > 0 ? Number(process.env.PERPLEXITY_PRO_TIMEOUT) : 180_000;

// Perplexity Search API 相关
const PPLX_PROVIDER = process.env.PERPLEXITY_PROVIDER || "perplexity";
const PPLX_BASE_URL = (process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai").replace(/\/+$/, "");
// Perplexity Pro Search（Sonar Pro 聊天补全）相关
const PPLX_PRO_MODEL = process.env.PERPLEXITY_PRO_MODEL || "sonar-pro";

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

// ============================================================================
// Perplexity Search API
// ============================================================================

// 读取 Perplexity apiKey：优先环境变量 PERPLEXITY_API_KEY，其次 models.json 里
// 名为 PPLX_PROVIDER 的 provider（沿用三态 resolveApiKey）。
function readPerplexityApiKey(): { apiKey: string } | { error: string } {
  const fromEnv = process.env.PERPLEXITY_API_KEY;
  if (fromEnv && fromEnv.trim()) return { apiKey: fromEnv.trim() };

  const p = modelsConfigPath();
  if (!fs.existsSync(p)) {
    return { error: `未设置环境变量 PERPLEXITY_API_KEY，且 models.json 不存在: ${p}` };
  }
  let cfg: any;
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { return { error: `models.json 解析失败: ${e instanceof Error ? e.message : String(e)}` }; }
  const prov = cfg?.providers?.[PPLX_PROVIDER];
  if (!prov) {
    return { error: `未设置环境变量 PERPLEXITY_API_KEY，且 models.json 里未找到 provider "${PPLX_PROVIDER}"` };
  }
  const apiKey = resolveApiKey(prov.apiKey);
  if (!apiKey) return { error: `provider "${PPLX_PROVIDER}" 未配置可用的 apiKey` };
  return { apiKey };
}

type PplxParams = {
  query: string;
  queries?: string[];
  max_results?: number;
  country?: string;
  search_domain_filter?: string[];
  search_language_filter?: string[];
  search_context_size?: "low" | "medium" | "high";
  max_tokens?: number;
  max_tokens_per_page?: number;
};

type PplxResult = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string | null;
  last_updated?: string | null;
};

// 组装请求体，处理 search_context_size 与 max_tokens/max_tokens_per_page 的互斥。
function buildPplxBody(params: PplxParams): Record<string, unknown> {
  const queries = Array.isArray(params.queries) ? params.queries.filter((q) => typeof q === "string" && q.trim()) : [];
  const query: string | string[] = queries.length > 0 ? queries.slice(0, 5) : params.query;

  const body: Record<string, unknown> = { query };
  if (Number.isFinite(params.max_results)) {
    body.max_results = Math.min(Math.max(1, Math.trunc(params.max_results as number)), 20);
  }
  if (params.country && params.country.trim()) body.country = params.country.trim();
  if (Array.isArray(params.search_domain_filter) && params.search_domain_filter.length) {
    body.search_domain_filter = params.search_domain_filter.slice(0, 20);
  }
  if (Array.isArray(params.search_language_filter) && params.search_language_filter.length) {
    body.search_language_filter = params.search_language_filter.slice(0, 10);
  }

  const hasManualBudget = Number.isFinite(params.max_tokens) || Number.isFinite(params.max_tokens_per_page);
  if (hasManualBudget) {
    // 手动 token 预算优先；与 search_context_size 互斥，故忽略后者。
    if (Number.isFinite(params.max_tokens)) body.max_tokens = Math.trunc(params.max_tokens as number);
    if (Number.isFinite(params.max_tokens_per_page)) body.max_tokens_per_page = Math.trunc(params.max_tokens_per_page as number);
  } else if (params.search_context_size) {
    body.search_context_size = params.search_context_size;
  }
  return body;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + `…(已截断，共 ${text.length} 字符)`;
}

// 把结构化 ranked results 渲染成便于阅读的文本。
function formatPplxResults(data: any, body: Record<string, unknown>): string {
  const results: PplxResult[] = Array.isArray(data?.results) ? data.results : [];
  const q = body.query;
  const header = Array.isArray(q)
    ? `Perplexity 多查询搜索（${q.length} 条），返回 ${results.length} 个结果：`
    : `Perplexity 搜索「${String(q)}」，返回 ${results.length} 个结果：`;
  if (!results.length) return `${header}\n(无结果)`;

  const lines: string[] = [header, ""];
  results.forEach((r, i) => {
    const title = (r.title || "(无标题)").trim();
    const url = (r.url || "").trim();
    const meta: string[] = [];
    if (r.date) meta.push(`发布 ${r.date}`);
    if (r.last_updated) meta.push(`更新 ${r.last_updated}`);
    lines.push(`${i + 1}. ${title}`);
    if (url) lines.push(`   URL: ${url}`);
    if (meta.length) lines.push(`   ${meta.join(" | ")}`);
    const snippet = (r.snippet || "").trim();
    if (snippet) lines.push(`   摘要: ${truncate(snippet, 1200)}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

async function perplexitySearch(
  params: PplxParams,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = buildPplxBody(params);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PPLX_BASE_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Perplexity HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    const data = await res.json();
    return formatPplxResults(data, body);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// ============================================================================
// Perplexity Pro Search（Sonar Pro 聊天补全，流式 + search_type=pro）
// 官方要求：model=sonar-pro + stream=true + web_search_options.search_type="pro"，
// 否则会退化为普通 Sonar Pro（不触发 Pro Search）。返回带引用的 prose 答案。
// ============================================================================

type PplxProParams = {
  query: string;
  search_mode?: "web" | "academic" | "sec";
  search_domain_filter?: string[];
  country?: string;
};

function buildProBody(params: PplxProParams): Record<string, unknown> {
  const webSearchOptions: Record<string, unknown> = { search_type: "pro" };
  if (params.country && params.country.trim()) {
    webSearchOptions.user_location = { country: params.country.trim() };
  }
  const body: Record<string, unknown> = {
    model: PPLX_PRO_MODEL,
    stream: true,
    messages: [{ role: "user", content: params.query }],
    web_search_options: webSearchOptions,
  };
  if (params.search_mode) body.search_mode = params.search_mode;
  if (Array.isArray(params.search_domain_filter) && params.search_domain_filter.length) {
    body.search_domain_filter = params.search_domain_filter.slice(0, 20);
  }
  return body;
}

// 解析 SSE 流：拼接 delta.content，并从最后的 chunk 里取 search_results / citations。
async function readSonarStream(res: Response): Promise<string> {
  if (!res.body) throw new Error("Sonar 流式响应无 body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let citations: string[] = [];
  let searchResults: Array<{ title?: string; url?: string; date?: string | null }> = [];

  const handleEvent = (jsonStr: string) => {
    if (!jsonStr || jsonStr === "[DONE]") return;
    let evt: any;
    try { evt = JSON.parse(jsonStr); } catch { return; }
    const delta = evt?.choices?.[0]?.delta?.content;
    if (typeof delta === "string") answer += delta;
    const msg = evt?.choices?.[0]?.message?.content;
    if (typeof msg === "string" && msg.length > answer.length) answer = msg;
    if (Array.isArray(evt?.citations)) citations = evt.citations;
    if (Array.isArray(evt?.search_results)) searchResults = evt.search_results;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分隔事件；逐行取 "data:" 载荷
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) handleEvent(trimmed.slice(5).trim());
    }
  }
  if (buffer.trim().startsWith("data:")) handleEvent(buffer.trim().slice(5).trim());

  answer = answer.trim();
  const parts: string[] = [answer || "(无回答内容)"];
  const sources = searchResults.length
    ? searchResults.map((r, i) => `[${i + 1}] ${(r.title || "").trim()} ${r.url || ""}`.trim())
    : citations.map((c, i) => `[${i + 1}] ${c}`);
  if (sources.length) parts.push("", "来源：", ...sources);
  return parts.join("\n").trim();
}

async function perplexityProSearch(
  params: PplxProParams,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = buildProBody(params);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), PRO_TIMEOUT_MS);
  try {
    const res = await fetch(`${PPLX_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Perplexity Pro HTTP ${res.status}: ${errText.slice(0, 500)}`);
    }
    return await readSonarStream(res);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export default async function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "variflight_web_search",
    label: "Web Search (VariFlight, 免费)",
    description:
      "【默认首选・免费】通用联网搜索入口。通过 VariFlight AI 网关联网搜索，返回带来源的实时 prose 答案。" +
      "适用于绝大多数日常搜索：查询最新新闻、实时数据、联网核实事实、获取公开披露文件/页面的真实 URL。" +
      "成本：免费。输入自然语言查询；如需链接可在 query 中要求返回来源 URL。" +
      "选择建议：除非明确需要多条结构化来源（用 perplexity_search）或复杂多步深度研究（用 perplexity_pro_search），否则优先用本工具。",
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

  // --------------------------------------------------------------------------
  // Perplexity Search API：返回结构化 ranked results（title/url/snippet/date）
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search ($0.005/次)",
    description:
      "【收费：$0.005/次请求，仅按请求计费、无 token 额外费】通过 Perplexity Search API 获取结构化、" +
      "按相关性排序的实时网页搜索结果（每条含 title / url / snippet / date）。适用于需要多条真实来源 URL、" +
      "按域名/语言/地区过滤、多角度（多查询）检索的场景。支持多查询（queries，最多 5 条）与预算控制。" +
      "选择建议：仅当任务确实需要多条可核实的排序来源时才用；若只要一句话结论请用（免费的）variflight_web_search；" +
      "若需多步推理的深度综合回答请用 perplexity_pro_search。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "单条搜索查询（中文/英文均可）。多查询时可留空并改用 queries。",
        },
        queries: {
          type: "array",
          items: { type: "string" },
          description: "多查询列表（最多 5 条）；提供后优先于 query，结果按查询顺序合并返回。",
        },
        max_results: {
          type: "number",
          description: "返回结果数量，取值 1-20，默认由服务端决定（通常 10）。",
        },
        country: {
          type: "string",
          description: "ISO 3166-1 alpha-2 国家码（如 US、GB、DE、JP、CN），用于地区化结果。",
        },
        search_domain_filter: {
          type: "array",
          items: { type: "string" },
          description:
            "域名过滤（最多 20 个）。白名单直接写域名（如 nature.com、nature.com/articles）；" +
            "黑名单加 - 前缀（如 -reddit.com）。白名单与黑名单不能混用。",
        },
        search_language_filter: {
          type: "array",
          items: { type: "string" },
          description: "语言过滤（最多 10 个），ISO 639-1 两字母码（如 en、zh、fr、de）。",
        },
        search_context_size: {
          type: "string",
          enum: ["low", "medium", "high"],
          description:
            "每页正文抽取量：low 精简、medium 均衡、high 详细（默认）。不能与 max_tokens/max_tokens_per_page 同时使用。",
        },
        max_tokens: {
          type: "number",
          description: "所有结果正文的总 token 上限（最高 1,000,000）。与 search_context_size 互斥，提供后优先。",
        },
        max_tokens_per_page: {
          type: "number",
          description: "单页正文抽取的 token 上限。与 search_context_size 互斥，提供后优先。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const cred = readPerplexityApiKey();
      if ("error" in cred) {
        return { content: [{ type: "text", text: `Perplexity 搜索不可用：${cred.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      const queries = Array.isArray(params?.queries)
        ? params.queries.map((q: unknown) => String(q ?? "").trim()).filter(Boolean)
        : [];
      if (!query && queries.length === 0) {
        return { content: [{ type: "text", text: "query 或 queries 至少提供一个" }], isError: true };
      }
      try {
        const text = await perplexitySearch(
          {
            query: query || queries[0],
            queries,
            max_results: params?.max_results,
            country: params?.country,
            search_domain_filter: params?.search_domain_filter,
            search_language_filter: params?.search_language_filter,
            search_context_size: params?.search_context_size,
            max_tokens: params?.max_tokens,
            max_tokens_per_page: params?.max_tokens_per_page,
          },
          cred.apiKey,
          signal,
        );
        return { content: [{ type: "text", text }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "Perplexity 搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Perplexity 搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // --------------------------------------------------------------------------
  // Perplexity Pro Search（Sonar Pro 流式多步检索，返回带引用的深度 prose 答案）
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "perplexity_pro_search",
    label: "Perplexity Pro Search ($0.008/次 + token)",
    description:
      "【收费：$0.008/次 Pro Search 请求 + Sonar Pro 的 token 费（输入/输出按量计费），三个搜索工具中最贵】" +
      "走 Perplexity Sonar Pro 聊天补全（流式 + search_type=pro），模型会自动多步检索、抓取页面内容并多轮推理，" +
      "最终生成带引用的深度综合答案。仅适用于需要跨多个来源多步推理的复杂问题（如专题调研、多因素对比、需边搜边推导的任务）。" +
      "选择建议：简单事实/新闻查询不要用它（贵且慢），改用免费的 variflight_web_search；" +
      "只要一批可核实的排序链接用 perplexity_search（$0.005/次）。除非任务确实需要深度多步研究，否则不要选本工具。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "需要多步推理/深度综合的复杂问题（中文/英文均可）。描述越具体，多步检索效果越好。",
        },
        search_mode: {
          type: "string",
          enum: ["web", "academic", "sec"],
          description: "搜索来源域：web（默认全网）、academic（学术）、sec（美股 SEC 披露文件）。",
        },
        country: {
          type: "string",
          description: "ISO 3166-1 alpha-2 国家码（如 US、CN），用于地区化搜索。",
        },
        search_domain_filter: {
          type: "array",
          items: { type: "string" },
          description:
            "域名过滤（最多 20 个）。白名单直接写域名；黑名单加 - 前缀（如 -reddit.com）。",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const cred = readPerplexityApiKey();
      if ("error" in cred) {
        return { content: [{ type: "text", text: `Perplexity Pro 搜索不可用：${cred.error}` }], isError: true };
      }
      const query = String(params?.query ?? "").trim();
      if (!query) {
        return { content: [{ type: "text", text: "query 不能为空" }], isError: true };
      }
      try {
        const text = await perplexityProSearch(
          {
            query,
            search_mode: params?.search_mode,
            country: params?.country,
            search_domain_filter: params?.search_domain_filter,
          },
          cred.apiKey,
          signal,
        );
        return { content: [{ type: "text", text }], isError: false };
      } catch (e) {
        if ((e as any)?.name === "AbortError") {
          return { content: [{ type: "text", text: "Perplexity Pro 搜索已取消或超时" }], isError: true };
        }
        return {
          content: [{ type: "text", text: `Perplexity Pro 搜索失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });
}
