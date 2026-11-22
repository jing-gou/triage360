import { RULE_IDS, type RuleId } from "../src/core/today-list";
import type { ReasonCard } from "../src/core/reason-card";
import type { DeepseekConfig } from "./config";

/**
 * 「为什么是这几条」的措辞通道（#8）：规则引擎已经决定了顺序与档位，模型只把这件事说成一句人话。
 * 输入只有卡片元数据——标题、档位、学习信号、时间；正文、评论、diff 一概不上行。
 * 钥匙与上游地址都住在服务端：浏览器拿到的只有一句结果和这段调用的耗时。
 */

export class ReasonUnavailableError extends Error {}
export class ReasonTimeoutError extends Error {}
/** 模型句没通过校验（漏了档位或学习信号）：面板照常回落到规则句，那句两个来源层都齐全。 */
export class ReasonQualityError extends Error {}

/** 2 秒是界面约定（PRD 128），留 200ms 给回程；超了就由面板回落到纯规则理由。 */
const TIMEOUT_MS = 1800;
const MAX_TOKENS = 200;

const SYSTEM_PROMPT = [
  "你是任务清单的说明员。档位已由规则引擎定稿，位置可能已被用户手动调整；你只负责用一句中文说明这张卡为什么属于这一档，不超过 60 字。",
  "只依据用户消息里的元数据：不要编造正文、评论、代码或元数据之外的事实。",
  "元数据里有 learned 时，句子必须同时点明档位原因（reason）与出现的每一个学习信号：group 是来源分组名、label 是标签名，两个都有就两个都要说到；没有 learned 时一个字都不要提学习。",
  "合并卡的其余来源由界面另行标注：不要猜测或列举其他来源平台。",
  "只输出那一句话：不要标题、列表、Markdown 或引号。",
].join("\n");

/** 面板传来的 card 逐字段校验：只收元数据，长度设上限，别的键一律丢掉。 */
export function parseReasonCard(value: unknown): ReasonCard | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const title = text(raw.title, 1, 500);
  const updatedAt = text(raw.updatedAt, 1, 64);
  const reason = raw.reason;
  if (title === null || updatedAt === null) return null;
  if (!isRuleId(reason)) return null;

  const learnedRaw = raw.learned;
  let learned: ReasonCard["learned"];
  if (typeof learnedRaw === "object" && learnedRaw !== null) {
    const source = learnedRaw as Record<string, unknown>;
    const group = parseSignal(source.group);
    const label = parseSignal(source.label);
    if (group !== undefined || label !== undefined) {
      learned = {
        ...(group === undefined ? {} : { group }),
        ...(label === undefined ? {} : { label }),
        hits: Math.max(group?.hits ?? 0, label?.hits ?? 0),
      };
    }
  }

  const dueAt = text(raw.dueAt, 1, 64) ?? undefined;
  const duePrecision = raw.duePrecision === "day" || raw.duePrecision === "instant" ? raw.duePrecision : undefined;

  return {
    title,
    reason,
    ...(learned === undefined ? {} : { learned }),
    ...(dueAt === undefined ? {} : { dueAt }),
    ...(duePrecision === undefined ? {} : { duePrecision }),
    updatedAt,
  };
}

export interface ReasonResult {
  text: string;
  elapsedMs: number;
}

/**
 * 一次阻塞式调用，只回一句话。失败分两类交给路由折成状态码：
 * 没配钥匙抛 `ReasonUnavailableError`（503），超时抛 `ReasonTimeoutError`（504），其余按上游故障处理。
 */
export async function composeReasonWording(
  config: DeepseekConfig,
  card: ReasonCard,
  fetchImpl: typeof fetch = fetch,
): Promise<ReasonResult> {
  if (config.apiKey === "") throw new ReasonUnavailableError("未配置 DEEPSEEK_API_KEY");

  const started = Date.now();
  let body: { choices?: { message?: { content?: unknown } }[] };
  try {
    const res = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(card) },
        ],
        // 一句措辞不需要推理链；deepseek-flash 默认 thinking=high，显式关掉才不花预算（官方 Thinking Mode 文档）。
        thinking: { type: "disabled" },
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DeepSeek 返回 ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (error) {
    // 超时由 `AbortSignal.timeout` 以 DOMException 拒绝（头都没回来或读到一半都可能）；DOMException 不是 Error 子类，按 name 认。
    if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError") {
      throw new ReasonTimeoutError("措辞请求超时");
    }
    // JSON 解析失败的 message 会内嵌一段响应体，不能带进日志。
    if (error instanceof SyntaxError) throw new Error("DeepSeek 响应不是 JSON");
    throw error;
  }

  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (text === "") throw new Error("DeepSeek 没有给出措辞");
  assertWording(text, card);
  return { text, elapsedMs: Date.now() - started };
}

/** learned 里的一维信号：`{ name, hits }`，逐字段验，别的键丢掉。 */
function parseSignal(value: unknown): { name: string; hits: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, hits } = value as Record<string, unknown>;
  const label = text(name, 1, 140);
  if (label === null || typeof hits !== "number" || !Number.isInteger(hits) || hits < 0 || hits > 10_000) {
    return undefined;
  }
  return { name: label, hits };
}

function isRuleId(value: unknown): value is RuleId {
  return typeof value === "string" && (RULE_IDS as readonly string[]).includes(value);
}

/** AC#6 的两半都硬校验：档位用粗关键词认（同义改写漏了就不给过），学习信号必须原样出现。 */
const TIER_HINTS: Record<RuleId, readonly string[]> = {
  overdue: ["逾期", "过期", "期限已过"],
  dueToday: ["今天到期", "今日到期", "到期", "今天", "今日"],
  noDeadline: ["截止"],
  dueLater: ["截止"],
};

function assertWording(text: string, card: ReasonCard): void {
  if (!TIER_HINTS[card.reason].some((hint) => text.includes(hint))) {
    throw new ReasonQualityError("措辞没有点明档位");
  }
  if (card.learned?.group !== undefined && !text.includes(card.learned.group.name)) {
    throw new ReasonQualityError("措辞没有点明来源分组的命中");
  }
  if (card.learned?.label !== undefined && !text.includes(card.learned.label.name)) {
    throw new ReasonQualityError("措辞没有点明标签的命中");
  }
}

function text(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.length >= min && value.length <= max ? value : null;
}

/**
 * 启动时先握一次手：进程冷启动的 DNS + TLS 要吃掉 1.8 秒预算，首个访客不该替整个进程付这笔账。
 * 只记状态码与耗时；失败不拦启动——那只会让这一条链路回落到规则理由。
 */
export async function warmReason(config: DeepseekConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (config.apiKey === "") return;
  const started = Date.now();
  try {
    const res = await fetchImpl(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[reason] warm ${res.status} in ${Date.now() - started}ms`);
  } catch (error) {
    console.warn(`[reason] warm failed: ${error instanceof Error ? error.name : "unknown"}`);
  }
}
