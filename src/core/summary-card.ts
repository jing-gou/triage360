/**
 * 「AI 提炼」上行的那张卡（#20）：面板拼、服务端逐字段校验，两边共用同一份形状。
 * 只有标题与标签——正文、评论、diff 不在这里，也不该被加进来（ADR-0016）。
 * 缓存键（provider + issue_id + updated_at）只在浏览器那侧用，不上行。
 */
export interface SummaryCard {
  title: string;
  labels: string[];
}
