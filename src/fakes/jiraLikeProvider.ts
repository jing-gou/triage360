import { makeTaskId, remoteIdOf, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 假 provider：按 Jira Cloud REST v3 的形状构造请求并解析响应，数据来自注入的源站替身。
 * 它和 GitHub 那家刻意形状不同——摘要、状态、时间都埋在 `fields` 里，时间还带本地偏移——
 * 为的是让 normalize 的定稿在 seam 1 上被两次不同的形状检验。
 *
 * v1 里 Jira 只作样例数据（见 `docs/PRD.md` 的真实程度表），不对外宣称已连接。
 */

const SITE = "https://sample-jira.atlassian.net";
const PROVIDER_ID = "jira";

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    updated: string;
    /** Jira Cloud 的 `duedate` 可以是 null；带时刻时同样带本地偏移。 */
    duedate?: string | null;
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

    // 一次 jql 取回整批 id：与 search 同一个端点，所以这家一轮就是一个 HTTP 请求（逐平台代价见 ADR-0002）。
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
        updatedAt: new Date(issue.fields.updated).toISOString(),
        dueAt: issue.fields.duedate ? new Date(issue.fields.duedate).toISOString() : undefined,
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

/** 样例数据：Jira 在 v1 只做内部自证，界面上必须写明「样例数据」（见 `docs/PRD.md` 的真实程度表）。 */
export const SAMPLE_JIRA_ISSUES: JiraIssue[] = [
  {
    id: "10031",
    key: "TRI-31",
    fields: { summary: "清理过期构建产物", status: { name: "In Progress" }, updated: "2026-11-16T15:12:00.000+0800" },
  },
  {
    id: "10027",
    key: "TRI-27",
    fields: { summary: "对接 3LO 回调", status: { name: "To Do" }, updated: "2026-11-15T20:40:00.000+0800" },
  },
  {
    id: "10019",
    key: "TRI-19",
    fields: { summary: "补监控面板", status: { name: "Done" }, updated: "2026-11-16T12:00:00.000+0800" },
  },
];
