/**
 * MCP Bridge for pi
 *
 * pi 原生不做 MCP。本扩展扮演 MCP 客户端:启动时连接 ~/.pi/agent/mcp.json 里配置的
 * MCP server,把它们的工具注册成 pi 自定义工具(命名 mcp__<server>__<tool>,沿用
 * Claude Code 的约定),LLM 即可直接调用。退出时关闭连接,避免孤儿子进程。
 *
 * 支持 transport: stdio / http(StreamableHTTP) / sse。
 *
 * 依赖(必须先装,否则 jiti 加载失败):
 *   在 ~/.pi/agent/extensions/ 目录执行:
 *     npm install @modelcontextprotocol/sdk
 *
 * 配置文件 ~/.pi/agent/mcp.json(或用 PI_MCP_CONFIG 指定其它路径):
 *   {
 *     "mcpServers": {
 *       "filesystem": { "type": "stdio", "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/My_work_byPi"] },
 *       "context7":   { "type": "http", "url": "https://mcp.context7.com/mcp" },
 *       "example-sse":{ "type": "sse",  "url": "https://example.com/sse",
 *         "headers": { "Authorization": "Bearer xxx" } }
 *     }
 *   }
 *   每个 server 可选字段:
 *     disabled: true   跳过该 server
 *     confirm:  true   调用该 server 的工具前弹确认(等价 PI_MCP_CONFIRM=all 的单服开关)
 *     env: {...}       stdio 子进程额外环境变量(只加这些,不再继承 pi 的完整环境)
 *     cwd: "<path>"    stdio 子进程工作目录
 *     headers: {...}   http/sse 请求头
 *     timeout: <ms>    该 server 的连接超时,覆盖全局默认 15s
 *
 * 开关(环境变量):
 *   PI_MCP_CONFIG=<path>     覆盖 mcp.json 路径
 *   PI_MCP_CONFIRM=all       所有 MCP 工具调用前都确认(默认仅 server 自带 confirm:true 才确认)
 *   PI_MCP_INSTRUCTIONS=0    不把各 server 的 instructions 注入 system prompt(默认注入)
 *   PI_MCP_TIMEOUT=<ms>      每个 server 的连接超时,默认 15000;超时记为失败,不阻塞启动
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function off(v: string | undefined): boolean {
  return v === "0" || v?.toLowerCase() === "false" || v?.toLowerCase() === "no";
}

// 借 Claude Code normalizeNameForMCP:压进 API 允许的安全字符集
function norm(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function piToolName(server: string, tool: string): string {
  return `mcp__${norm(server)}__${norm(tool)}`;
}

function configPath(): string {
  return process.env.PI_MCP_CONFIG || path.join(os.homedir(), ".pi", "agent", "mcp.json");
}

function loadServers(): Record<string, any> {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return (parsed?.mcpServers ?? {}) as Record<string, any>;
  } catch (e) {
    throw new Error(`mcp.json 解析失败 (${p}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function makeTransport(cfg: any): any {
  const type = cfg.type ?? "stdio";
  if (type === "http") {
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return new StreamableHTTPClientTransport(new URL(cfg.url), opts as any);
  }
  if (type === "sse") {
    const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
    return new SSEClientTransport(new URL(cfg.url), opts as any);
  }
  // 默认 stdio。不 spread process.env:SDK 内部会自动合并 getDefaultEnvironment()
  //(PATH 等安全子集)+ 下面的 env(stdio.js:67-69)。塞完整 process.env 会把 pi 的
  // 全部环境(含任何密钥)泄露给每个 MCP 子进程,正好抵消 SDK 的过滤。
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env,
    cwd: cfg.cwd,
  });
}

// MCP CallToolResult.content → pi 工具结果 content
// text/image 真透传(pi ImageContent = {type:"image",data,mimeType},与 MCP image 块一致);
// resource 块取内嵌文本或图片;audio 等 pi 暂不支持的类型降级为文本摘要。
type OutBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function mapContent(res: any): { content: OutBlock[]; isError: boolean } {
  const blocks = Array.isArray(res?.content) ? res.content : [];
  const out: OutBlock[] = [];
  for (const c of blocks) {
    if (c?.type === "text") {
      out.push({ type: "text", text: String(c.text ?? "") });
    } else if (c?.type === "image" && typeof c.data === "string") {
      out.push({ type: "image", data: c.data, mimeType: c.mimeType ?? "image/png" });
    } else if (c?.type === "resource" && c.resource) {
      const r = c.resource;
      if (typeof r.text === "string") {
        out.push({ type: "text", text: r.text });
      } else if (typeof r.blob === "string" && typeof r.mimeType === "string" && r.mimeType.startsWith("image/")) {
        out.push({ type: "image", data: r.blob, mimeType: r.mimeType });
      } else {
        out.push({ type: "text", text: `[resource ${r.uri ?? ""}] ${JSON.stringify(r).slice(0, 2000)}` });
      }
    } else {
      out.push({ type: "text", text: `[${c?.type ?? "non-text"}] ${JSON.stringify(c).slice(0, 2000)}` });
    }
  }
  return {
    content: out.length ? out : [{ type: "text", text: "(empty result)" }],
    isError: res?.isError === true,
  };
}

async function listAllTools(client: Client): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const page: any = await client.listTools(cursor ? { cursor } : undefined);
    if (Array.isArray(page?.tools)) all.push(...page.tools);
    cursor = page?.nextCursor;
  } while (cursor);
  return all;
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

type ToolEntry = { server: string; tool: string; client: Client; confirm: boolean };
type ServerInfo = { name: string; type: string; ok: boolean; toolCount: number; error?: string };

export default async function (pi: ExtensionAPI) {
  const clients: Client[] = [];
  const registry = new Map<string, ToolEntry>(); // pi 工具名 -> 调用信息
  const serverInfos: ServerInfo[] = [];
  const instructionsBlocks: string[] = [];
  const startupLog: string[] = [];
  const confirmAll = process.env.PI_MCP_CONFIRM?.toLowerCase() === "all";

  let servers: Record<string, any> = {};
  try {
    servers = loadServers();
  } catch (e) {
    startupLog.push(e instanceof Error ? e.message : String(e));
  }

  // 每个 server 的连接超时(ms):PI_MCP_TIMEOUT 全局 / server.timeout 单服 / 默认 15s
  const defaultTimeoutMs = Number(process.env.PI_MCP_TIMEOUT) > 0 ? Number(process.env.PI_MCP_TIMEOUT) : 15000;

  async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function connectServer(server: string, cfg: any): Promise<void> {
    const type = cfg?.type ?? "stdio";
    if (cfg?.disabled) {
      serverInfos.push({ name: server, type, ok: false, toolCount: 0, error: "disabled" });
      return;
    }
    const client = new Client({ name: "pi-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
    const ms = Number(cfg?.timeout) > 0 ? Number(cfg.timeout) : defaultTimeoutMs;
    try {
      // 加超时:任一 server 挂起也不会卡死 pi 启动(工厂被 pi await)
      await withTimeout(client.connect(makeTransport(cfg)), ms, `连接 ${server}`);
      clients.push(client);

      // server 自报的 instructions(若有)→ 收集,稍后注入 system prompt
      const serverInstr = (client.getInstructions?.() as string | undefined) ?? undefined;
      if (serverInstr && serverInstr.trim()) {
        instructionsBlocks.push(`## ${server}\n${serverInstr.trim()}`);
      }

      const needsConfirm = confirmAll || cfg?.confirm === true;
      const tools = await withTimeout(listAllTools(client), ms, `列出 ${server} 工具`);
      let registered = 0;
      for (const t of tools) {
        const name = piToolName(server, t.name);
        if (registry.has(name)) {
          startupLog.push(`跳过重名工具 ${name}(来自 ${server})`);
          continue;
        }
        registry.set(name, { server, tool: t.name, client, confirm: needsConfirm });
        pi.registerTool({
          name,
          label: `${server}: ${t.name}`,
          description: t.description ?? t.name,
          // pi-ai 校验双路径支持纯 JSON Schema(validation.js),MCP inputSchema 原样可用
          parameters: t.inputSchema ?? { type: "object", properties: {} },
          async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
            try {
              const res = await client.callTool(
                { name: t.name, arguments: params ?? {} },
                undefined,
                signal ? { signal } : undefined,
              );
              return mapContent(res);
            } catch (e) {
              return {
                content: [{ type: "text", text: `MCP 调用失败 (${server}/${t.name}): ${e instanceof Error ? e.message : String(e)}` }],
                isError: true,
              };
            }
          },
        });
        registered++;
      }
      serverInfos.push({ name: server, type, ok: true, toolCount: registered });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      serverInfos.push({ name: server, type, ok: false, toolCount: 0, error: msg });
      startupLog.push(`MCP ${server} 连接失败: ${msg}`);
      try { await client.close(); } catch { /* ignore */ }
    }
  }

  // 并行连接所有 server(allSettled:任一失败/超时不影响其它,也不阻塞 pi 启动)
  await Promise.allSettled(Object.entries(servers).map(([server, cfg]) => connectServer(server, cfg)));

  // 启动后把连接结果反馈给用户(工厂里没有 ctx,放到 session_start)
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const ok = serverInfos.filter((s) => s.ok);
    const total = ok.reduce((n, s) => n + s.toolCount, 0);
    if (ctx.hasUI) {
      ctx.ui.setStatus("mcp", `MCP: ${ok.length} server / ${total} tools`);
      if (ok.length > 0) ctx.ui.notify(`MCP 已桥接 ${ok.length} 个 server,共 ${total} 个工具`, "info");
      for (const line of startupLog) ctx.ui.notify(line, "warning");
    }
  });

  // 注入各 server 的 instructions(默认开,PI_MCP_INSTRUCTIONS=0 关)
  pi.on("before_agent_start", async (event) => {
    if (off(process.env.PI_MCP_INSTRUCTIONS) || instructionsBlocks.length === 0) return undefined;
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n# MCP Server Instructions\n` +
        `The following MCP servers provided usage instructions for their tools:\n\n` +
        instructionsBlocks.join("\n\n"),
    };
  });

  // 确认闸门:对需要确认的 mcp__ 工具,调用前弹确认;无 UI 时放行(避免 headless 死锁)
  pi.on("tool_call", async (event, ctx) => {
    const entry = registry.get(event.toolName);
    if (!entry || !entry.confirm) return undefined;
    if (!ctx.hasUI) return undefined; // 无 UI 不阻断
    const preview = JSON.stringify(event.input ?? {}).slice(0, 300);
    const okToRun = await ctx.ui.confirm(
      `运行 MCP 工具 ${entry.server}/${entry.tool}?`,
      `参数: ${preview}`,
    );
    if (!okToRun) {
      return { block: true, reason: `用户取消了 MCP 工具 ${event.toolName} 的调用。` };
    }
    return undefined;
  });

  // 退出时关闭所有连接(对应 CC 的 cleanup,杀掉 stdio 子进程)
  pi.on("session_shutdown", async () => {
    for (const c of clients) {
      try { await c.close(); } catch { /* ignore */ }
    }
  });

  pi.registerCommand("mcp", {
    description: "列出已桥接的 MCP server 与工具",
    handler: async (_args, ctx) => {
      const lines: string[] = [`配置文件: ${configPath()}`, ""];
      if (serverInfos.length === 0) {
        lines.push("(mcp.json 未配置任何 server)");
      } else {
        for (const s of serverInfos) {
          lines.push(`${s.ok ? "✓" : "✗"} ${s.name} [${s.type}] — ${s.ok ? `${s.toolCount} tools` : s.error}`);
          if (s.ok) {
            for (const [name, e] of registry) {
              if (e.server === s.name) lines.push(`    - ${name}${e.confirm ? "  (需确认)" : ""}`);
            }
          }
        }
      }
      ctx.ui.notify(lines.join("\n"), serverInfos.some((s) => !s.ok && s.error !== "disabled") ? "warning" : "info");
    },
  });
}
