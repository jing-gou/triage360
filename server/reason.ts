import { RULE_IDS, type RuleId } from "../src/core/today-list";
import type { DeepseekConfig } from "./config";

/**
 * 「为什么是这几条」的措辞通道（#8）：规则引擎已经决定了顺序与档位，模型只把这件事说成一句人话。
 * 输入只有卡片元数据——标题、档位、学习信号、时间；正文、评论、diff 一概不上行。
 * 钥匙与上游地址都住在服务端：浏览器拿到的只有一句结果和这段调用的耗时。
 */

export interface ReasonCard {
  title: string;
  reason: RuleId;
  learned?: { group: string; hits: number };
  dueAt?: string;
  duePrecision?: "day" | "instant";
  updatedAt: string;
}

export class ReasonUnavailableError extends Error {}
export class ReasonTimeoutError extends Error {}

/** 2 秒是界面约定（PRD 128），留 200ms 给回程；超了就由面板回落到纯规则理由。 */
const TIMEOUT_MS = 1800;
const MAX_TOKENS = 200;

const SYSTEM_PROMPT = [
  "你是任务清单的说明员。排序和档位已由规则引擎定稿，你只负责用一句中文说明这张卡为什么排在这里，不超过 60 字。",
  "只依据用户消息里的元数据：不要编造正文、评论、代码或元数据之外的事实。",
  "元数据里有 learned 时，句子必须同时点明档位原因（reason）与这条学习信号（哪个来源分组被连续置顶）；没有 learned 时一个字都不要提学习。",
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
    const { group, hits } = learnedRaw as Record<string, unknown>;
    const name = text(group, 1, 140);
    if (name !== null && typeof hits === "number" && Number.isInteger(hits) && hits >= 0 && hits <= 10_000) {
      learned = { group: name, hits };
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
  return { text, elapsedMs: Date.now() - started };
}

function isRuleId(value: unknown): value is RuleId {
  return typeof value === "string" && (RULE_IDS as readonly string[]).includes(value);
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
