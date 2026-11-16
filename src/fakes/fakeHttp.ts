import type { Http } from "../core/provider";

/**
 * 源站替身。每个平台给两份字面量：
 * - `view`：`search` 的返回，即「此刻范围内有哪些」。
 * - `byId`：按 id 取回的返回；省略时等于 `view`。
 *
 * 两份分开写，是为了能表达跨轮才会出现的三种源站情况：
 * 仍在视图里、从视图里消失但按 id 仍能取回（已删除）、两边都不返回（跳过）。
 */

export type FakePlatform = "github" | "gitee" | "jira" | "feishu";

export interface FakeSource {
  /** 原始 JSON：字段值一律原样回吐。id 字段名与路径形状在下面的路由表里，真连时两处要一起改。 */
  view: unknown[];
  byId?: unknown[];
}

export type FakeData = Partial<Record<FakePlatform, FakeSource>>;

interface FakeResponse {
  status: number;
  body: unknown;
}

/**
 * 三种出口，各自对应源站的一件真事：
 * - `200 + body`：这条有。
 * - `404`：单条端点上源站没有这条记录 —— 「未返回」在没有批量端点的平台上的形状。
 * - `null`：这个请求根本没登记，是测试写错了，必须抛错而不是静默换回一张空清单。
 *
 * 有批量端点的平台（GitHub 的 `?ids=`、Jira 的同端点 jql）用「列表里少这个 id」表达缺席，不经过 404。
 */
type Respond = (target: URL, source: FakeSource) => FakeResponse | null;

const ROUTES: Record<FakePlatform, { host: string; headers?: Record<string, string>; respond: Respond }> = {
  github: {
    host: "api.github.com",
    // scope 真值检测（T12）读的是这个响应头，替身必须一起交出来。
    headers: { "x-oauth-scopes": "public_repo" },
    respond(target, source) {
      const query = target.searchParams;
      const ids = query.get("ids");
      if (ids !== null) return { status: 200, body: { items: filterBy(source.byId ?? source.view, "number", ids) } };
      if (query.has("q")) return { status: 200, body: { items: source.view } };
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
        const item = (source.byId ?? source.view).find((one) => inRepo(one) && String(field(one, "number")) === number);
        return item === undefined ? { status: 404, body: null } : { status: 200, body: item };
      }
      return { status: 200, body: source.view.filter(inRepo) };
    },
  },
  jira: {
    host: "sample-jira.atlassian.net",
    respond(target, source) {
      if (target.pathname !== "/rest/api/3/search") return null;
      const jql = target.searchParams.get("jql") ?? "";
      // Jira 的批量取回是同一条搜索换了个 jql 条件，不是另一个端点。
      const inIds = /^id in \(([^)]*)\)$/.exec(jql)?.[1];
      if (inIds !== undefined) return { status: 200, body: { issues: filterBy(source.byId ?? source.view, "id", inIds) } };
      return { status: 200, body: { issues: source.view } };
    },
  },
  feishu: {
    host: "open.feishu.cn",
    respond(target, source) {
      if (target.pathname === "/open-apis/task/v2/tasks") return { status: 200, body: { data: { items: source.view } } };
      const guid = /^\/open-apis\/task\/v2\/tasks\/(.+)$/.exec(target.pathname)?.[1];
      if (guid !== undefined) {
        const item = (source.byId ?? source.view).find((one) => field(one, "task_id") === guid);
        return item === undefined ? { status: 404, body: null } : { status: 200, body: item };
      }
      return null;
    },
  },
};

/** 按字段名取原始 JSON 里的值：只认字段名，不解释字段含义。 */
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
    const response = ROUTES[platform].respond(target, source);
    // 报错只暴露路径：query 可能带凭据。
    if (response === null) throw new Error(`fakeHttp 没有登记这个请求：${target.pathname}`);
    return { status: response.status, headers: ROUTES[platform].headers ?? {}, body: response.body };
  };
}
