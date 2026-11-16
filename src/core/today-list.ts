import type { Http, Provider, Scope, Task } from "./provider";

export interface TodayListDeps {
  providers: readonly Provider[];
  http: Http;
  now: () => Date;
  scope: Scope;
}

export interface TodayList {
  /** 构建器运行那一刻，来自注入的时钟。 */
  generatedAt: string;
  tasks: Task[];
}

/**
 * seam 1「今日清单构建器」：取数 → 归一 → 排序。
 * 时钟与取数通道都从外部注入，界外没有第三种输入。
 */
export async function buildTodayList({ providers, http, now, scope }: TodayListDeps): Promise<TodayList> {
  const batches = await Promise.all(
    providers.map(async (provider) => {
      const raws = await provider.search(scope, http);
      return raws.map((raw) => provider.normalize(raw));
    }),
  );

  // 打分（T04）之前，最近有动静的排前面。
  const tasks = batches.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { generatedAt: now().toISOString(), tasks };
}
