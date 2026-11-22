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
  /**
   * 放置那一刻这张卡的标签名（#36）：标签是任务第九键，学习按它多认一维。
   * 与 `group` 同一个理由存下来：那一轮之后任务可能消失或改标签，回头再算就没人算得准。
   * 旧记录没有这个键：读端按「没有标签」处理，不因此丢整条。
   */
  labels?: readonly string[];
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
 * 这一票不区分那是同一条——区分它要靠条目身份，而条目身份已经被九键的稳定性问题绑住了（ADR-0004）。
 *
 * 认不出的时间戳（NaN）与落在未来的记录一律不计：这份数组来自 `localStorage`，
 * 而那里存的值可能是访客手改过的任何东西（同 `src/panel/manual-order.ts` 读端的理由）。
 */
export function hitsByGroup(
  records: readonly PlacementRecord[],
  instant: string,
): Map<string, number> {
  return countHits(records, instant, (record) => [record.group]);
}

/** 每个标签在窗口内被置顶了几次，门槛与分组完全同一套（#36）。 */
export function hitsByLabel(
  records: readonly PlacementRecord[],
  instant: string,
): Map<string, number> {
  return countHits(records, instant, (record) => record.labels ?? []);
}

/**
 * 两个维度共用的一遍计数：窗口、前三位、两次起都只在这里写一次，
 * 免得标签那一维抄着抄着把门槛抄成另一组数字。
 */
function countHits(
  records: readonly PlacementRecord[],
  instant: string,
  keysOf: (record: PlacementRecord) => readonly string[],
): Map<string, number> {
  const now = Date.parse(instant);
  const since = now - WINDOW_MS;
  const hits = new Map<string, number>();
  for (const record of records) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || at < since || at > now) continue;
    if (!(record.position >= 0) || record.position >= TOP_SLOTS) continue;
    // 一条记录里同一个键只计一次：一张卡的标签并集本来就去重，这里兜住手改过的存储。
    for (const key of new Set(keysOf(record))) {
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of hits) {
    if (count < MIN_HITS) hits.delete(key);
  }
  return hits;
}
