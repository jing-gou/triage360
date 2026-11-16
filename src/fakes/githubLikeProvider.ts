import type { Http, Provider, RawItem, Task } from "../core/provider";

/**
 * 假 provider：按 GitHub 的形状构造请求 URL 并解析响应，数据来自本文件字面量。
 * 它存在的目的是让 seam 1 与界面先跑起来；真实接入在 T09 顶替它。
 */

const REPO = "jing-gou/triage360";
const API = "https://api.github.com";
const PROVIDER_ID = "github-fake";

interface GithubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
}

/** 数组顺序刻意不是最终顺序：界面顺序由 seam 1 的输出决定。 */
export const FIXTURE_ISSUES: GithubIssue[] = [
  {
    number: 1041,
    title: "修复登录回调",
    html_url: `https://github.com/${REPO}/issues/1041`,
    state: "open",
    updated_at: "2026-11-16T08:20:00Z",
  },
  {
    number: 1039,
    title: "整理提交材料",
    html_url: `https://github.com/${REPO}/issues/1039`,
    state: "open",
    updated_at: "2026-11-14T15:02:00Z",
  },
  {
    number: 1040,
    title: "写本周周报",
    html_url: `https://github.com/${REPO}/issues/1040`,
    state: "open",
    updated_at: "2026-11-15T09:41:00Z",
  },
];

export function createGithubLikeProvider(): Provider {
  return {
    id: PROVIDER_ID,

    async search(scope, http) {
      const query = encodeURIComponent(`assignee:${scope.assignee} repo:${REPO}`);
      const res = await http(`${API}/search/issues?q=${query}`);
      return (res.body as { items: RawItem[] }).items;
    },

    async getByIds(ids, http) {
      return Promise.all(
        ids.map(async (id) => {
          const number = id.slice(PROVIDER_ID.length + 1);
          const res = await http(`${API}/repos/${REPO}/issues/${number}`);
          return res.body as RawItem;
        }),
      );
    },

    normalize(raw): Task {
      const issue = raw as unknown as GithubIssue;
      return {
        id: `${PROVIDER_ID}:${issue.number}`,
        providerId: PROVIDER_ID,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        updatedAt: issue.updated_at,
      };
    },

    doneStates() {
      return ["closed"];
    },

    deletedStates() {
      return [];
    },

    pollIntervalMs() {
      return 30_000;
    },

    scopeDescriptor(scope) {
      return `${REPO} · 指派给 ${scope.assignee}`;
    },
  };
}

/** 取数替身：一张路由表，不发真实请求。报错只暴露路径，query 可能带凭据。 */
export const fixtureHttp: Http = async (url) => {
  const path = new URL(url).pathname;

  if (path === "/search/issues") {
    return { status: 200, body: { items: [...FIXTURE_ISSUES] } };
  }

  const single = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
  const issue = single && FIXTURE_ISSUES.find((i) => i.number === Number(single[1]));
  if (issue) {
    return { status: 200, body: issue };
  }

  throw new Error(`fixtureHttp 没有登记这个路径：${path}`);
};
