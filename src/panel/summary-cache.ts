import type { Task } from "../core/provider";
import { summaryKeyOf } from "../core/summary-card";

/**
 * 「AI 提炼」的本机缓存（#20）：键是 provider + issue_id + updated_at。
 * `task.id` 已经带 provider 与远端 id，再拼上 `updatedAt`，源站没更新就不会重算。
 * 只住在这台浏览器：换浏览器重问一次，换来的是不把摘要写进服务端账本（删除义务别扩大）。
 */

const PREFIX = "triage360:summary:v1:";
const MAX_ENTRIES = 300;

export const summaryKey = summaryKeyOf;

export function cachedSummary(task: Task): string | null {
  try {
    return window.localStorage.getItem(PREFIX + summaryKey(task));
  } catch {
    return null;
  }
}

export function rememberSummary(task: Task, text: string): void {
  try {
    window.localStorage.setItem(PREFIX + summaryKey(task), text);
    prune();
  } catch {
    // 隐私模式 / 配额满：摘要照常显示，只是下次刷新会重算。
  }
}

/** 超过上限先扔最早插入的一批；localStorage 的枚举顺序按插入序，够用。 */
function prune(): void {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null && key.startsWith(PREFIX)) keys.push(key);
  }
  if (keys.length <= MAX_ENTRIES) return;
  for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) window.localStorage.removeItem(key);
}
