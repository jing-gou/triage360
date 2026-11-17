import type { Http, Provider, Scope, Task } from "./provider";

export interface TodayListDeps {
  providers: readonly Provider[];
  http: Http;
  now: () => Date;
  scope: Scope;
  /**
   * 上一轮清单里的任务，用来判断"这一轮有哪些条目该跟着刷新"。省略即第一轮。
   * 跨轮状态由调用方保管：provider 与构建器都不落盘，也不从别处读。
   */
  previous?: readonly Task[];
  /**
   * 访客相对 UTC 的分钟偏移（UTC+8 是 480），用来把「今日」判成访客日历里的今天。
   * 省略即 UTC 日界。构建器不自己读宿主时区：那样同一个输入在 CI（TZ=UTC）
   * 与用户浏览器里会判出两种顺序，门内绿的正是线上错的。
   */
  zoneOffsetMinutes?: number;
}

export interface TodayList {
  /** 构建器运行那一刻，来自注入的时钟。 */
  generatedAt: string;
  entries: ListEntry[];
}

/**
 * 清单条目 = 任务 + 它为什么排在这里。
 * 理由不塞进任务本身：定稿的八键是跨平台最小形状（T03），打分是构建器这一侧的事。
 */
export interface ListEntry {
  task: Task;
  reason: RuleId;
}

/**
 * 命中规则的标识，不是句子。#8「为什么是这几条」与界面措辞要的是这个标识，
 * 分数留给 #10 学习加权再加——现在没有规则需要它。
 */
export type RuleId = "overdue" | "dueToday" | "noDeadline" | "dueLater";

/**
 * 档位表：谁排在谁前面。顺序只由这张表和档内比较决定，规则本身不写数字。
 * `noDeadline` 与 `dueLater` 同档：它们只是「为什么不在今天」的两个原因，不代表两种紧急度。
 */
const RANK: Record<RuleId, number> = { overdue: 0, dueToday: 1, noDeadline: 2, dueLater: 2 };

/**
 * seam 1「今日清单构建器」：取数 → 归一 → 收敛 → 打分。
 * 每个 provider 每轮一个 search，外加至多一次按 id 批量取回。
 */
export async function buildTodayList({
  providers,
  http,
  now,
  scope,
  previous = [],
  zoneOffsetMinutes,
}: TodayListDeps): Promise<TodayList> {
  const batches = await Promise.all(providers.map((provider) => buildOne(provider, http, scope, previous)));

  // 打分（T04）先按规则分堆，堆内按最近有动静排。
  // normalize 已把各家时间统一成 UTC，字符串比较才成立；时钟只取一次，同一轮里不许变。
  const instant = now().toISOString();
  const entries = batches
    .flat()
    .map((task) => ({ task, reason: ruleOf(task, instant, zoneOffsetMinutes) }));
  // 末位按 id 破平：档位与更新时间都相同的那些条目不能由 provider 返回的数组顺序决定，
  // 那个顺序不属于本应用（T05 合并四家之后更明显）。
  entries.sort(
    (a, b) =>
      RANK[a.reason] - RANK[b.reason] || byCode(b.task.updatedAt, a.task.updatedAt) || byCode(a.task.id, b.task.id),
  );

  return { generatedAt: instant, entries };
}

/**
 * 这条排在这里是哪条规则决定的。第三档有两个标识：压根没写截止，与截止在更晚的那天——
 * 「最近更新」对后者是句假话，而 AC#2 要的就是原因本身。
 * 「今日」比的才是日界，所以它需要知道访客在哪一天。
 * 先比瞬间再比日：今天但已经过去的时刻算逾期，不算今日到期。
 * 不是「未来 24 小时内」：那是时长，不是日历日。
 *
 * 只写日期的截止走另一条路，因为它没有瞬间可比：源站写 `2026-11-17` 说的是「访客的 11-17 这天
 * 做完都算及时」，那一天归哪一天由源站已经写死了，再套一次访客偏移反而会把它推到相邻日。
 * 于是它比的是两个日历日——写下的那天 vs 访客的今天，`YYYY-MM-DD` 的字典序就是时间序。
 */
function ruleOf(task: Task, instant: string, zoneOffsetMinutes?: number): RuleId {
  if (task.dueAt === undefined) return "noDeadline";
  if (task.duePrecision === "day") {
    const dueDay = task.dueAt.slice(0, 10);
    const today = dayOf(instant, zoneOffsetMinutes);
    return dueDay < today ? "overdue" : dueDay === today ? "dueToday" : "dueLater";
  }
  if (task.dueAt < instant) return "overdue";
  return dayOf(task.dueAt, zoneOffsetMinutes) === dayOf(instant, zoneOffsetMinutes) ? "dueToday" : "dueLater";
}

/**
 * 一条瞬间落在哪一天。没有偏移就取它的 UTC 日（ISO 串的前十个字符）；
 * 给了偏移先把墙上时间平移到访客那一侧，再取日。
 */
function dayOf(instant: string, zoneOffsetMinutes?: number): string {
  if (zoneOffsetMinutes === undefined) return instant.slice(0, 10);
  return new Date(Date.parse(instant) + zoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * 比较用码位序，不用 `localeCompare`：id 里带 `:` `#` `/` 与大小写，
 * ICU 给的顺序随宿主变，而今天这批 ASCII 样本还测不出来。
 */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function buildOne(
  provider: Provider,
  http: Http,
  scope: Scope,
  previous: readonly Task[],
): Promise<Task[]> {
  // 空数组 = 这个平台任何状态都不算完成/删除，条目一律留在清单里。
  const done = new Set(provider.doneStates());
  const deleted = new Set(provider.deletedStates());
  const stillOpen = (task: Task) => !done.has(task.state) && !deleted.has(task.state);

  const seen = (await provider.search(scope, http)).map(provider.normalize);

  // 本轮视图已经给出这条的状态，就不再按 id 问第二次：再问一次只会把上一轮的旧状态请回来。
  const unseen = previous.filter(
    (task) => task.providerId === provider.id && !seen.some((s) => s.id === task.id),
  );
  const carried = unseen.length === 0 ? [] : await carryOver(provider, http, unseen);

  return [...seen, ...carried].filter(stillOpen);
}

/**
 * 上一轮有、本轮视图里没有的条目：一次批量取回分辨「已被删除」与「这次没返回」。
 * 批量没返回的 id 视为跳过——保留上一轮那条，而不是当成已删除。
 */
async function carryOver(provider: Provider, http: Http, unseen: readonly Task[]): Promise<Task[]> {
  const refreshed = new Map(
    (await provider.getByIds(unseen.map((task) => task.id), http))
      .map(provider.normalize)
      .map((task) => [task.id, task] as const),
  );
  return unseen.map((task) => refreshed.get(task.id) ?? task);
}
