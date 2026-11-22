import { dueFrom, makeTaskId, remoteIdOf, uniformAuth, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 真实 Gitee provider（T15/#17）：请求形状与 GitHub 的差异全在这里消化。
 *
 * 走的是一手文档里的 `GET /api/v5/user/issues?filter=assigned`：一个跨仓库端点，不再按仓库遍历。
 * 状态分两次取 `open` 与 `progressing`——`state=all` 会把最近关闭的历史一起拉回来，
 * 按 `updated` 降序时还会把仍活跃的旧条目挤出第一页。
 */

const API = "https://gitee.com/api/v5";
const PROVIDER_ID = "gitee";
const PER_PAGE = 100;
/** 未关闭的两种状态；`closed` / `rejected` 由 doneStates 收敛。 */
const ACTIVE_STATES = ["open", "progressing"] as const;
/** 演示快照要核对的已完成状态；真实会话仍只取活跃视图，不把历史指派拉回来。 */
const DONE_STATES = ["closed", "rejected"] as const;

interface GiteeIssue {
  number: string | number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  deadline?: string | null;
  repository?: { full_name?: string } | null;
}

/** 源站非 200 时带上状态码抛出去：服务端要靠 401 分辨「授权失效」，403 的文案点名 User-Agent。 */
export class GiteeUpstreamError extends Error {
  constructor(readonly status: number) {
    super(
      status === 403
        ? "Gitee 返回 403：请求被拒。Gitee 的 token 与 API 请求必须带 User-Agent，也可能是应用权限或频率限制。"
        : `Gitee 返回 ${status}`,
    );
    this.name = "GiteeUpstreamError";
  }
}

function repoOf(issue: GiteeIssue): string {
  const fromApi = issue.repository?.full_name;
  if (typeof fromApi === "string" && fromApi !== "") return fromApi;
  const { pathname } = new URL(issue.html_url);
  const at = pathname.indexOf("/issues/");
  return at < 0 ? "unknown" : pathname.slice(1, at);
}

/** issue 编号只在仓库内唯一；字符串编号（`IDLSUI`）与数字编号一视同仁。 */
function giteeRemoteId(issue: GiteeIssue): string {
  return `${repoOf(issue)}#${String(issue.number)}`;
}

function splitRemoteId(remoteId: string): { repo: string; number: string } | null {
  const at = remoteId.lastIndexOf("#");
  if (at <= 0) return null;
  return { repo: remoteId.slice(0, at), number: remoteId.slice(at + 1) };
}

export function createGiteeProvider(): Provider {
  return {
    id: PROVIDER_ID,

    async search(scope, http) {
      const states = scope.includeDone === true ? [...ACTIVE_STATES, ...DONE_STATES] : ACTIVE_STATES;
      const batches = await Promise.all(
        states.map(async (state) => {
          const res = await http(
            `${API}/user/issues?filter=assigned&state=${state}&sort=updated&direction=desc&per_page=${PER_PAGE}`,
          );
          if (res.status !== 200) throw new GiteeUpstreamError(res.status);
          return Array.isArray(res.body) ? (res.body as RawItem[]) : [];
        }),
      );
      return batches.flat();
    },

    // 没有按 id 批量端点：解析出 repo#number 后打单仓库端点；404 视为「这次没有」，
    // 调用方会把上一轮那条留着（见 today-list 的 carryOver）。
    async getByIds(ids, http) {
      const items = await Promise.all(
        ids.map(async (id) => {
          const parts = splitRemoteId(remoteIdOf(id));
          if (parts === null) return null;
          const res = await http(
            `${API}/repos/${parts.repo}/issues/${encodeURIComponent(parts.number)}`,
          );
          return res.status === 200 ? (res.body as RawItem) : null;
        }),
      );
      return items.filter((one): one is RawItem => one !== null);
    },

    normalize(raw): Task {
      const issue = raw as unknown as GiteeIssue;
      return {
        id: makeTaskId(PROVIDER_ID, giteeRemoteId(issue)),
        providerId: PROVIDER_ID,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        updatedAt: new Date(issue.updated_at).toISOString(),
        ...(typeof issue.deadline === "string" && issue.deadline !== ""
          ? dueFrom(issue.deadline)
          : { dueAt: undefined, duePrecision: undefined }),
      };
    },

    doneStates() {
      return ["closed", "rejected"];
    },

    deletedStates() {
      return [];
    },

    pollIntervalMs() {
      return 30_000;
    },

    scopeDescriptor() {
      return uniformAuth("指派给我的 issue（含私有仓库）");
    },
  };
}