import { makeTaskId, remoteIdOf, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 假 provider：按 Jira Cloud REST v3 的形状构造请求并解析响应，数据来自注入的源站替身。
 * 它和 GitHub 那家刻意形状不同——摘要、状态、时间都埋在 `fields` 里，时间还带本地偏移——
 * 为的是让 normalize 的定稿在 seam 1 上被两次不同的形状检验。
 *
 * v1 里 Jira 只作样例数据（见 `docs/PRD.md` 的真实程度表），不对外宣称已连接。
 */

const SITE = "https://sample-jira.atlassian.net";
const PROVIDER_ID = "jira-sample";

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    updated: string;
  };
}

export function createJiraLikeProvider(): Provider {
  return {
    id: PROVIDER_ID,

    async search(_scope, http) {
      // Jira 的「派给我」在 JQL 里是 currentUser()，用户名不进 JQL。
      const jql = encodeURIComponent(`assignee = currentUser() ORDER BY updated DESC`);
      const res = await http(`${SITE}/rest/api/3/search?jql=${jql}`);
      return (res.body as { issues: RawItem[] }).issues;
    },

    // 一次 jql 取回整批 id：与 search 同一个端点，每 provider 每轮 ≈ 一个批量请求。
    async getByIds(ids, http) {
      const jql = encodeURIComponent(`id in (${ids.map(remoteIdOf).join(",")})`);
      const res = await http(`${SITE}/rest/api/3/search?jql=${jql}`);
      return (res.body as { issues: RawItem[] }).issues;
    },

    normalize(raw): Task {
      const issue = raw as unknown as JiraIssue;
      return {
        id: makeTaskId(PROVIDER_ID, issue.id),
        providerId: PROVIDER_ID,
        title: issue.fields.summary,
        url: `${SITE}/browse/${issue.key}`,
        state: issue.fields.status.name,
        // 定稿口径：`updatedAt` 一律换算成 UTC。各家原始格式不保证可比。
        updatedAt: new Date(issue.fields.updated).toISOString(),
      };
    },

    doneStates() {
      return ["Done"];
    },

    deletedStates() {
      return ["Deleted"];
    },

    // 占位数字：Q6 只定了「可见标签页轮询 + 手动 refresh」，间隔本身还没决策。
    pollIntervalMs() {
      return 60_000;
    },

    scopeDescriptor(scope) {
      return `样例站点 · 指派给 ${scope.assignee}`;
    },
  };
}
