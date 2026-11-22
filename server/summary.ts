import type { SummaryCard } from "../src/core/summary-card";
import type { DeepseekConfig } from "./config";

/**
 * 「AI 提炼」的摘要通道（#20）：一次一条，面板并发调用，逐条填进卡片。
 * 上行只有标题与标签——正文、评论、diff 一概不送；标签来自同一轮取数的源站原件（provider.labels）。
 */

export class SummaryUnavailableError extends Error {}
export class SummaryTimeoutError extends Error {}

/** 批量摘要不在 2 秒交互承诺里：一句概括要给模型留出排队的余量，面板另设 8 秒兜底。 */
const TIMEOUT_MS = 6000;
const MAX_TOKENS = 160;
const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 80;

const SYSTEM_PROMPT = [
  "你是任务清单的摘要员。用一句中文概括这张任务卡要做什么，不超过 40 字。",
  "只依据用户消息里的标题与标签；不要编造正文、评论、代码或标签之外的事实。",
  "标题与标签不足以判断具体任务时，只输出四个字：信息不足。",
  "只输出那一句话：不要标题、列表、Markdown 或引号。",
].join("\n");

/** 面板传来的 card 逐字段校验：只收标题与标签，别的键一律丢掉（缓存键只在浏览器那侧）。 */
export function parseSummaryCard(value: unknown): SummaryCard | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const title = text(raw.title, 1, 500);
  if (title === null) return null;

  const labelsRaw = raw.labels;
  if (!Array.isArray(labelsRaw) || labelsRaw.length > MAX_LABELS) return null;
  const labels: string[] = [];
  for (const one of labelsRaw) {
    const name = text(one, 1, MAX_LABEL_LENGTH);
    if (name === null) return null;
    if (!labels.includes(name)) labels.push(name);
  }

  return { title, labels };
}

export interface SummaryResult {
  text: string;
  elapsedMs: number;
}

/**
 * 一条阻塞式调用：服务端超时抛 `SummaryTimeoutError`、没配钥匙抛 `SummaryUnavailableError`，
 * 其余上游故障交给路由折成 502。摘要质量走人工判断，不做自动断言。
 */
export async function composeSummary(
  config: DeepseekConfig,
  card: SummaryCard,
  fetchImpl: typeof fetch = fetch,
): Promise<SummaryResult> {
  if (config.apiKey === "") throw new SummaryUnavailableError("未配置 DEEPSEEK_API_KEY");

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
        // 摘要同样不需要推理链：显式关掉 thinking，省预算也更快（官方 Thinking Mode 文档）。
        thinking: { type: "disabled" },
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`DeepSeek 返回 ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError") {
      throw new SummaryTimeoutError("摘要请求超时");
    }
    if (error instanceof SyntaxError) throw new Error("DeepSeek 响应不是 JSON");
    throw error;
  }

  const content = body.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (text === "") throw new Error("DeepSeek 没有给出摘要");
  return { text, elapsedMs: Date.now() - started };
}

function text(value: unknown, min: number, max: number): string | null {
  return typeof value === "string" && value.trim().length >= min && value.length <= max ? value.trim() : null;
}
