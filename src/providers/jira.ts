import { dueFrom, makeTaskId, remoteIdOf, uniformAuth, labelNames, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 真实 Jira Cloud provider（#19 内部自证）：与另外两家的差异都在这里消化。
 *
 * 3LO 的 REST 调用必须走 `api.atlassian.com/ex/jira/{cloudId}` 网关，不能打站点域名；
 * issue 的全局 id 进任务 id（ADR-0004），单条补取按它走 `/rest/api/3/issue/{id}`。
 */

const PROVIDER_ID = "jira";
const FIELDS = "summary,status,updated,duedate";
const MAX_RESULTS = 50;

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    status?: { statusCategory?: { key?: string } | null } | null;
    updated: string;
    duedate?: string | null;
  };
}

/** 源站非 200 时带上状态码抛出去：服务端要靠 401 分辨「授权失效」与其他上游故障。 */
export class JiraUpstreamError extends Error {
  constructor(readonly status: number) {
    super(`Jira 返回 ${status}`);
    this.name = "JiraUpstreamError";
  }
}

export interface JiraProviderOptions {
  cloudId: string;
  siteUrl: string;
}

export function createJiraProvider({ cloudId, siteUrl }: JiraProviderOptions): Provider {
  const api = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;

  return {
    id: PROVIDER_ID,

    async search(scope, http) {
      const jql =
        scope.includeDone === true
          ? "assignee = currentUser() ORDER BY updated DESC"
          : "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
      const url = new URL(`${api}/search/jql`);
      url.searchParams.set("jql", jql);
      url.searchParams.set("fields", FIELDS);
      url.searchParams.set("maxResults", String(MAX_RESULTS));
      const res = await http(url.toString());
      if (res.status !== 200) throw new JiraUpstreamError(res.status);
      return ((res.body as { issues?: RawItem[] }).issues ?? []) as RawItem[];
    },

    async getByIds(ids, http) {
      const items = await Promise.all(
        ids.map(async (id) => {
          const url = new URL(`${api}/issue/${encodeURIComponent(remoteIdOf(id))}`);
          url.searchParams.set("fields", FIELDS);
          const res = await http(url.toString());
          return res.status === 200 ? (res.body as RawItem) : null;
        }),
      );
      return items.filter((one): one is RawItem => one !== null);
    },

    normalize(raw): Task {
      const issue = raw as unknown as JiraIssue;
      const due = issue.fields.duedate;
      return {
        id: makeTaskId(PROVIDER_ID, issue.id),
        providerId: PROVIDER_ID,
        title: issue.fields.summary,
        url: `${siteUrl}/browse/${issue.key}`,
        state: issue.fields.status?.statusCategory?.key ?? "unknown",
        updatedAt: new Date(issue.fields.updated).toISOString(),
        ...(typeof due === "string" && due !== ""
          ? dueFrom(due)
          : { dueAt: undefined, duePrecision: undefined }),
      };
    },

    labels(raw) {
      return labelNames((raw as { fields?: { labels?: unknown } }).fields?.labels);
    },

    doneStates() {
      return ["done"];
    },

    deletedStates() {
      return [];
    },

    pollIntervalMs() {
      return 60_000;
    },

    scopeDescriptor() {
      return uniformAuth("指派给我的未完成 Jira issue");
    },
  };
}