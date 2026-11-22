/**
 * 「AI 提炼」上行的那张卡（#20）：面板拼、服务端逐字段校验，两边共用同一份形状。
 * 只有标题与标签——正文、评论、diff 不在这里，也不该被加进来（ADR-0016）。
 * 缓存键（provider + issue_id + updated_at）只在浏览器那侧用，不上行。
 */
import type { Task } from "./provider";

export interface SummaryCard {
  title: string;
  labels: string[];
}

/** 摘要的缓存键：`provider + issue_id + updated_at`。服务端预生成与面板查表共用这一个函数。 */
export function summaryKeyOf(task: Task): string {
  return `${task.id}@${task.updatedAt}`;
}

/** 一次「AI 提炼」的卡片上限与并发数：面板与服务端预生成共用，别各写一份。 */
export const SUMMARY_LIMIT = 20;
export const SUMMARY_CONCURRENCY = 3;
