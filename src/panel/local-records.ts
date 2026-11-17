import { clearLearningRecords, loadLearningRecords } from "./learning-records";
import { clearManualOrder, loadManualOrder } from "./manual-order";

/**
 * 本地例外的那两份记录（#13）：手动顺序与放置记录只住这台浏览器的 localStorage，
 * 服务端的撤销与 30 天清除都不覆盖它们（ADR-0008 A 支）。这里是它们在 v1 唯一的删除入口。
 */

export function hasLocalRecords(): boolean {
  return loadManualOrder().length > 0 || loadLearningRecords().length > 0;
}

/** 清完：顺序回到规则打分，学习加权消失；服务端数据不受影响。 */
export function clearLocalRecords(): void {
  clearManualOrder();
  clearLearningRecords();
}
