import { makeTaskId, remoteIdOf, toDueInstant, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 假 provider：按 GitHub 的形状构造请求 URL 并解析响应，数据来自本文件字面量。
 * 它存在的目的是让 seam 1 与界面先跑起来；真实接入在 T09 顶替它。
 */

const REPO = "jing-gou/triage360";
const API = "https://api.github.com";
const PROVIDER_ID = "github";

interface GithubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  /** GitHub 的 issue 自己没有截止日期，`due_on` 挂在 milestone 上，且 milestone 与 due_on 都可以是 null。 */
  milestone?: { due_on: string | null } | null;
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

    // 一次批量请求取回全部 id：每 provider 每轮 ≈ 一个请求，不是每任务一个。
    async getByIds(ids, http) {
      const query = encodeURIComponent(ids.map(remoteIdOf).join(","));
      const res = await http(`${API}/issues?ids=${query}`);
      return (res.body as { items: RawItem[] }).items;
    },

    normalize(raw): Task {
      const issue = raw as unknown as GithubIssue;
      return {
        id: makeTaskId(PROVIDER_ID, issue.number),
        providerId: PROVIDER_ID,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        updatedAt: new Date(issue.updated_at).toISOString(),
        dueAt: issue.milestone?.due_on ? toDueInstant(issue.milestone.due_on) : undefined,
      };
    },

    doneStates() {
      return ["closed"];
    },

    deletedStates() {
      return [];
    },

    // 占位数字：Q6 只定了「可见标签页轮询 + 手动 refresh」，间隔本身还没决策。
    pollIntervalMs() {
      return 30_000;
    },

    scopeDescriptor(scope) {
      return `${REPO} · 指派给 ${scope.assignee}`;
    },
  };
}
