import type { Http, RawItem } from "../core/provider";

/**
 * 源站替身。每个平台给两份字面量：
 * - `view`：`search` 的返回，即「此刻范围内有哪些」。
 * - `byId`：按 id 批量取回的返回；省略时等于 `view`。
 *
 * 两份分开写，是为了能表达跨轮才会出现的三种源站情况：
 * 仍在视图里、从视图里消失但按 id 仍能取回（已删除）、两边都不返回（跳过）。
 */

export type FakePlatform = "github" | "jira";

export interface FakeSource {
  view: RawItem[];
  byId?: RawItem[];
}

export type FakeData = Partial<Record<FakePlatform, FakeSource>>;

/** 命中时返回响应体；没命中返回 null，让调用方报错——拼错的 URL 不该静默给出空清单。 */
type Respond = (query: URLSearchParams, source: FakeSource) => unknown | null;

const ROUTES: Record<FakePlatform, { host: string; headers?: Record<string, string>; respond: Respond }> = {
  github: {
    host: "api.github.com",
    // scope 真值检测（T12）读的是这个响应头，替身必须一起交出来。
    headers: { "x-oauth-scopes": "public_repo" },
    respond(query, source) {
      const ids = query.get("ids");
      if (ids !== null) return { items: filterBy(source.byId ?? source.view, "number", ids) };
      if (query.has("q")) return { items: source.view };
      return null;
    },
  },
  jira: {
    host: "sample-jira.atlassian.net",
    respond(query, source) {
      const jql = query.get("jql") ?? "";
      // Jira 的批量取回是同一条搜索换了个 jql 条件，不是另一个端点。
      const inIds = /^id in \(([^)]*)\)$/.exec(jql)?.[1];
      if (inIds !== undefined) return { issues: filterBy(source.byId ?? source.view, "id", inIds) };
      return { issues: source.view };
    },
  },
};

function filterBy(items: RawItem[], key: string, csv: string): RawItem[] {
  const wanted = new Set(csv.split(","));
  return items.filter((item) => wanted.has(String(item[key])));
}

export function fakeHttp(data: FakeData): Http {
  return async (url) => {
    const target = new URL(url);
    const platform = (Object.keys(ROUTES) as FakePlatform[]).find((key) => ROUTES[key].host === target.host);
    if (!platform) throw new Error(`fakeHttp 没有登记这个主机：${target.host}`);
    const source = data[platform];
    if (!source) throw new Error(`fakeHttp 里 ${platform} 没有准备数据`);
    const query = new URLSearchParams(target.search);
    const body = ROUTES[platform].respond(query, source);
    if (body === null) throw new Error(`fakeHttp 没有登记这个查询：${target.pathname}`);
    return { status: 200, headers: ROUTES[platform].headers ?? {}, body };
  };
}
