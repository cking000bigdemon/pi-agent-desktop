/**
 * Vision Fallback — 图片输入自动切换到多模态模型
 *
 * 当用户输入附带图片、而当前模型不支持图像输入(如 DeepSeek V4 Flash,
 * 仅 text)时,自动把这一轮 agent 任务切换到配置好的多模态模型;
 * 该轮 agent 完全结束后(agent_settled)自动切回原模型与思考级别。
 *
 * 机制:
 * - input 事件:检测 event.images,若当前模型 input 不含 "image",
 *   从候选列表(按序)或全量模型中找一个支持图片的模型,pi.setModel() 切换
 * - agent_settled 事件:本轮已不会再自动继续,恢复原模型 + 原 thinking level
 * - 连续图片轮安全:切换后(switched=true)不再重复切换;结束后才恢复
 *
 * 候选模型可用环境变量覆盖(逗号分隔 provider/modelId 对,分号分隔条目):
 *   VISION_MODEL_PREFERENCE="cliproxy-dmit/gpt-5.6-sol;cliproxy-dmit/gpt-5.6-terra;variflight/aliyun/kimi/kimi-k3"
 *
 * 命令:
 *   /vision-model       显示当前模型与图片支持状态
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 默认候选多模态模型(provider, modelId),按优先级排序 */
// 2026-08: variflight AI 网关整体下线，原 azure/gpt-5.5 与过渡的 azure3/gpt-5.6-* 均移除；
// 图片能力优先走 CPA（cliproxy-dmit）的 gpt-5.6-*（三个型号实测 vision 均可用）。
const DEFAULT_VISION_PREFERENCE: Array<[string, string]> = [
  ["cliproxy-dmit", "gpt-5.6-sol"],
  ["cliproxy-dmit", "gpt-5.6-terra"],
  ["cliproxy-dmit", "gpt-5.6-luna"],
  ["variflight", "openrouter/anthropic/claude-opus-5"],
  ["variflight", "openrouter/anthropic/claude-opus-4.8"],
  ["variflight", "aliyun/kimi/kimi-k3"],
  ["variflight", "feeyo/glm-5.2"],
];

function loadPreference(): Array<[string, string]> {
  const raw = process.env.VISION_MODEL_PREFERENCE;
  if (!raw) return DEFAULT_VISION_PREFERENCE;
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf("/");
      if (idx <= 0) return null;
      return [entry.slice(0, idx), entry.slice(idx + 1)] as [string, string];
    })
    .filter((x): x is [string, string] => x !== null);
}

function supportsImages(model: Model<Api> | undefined): boolean {
  return !!model && model.input.includes("image");
}

export default function visionFallback(pi: ExtensionAPI) {
  let preference = loadPreference();

  // 切换状态
  let switched = false; // 当前是否处于"图片轮"(模型已被切换)
  let originalModel: Model<Api> | undefined;
  let originalThinking: ThinkingLevel | undefined;

  async function findVisionModel(ctx: ExtensionContext): Promise<Model<Api> | undefined> {
    // 1. 候选列表按序查找(同步,last-known 模型列表)
    for (const [provider, id] of preference) {
      const model = ctx.modelRegistry.find(provider, id);
      if (supportsImages(model)) return model;
    }
    // 2. 兜底:全量模型里第一个支持图片的
    const available = ctx.modelRegistry.getAvailable();
    return available.find((m) => supportsImages(m));
  }

  pi.on("input", async (event, ctx) => {
    if (!event.images || event.images.length === 0) return; // 无图,不干预
    if (switched) return; // 已在图片轮,保持多模态模型
    if (supportsImages(ctx.model)) return; // 当前模型本身支持图片

    const vision = await findVisionModel(ctx);
    if (!vision) {
      ctx.ui.notify("检测到图片,但找不到可用的多模态模型", "warning");
      return;
    }

    originalModel = ctx.model;
    originalThinking = pi.getThinkingLevel();
    const ok = await pi.setModel(vision);
    if (!ok) {
      ctx.ui.notify(
        `切换到 ${vision.provider}/${vision.id} 失败(无 API key)`,
        "error",
      );
      originalModel = undefined;
      originalThinking = undefined;
      return;
    }

    switched = true;
    ctx.ui.notify(
      `检测到图片,本轮切换到 ${vision.name}(${vision.provider}/${vision.id})`,
      "info",
    );
  });

  // 整个 agent 运行结束(含自动重试/压缩/队列消息),恢复原模型
  pi.on("agent_settled", async (_event, ctx) => {
    if (!switched) return;

    if (originalModel) {
      await pi.setModel(originalModel);
    }
    if (originalThinking) {
      pi.setThinkingLevel(originalThinking);
    }
    switched = false;
    originalModel = undefined;
    originalThinking = undefined;
    ctx.ui.notify("图片轮结束,已恢复原模型", "info");
  });

  // 状态查询命令
  pi.registerCommand("vision-model", {
    description: "显示当前模型与图片支持状态,以及图片轮自动切换的候选模型",
    handler: async (_args, ctx) => {
      const current = ctx.model;
      const lines = [
        `当前模型: ${current.provider}/${current.id}`,
        `支持图片: ${supportsImages(current) ? "是" : "否"}`,
        `自动切换状态: ${switched ? "已切换到多模态模型(图片轮进行中)" : "空闲"}`,
        "",
        "候选多模态模型:",
        ...preference.map(([provider, id]) => {
          const model = ctx.modelRegistry.find(provider, id);
          return model
            ? `  - ${provider}/${id} (${supportsImages(model) ? "可用" : "不支持图片"})`
            : `  - ${provider}/${id} (未注册)`;
        }),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
