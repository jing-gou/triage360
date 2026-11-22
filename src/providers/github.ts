import { dueFrom, makeTaskId, remoteIdOf, tieredAuth, labelNames, type Provider, type RawItem, type Task, type TierChoice } from "../core/provider";

/**
 * 真实 GitHub provider（T09）：请求形状与 GitLab/Gitee 的差异全在这里消化。
 * 传输层仍由调用方注入（server 侧带 Bearer token 的那个 Http），所以 seam 1 的测试
 * 可以只截 URL 与归一结果，不连网。
 */

const API = "https://api.github.com";
const PROVIDER_ID = "github";
/** 一页上限 100；个人「指派给我」的未关闭条数远小于它，分页等真正越界再补。 */
const PER_PAGE = 100;

interface GithubIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  milestone?: { due_on: string | null } | null;
  repository_url?: string;
}

/**
 * `owner/repo`：优先读 API 给的 `repository_url`，缺了再从 `html_url` 的路径里认。
 * 它进 id 是为了让上一轮的按 id 补取知道该打哪个仓库的单条端点——
 * GitHub 没有跨仓库的批量端点。
 */
function repoOf(issue: GithubIssue): string {
  const fromApi = /\/repos\/([^/]+\/[^/]+)$/.exec(issue.repository_url ?? "");
  if (fromApi?.[1] !== undefined) return fromApi[1];
  const fromHtml = /^\/([^/]+\/[^/]+)\/issues\//.exec(new URL(issue.html_url).pathname);
  return fromHtml?.[1] ?? "unknown";
}

function splitRemoteId(remoteId: string): { repo: string; number: string } | null {
  const at = remoteId.lastIndexOf("#");
  if (at <= 0) return null;
  return { repo: remoteId.slice(0, at), number: remoteId.slice(at + 1) };
}

/** 源站非 200 时带上状态码抛出去：服务端要靠 401 分辨「授权失效」与其他上游故障。 */
export class GithubUpstreamError extends Error {
  constructor(
    readonly status: number,
    /** 403 也可能是限流；`X-RateLimit-Remaining: 0` 时不能把故障说成权限不足。 */
    readonly rateLimited = false,
  ) {
    super(`github 返回 ${status}`);
    this.name = "GithubUpstreamError";
  }
}

/** 公私两档的档位与措辞：假 provider 也认这一份，两处不各写一遍。 */
export const GITHUB_TIERS: readonly TierChoice[] = [
  { tier: "public", label: "只读公开仓库" },
  { tier: "private", label: "包含私有仓库" },
];

export function createGithubProvider(): Provider {
  return {
    id: PROVIDER_ID,

    async search(scope, http) {
      // 身份由 token 决定，`@me` 比传登录名更省一次对账。默认只查 `is:open`，让已关闭的条目走
      // 「从视图里消失 → 按 id 补取」那条既有路径；演示快照要核对 12 条精选，才把 closed 也带回来。
      const states = scope.includeDone === true ? ["is:open", "is:closed"] : ["is:open"];
      const batches = await Promise.all(
        states.map(async (state) => {
          const q = encodeURIComponent(`assignee:@me is:issue ${state}`);
          const res = await http(`${API}/search/issues?q=${q}&per_page=${PER_PAGE}`);
          if (res.status !== 200) {
            throw new GithubUpstreamError(res.status, res.headers["x-ratelimit-remaining"] === "0");
          }
          return ((res.body as { items?: RawItem[] }).items ?? []) as RawItem[];
        }),
      );
      return batches.flat();
    },

    // 每轮至多一次，且只针对从视图里消失的旧条目；单条端点 404 视为「这次没有」，
    // 调用方会把上一轮那条留着（见 today-list 的 carryOver）。
    async getByIds(ids, http) {
      const items = await Promise.all(
        ids.map(async (id) => {
          const parts = splitRemoteId(remoteIdOf(id));
          if (parts === null) return null;
          const res = await http(`${API}/repos/${parts.repo}/issues/${parts.number}`);
          return res.status === 200 ? (res.body as RawItem) : null;
        }),
      );
      return items.filter((one): one is RawItem => one !== null);
    },

    normalize(raw): Task {
      const issue = raw as unknown as GithubIssue;
      return {
        id: makeTaskId(PROVIDER_ID, `${repoOf(issue)}#${issue.number}`),
        providerId: PROVIDER_ID,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        updatedAt: new Date(issue.updated_at).toISOString(),
        ...(issue.milestone?.due_on ? dueFrom(issue.milestone.due_on) : { dueAt: undefined, duePrecision: undefined }),
      };
    },

    labels(raw) {
      return labelNames((raw as { labels?: unknown }).labels);
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
      return tieredAuth(`指派给 ${scope.assignee}`, GITHUB_TIERS);
    },
  };
}
