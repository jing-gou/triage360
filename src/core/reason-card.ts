import type { DuePrecision } from "./provider";
import type { LearnedBoost, RuleId } from "./today-list";

/**
 * 「为什么是这几条」上行的那张卡（#8）：面板拼、服务端逐字段校验，两边共用同一份形状。
 * 只有元数据——正文、评论、diff 不在这里，也不该被加进来（ADR-0013）。
 */
export interface ReasonCard {
  title: string;
  reason: RuleId;
  learned?: LearnedBoost;
  dueAt?: string;
  duePrecision?: DuePrecision;
  updatedAt: string;
}
