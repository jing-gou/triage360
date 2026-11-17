import type { PlacementRecord } from "../core/learning";

/**
 * 放置记录的落盘位置（#10 / T08）。与手动顺序同一套前提：只住这台浏览器的 `localStorage`，
 * 服务端没有副本，#13 的撤销与 30 天清除都不覆盖它（ADR-0008 定的 A 支）。
 *
 * 键名带版本，理由同 `manual-order.ts`：localStorage 活得比一次部署久，改形状时旧键要认得出来。
 */

const RECORDS_KEY = "triage360:learning-records:v1";

/**
 * 数组上限：只留最近这些条。窗口只有 7 天，200 条早已把它盖满，
 * 这个数字买的是「这份数组不会无限长」，不是任何加权口径。
 */
const MAX_RECORDS = 200;

/**
 * 存的值可能是访客手改过的任何东西，所以逐条验形状而不是 `as PlacementRecord[]`：
 * 一条记录缺 `group` 会让整轮排序读到 undefined，而那正是「清空数据」以外最不该出现的假象。
 */
export function loadLearningRecords(): PlacementRecord[] {
  let raw: unknown;
  try {
    const text = localStorage.getItem(RECORDS_KEY);
    if (text === null) return [];
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlacementRecord);
}

/** 写不进去最坏是这一轮的放置不被记住，不该让清单本身报错；理由同 `manual-order.ts` 的写端。 */
export function appendLearningRecord(record: PlacementRecord): void {
  try {
    const next = [...loadLearningRecords(), record].slice(-MAX_RECORDS);
    localStorage.setItem(RECORDS_KEY, JSON.stringify(next));
  } catch {
    // 有意吞掉：这里没有比「保持原样」更好的动作。
  }
}

function isPlacementRecord(one: unknown): one is PlacementRecord {
  if (typeof one !== "object" || one === null) return false;
  const { providerId, taskId, group, at, position } = one as Record<string, unknown>;
  return (
    typeof providerId === "string" &&
    typeof taskId === "string" &&
    typeof group === "string" &&
    typeof at === "string" &&
    typeof position === "number"
  );
}
