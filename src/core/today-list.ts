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
  tasks: Task[];
}

/**
 * seam 1「今日清单构建器」：取数 → 归一 → 收敛 → 排序。
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

  // 打分（T04）之前，最近有动静的排前面。normalize 已把各家时间统一成 UTC，字符串比较才成立。
  const tasks = batches.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { generatedAt: now().toISOString(), tasks };
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
