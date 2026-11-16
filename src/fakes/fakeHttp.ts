import type { Http } from "../core/provider";

/**
 * 源站替身。每个平台给两份字面量：
 * - `view`：`search` 的返回，即「此刻范围内有哪些」。
 * - `byId`：按 id 批量取回的返回；省略时等于 `view`。
 *
 * 两份分开写，是为了能表达跨轮才会出现的三种源站情况：
 * 仍在视图里、从视图里消失但按 id 仍能取回（已删除）、两边都不返回（跳过）。
 */

export type FakePlatform = "github" | "gitee" | "jira" | "feishu";

export interface FakeSource {
  /** 原始 JSON，替身不解释形状——怎么读由各 provider 的 normalize 决定。 */
  view: unknown[];
  byId?: unknown[];
}

export type FakeData = Partial<Record<FakePlatform, FakeSource>>;

/**
 * 命中时返回响应体；没命中返回 null——拼错的 URL 不该静默换回一张空清单。
 * 按 id 取回时源站没有那条（真实世界是 404）也走这里：v1 里 provider 还不处理状态码，
 * 该语义由 T15 真连时一并补。批量端点用「返回的列表里少这个 id」表达，不经过这里。
 */
type Respond = (target: URL, source: FakeSource) => unknown | null;

const ROUTES: Record<FakePlatform, { host: string; headers?: Record<string, string>; respond: Respond }> = {
  github: {
    host: "api.github.com",
    // scope 真值检测（T12）读的是这个响应头，替身必须一起交出来。
    headers: { "x-oauth-scopes": "public_repo" },
    respond(target, source) {
      const query = target.searchParams;
      const ids = query.get("ids");
      if (ids !== null) return { items: filterBy(source.byId ?? source.view, "number", ids) };
      if (query.has("q")) return { items: source.view };
      return null;
    },
  },
  gitee: {
    host: "gitee.com",
    // 仓库粒度：列表端点与单条端点都按 URL 路径里的仓库过滤，替身自己认这个形状。
    respond(target, source) {
      const match = /^\/api\/v5\/repos\/(.+?)\/issues(?:\/(\d+))?$/.exec(target.pathname);
      if (!match) return null;
      const [, repo, number] = match;
      const inRepo = (item: unknown) => String(field(item, "html_url") ?? "").includes(`/gitee.com/${repo}/issues/`);
      if (number !== undefined) {
        return (source.byId ?? source.view).find((item) => inRepo(item) && String(field(item, "number")) === number) ??
          null;
      }
      return source.view.filter(inRepo);
    },
  },
  jira: {
    host: "sample-jira.atlassian.net",
    respond(target, source) {
      if (target.pathname !== "/rest/api/3/search") return null;
      const jql = target.searchParams.get("jql") ?? "";
      // Jira 的批量取回是同一条搜索换了个 jql 条件，不是另一个端点。
      const inIds = /^id in \(([^)]*)\)$/.exec(jql)?.[1];
      if (inIds !== undefined) return { issues: filterBy(source.byId ?? source.view, "id", inIds) };
      return { issues: source.view };
    },
  },
  feishu: {
    host: "open.feishu.cn",
    respond(target, source) {
      if (target.pathname === "/open-apis/task/v2/tasks") return { data: { items: source.view } };
      const guid = /^\/open-apis\/task\/v2\/tasks\/(.+)$/.exec(target.pathname)?.[1];
      if (guid !== undefined) {
        return (source.byId ?? source.view).find((item) => field(item, "task_id") === guid) ?? null;
      }
      return null;
    },
  },
};

/** 替身按字段名取原始 JSON 里的值；不认识任何一家的形状。 */
function field(item: unknown, key: string): unknown {
  return (item as Record<string, unknown>)[key];
}

function filterBy(items: unknown[], key: string, csv: string): unknown[] {
  const wanted = new Set(csv.split(","));
  return items.filter((item) => wanted.has(String(field(item, key))));
}

export function fakeHttp(data: FakeData): Http {
  return async (url) => {
    const target = new URL(url);
    const platform = (Object.keys(ROUTES) as FakePlatform[]).find((key) => ROUTES[key].host === target.host);
    if (!platform) throw new Error(`fakeHttp 没有登记这个主机：${target.host}`);
    const source = data[platform];
    if (!source) throw new Error(`fakeHttp 里 ${platform} 没有准备数据`);
    const body = ROUTES[platform].respond(target, source);
    if (body === null) throw new Error(`fakeHttp 没有登记这个请求：${target.pathname}`);
    return { status: 200, headers: ROUTES[platform].headers ?? {}, body };
  };
}
