/**
 * 学习闭环的记账（#10 / T08）。口径在 `docs/adr/0009-learning-boost.md`：
 * 只记「访客把哪一条放到了第几位」，加权只在**档内**生效，三个门槛数字都在这里改。
 */

/** AC#1 的那四个字段，外加一份派生出来的来源分组。 */
export interface PlacementRecord {
  providerId: string;
  /** 归一之后的卡片标识（`${providerId}:${remoteId}`），不是源站原样的编号——ADR-0004 那套稳定性靠它。 */
  taskId: string;
  /**
   * 放置那一刻由 `sourceGroupOf` 算出来的分组。
   * 存下来而不是回头再算：那一轮之后这条任务可能从清单上消失（关掉、转派），届时没人能重算它的分组。
   */
  group: string;
  /** 放置那一刻，来自注入的时钟。 */
  at: string;
  /** 放进去之后它落在屏幕上的第几位，**0 基**：界面上「第 1 位」在这里是 `0`。 */
  position: number;
}

/** 多近算「连续」：只看这段时间窗口里的放置。 */
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 放到第几位以内算「置顶」：前三位，即 `position < 3`。 */
const TOP_SLOTS = 3;
/** 命中几次才开始加权：一次可能是顺手，两次才是习惯。 */
const MIN_HITS = 2;

/**
 * 每个来源分组在窗口内被置顶了几次，**只留下过了门槛的那些**。
 *
 * 计的是**放置次数**而不是不同条目的个数：访客把同一张卡连续置顶两次，行为上就是「连着两次把它排前面」，
 * 这一票不区分那是同一条——区分它要靠条目身份，而条目身份已经被八键的稳定性问题绑住了（ADR-0004）。
 *
 * 认不出的时间戳（NaN）与落在未来的记录一律不计：这份数组来自 `localStorage`，
 * 而那里存的值可能是访客手改过的任何东西（同 `src/panel/manual-order.ts` 读端的理由）。
 */
export function hitsByGroup(
  records: readonly PlacementRecord[],
  instant: string,
): Map<string, number> {
  const now = Date.parse(instant);
  const since = now - WINDOW_MS;
  const hits = new Map<string, number>();
  for (const record of records) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    if (!(record.position >= 0) || record.position >= TOP_SLOTS) continue;
    hits.set(record.group, (hits.get(record.group) ?? 0) + 1);
  }
  for (const [group, count] of hits) {
    if (count < MIN_HITS) hits.delete(group);
  }
  return hits;
}
