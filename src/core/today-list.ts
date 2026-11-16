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
}

export interface TodayList {
  /** 构建器运行那一刻，来自注入的时钟。 */
  generatedAt: string;
  entries: ListEntry[];
}

/**
 * 清单条目 = 任务 + 它为什么排在这里。
 * 理由不塞进任务本身：定稿的七键是跨平台最小形状（T03），打分是构建器这一侧的事。
 */
export interface ListEntry {
  task: Task;
  reason: RuleId;
}

/**
 * 命中规则的标识，不是句子。#8「为什么是这几条」与界面措辞要的是这个标识，
 * 分数留给 #10 学习加权再加——现在没有规则需要它。
 */
export type RuleId = "overdue" | "dueToday" | "recentUpdate";

/** 档位表：谁排在谁前面。顺序只由这张表和档内比较决定，规则本身不写数字。 */
const RANK: Record<RuleId, number> = { overdue: 0, dueToday: 1, recentUpdate: 2 };

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
}: TodayListDeps): Promise<TodayList> {
  const batches = await Promise.all(providers.map((provider) => buildOne(provider, http, scope, previous)));

  // 打分（T04）先按规则分堆，堆内按最近有动静排。
  // normalize 已把各家时间统一成 UTC，字符串比较才成立；时钟只取一次，同一轮里不许变。
  const instant = now().toISOString();
  const entries = batches.flat().map((task) => ({ task, reason: ruleOf(task, instant) }));
  // 末位按 id 破平：档位与更新时间都相同的那些条目不能由 provider 返回的数组顺序决定，
  // 那个顺序不属于本应用（T05 合并四家之后更明显）。
  entries.sort(
    (a, b) =>
      RANK[a.reason] - RANK[b.reason] ||
      b.task.updatedAt.localeCompare(a.task.updatedAt) ||
      a.task.id.localeCompare(b.task.id),
  );

  return { generatedAt: instant, entries };
}

/**
 * 这条排在这里是哪条规则决定的。没有截止时间的条目走 `recentUpdate`。
 * 「今日」取 UTC 日历日同一天，不是「未来 24 小时内」：构建器只有一个 instant，
 * 想知道用户本地的今天还得再喂一个时区进来，那是另一个输入。
 * 今天但已过去的时刻算逾期，所以先比 `dueAt < instant` 再比日。
 */
function ruleOf(task: Task, instant: string): RuleId {
  if (task.dueAt === undefined) return "recentUpdate";
  if (task.dueAt < instant) return "overdue";
  return dayOf(task.dueAt) === dayOf(instant) ? "dueToday" : "recentUpdate";
}

/** ISO 串的前十个字符 `YYYY-MM-DD` 就是它的 UTC 日。 */
function dayOf(instant: string): string {
  return instant.slice(0, 10);
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
