import { makeTaskId, remoteIdOf, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 假 provider：按 Gitee Open API v5 的「仓库粒度 issue」形状构造请求，数据来自注入的源站替身。
 *
 * 这里刻意按仓库遍历而不是发一条「指派给我的 issue」查询：Gitee 官方没有那个跨仓库端点
 * （见 `research/platform-limits-and-landing-form.md` 的 Gitee 节）。契约容得下一个只能遍历的平台，
 * 是这张样例卡存在的第二个理由；每轮请求数随仓库数增长的代价由 T15 真连时决定。
 */

const API = "https://gitee.com";
const PROVIDER_ID = "gitee";
const REPOS = ["jing-gou/triage360", "jing-gou/legacy-importer"];

interface GiteeIssue {
  number: number;
  title: string;
  html_url: string;
  /** Gitee 的 issue 状态字面量：new / ongoing / progress / finished。 */
  state: string;
  updated_at: string;
}

/**
 * Gitee 的 issue number 只在仓库内唯一，而任务 id 要跨轮次唯一，所以远端 id 里带上仓库。
 * 这不是排版偏好：不带仓库的话，两个仓库的 313 号会归成同一条。
 * 仓库从 issue 自己的 html_url 里取——遍历仓库时响应体不带仓库名，只有 URL 带。
 */
function giteeRemoteId(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function repoOf(html_url: string): string {
  const { pathname } = new URL(html_url);
  const at = pathname.indexOf("/issues/");
  // 报错只暴露路径：query 可能带凭据。仓库 issue 端点会带回 PR（/pulls/），那种条目归不成 id。
  if (at < 0) throw new Error(`Gitee 的 html_url 不是 issue 形状：${pathname}`);
  return pathname.slice(1, at);
}

function parseRemoteId(remoteId: string): { repo: string; number: number } {
  const at = remoteId.lastIndexOf("#");
  if (at < 0) throw new Error(`Gitee 的远端 id 缺少仓库段：${remoteId}`);
  return { repo: remoteId.slice(0, at), number: Number(remoteId.slice(at + 1)) };
}

export function createGiteeLikeProvider(): Provider {
  return {
    id: PROVIDER_ID,

    async search(scope, http) {
      const batches = await Promise.all(
        REPOS.map(async (repo) => {
          const res = await http(`${API}/api/v5/repos/${repo}/issues?assignee=${scope.assignee}`);
          return res.body as RawItem[];
        }),
      );
      return batches.flat();
    },

    // 也没有按 id 批量端点：一个 id 一次请求。
    async getByIds(ids, http) {
      const raws = await Promise.all(
        ids.map(async (id) => {
          const { repo, number } = parseRemoteId(remoteIdOf(id));
          const res = await http(`${API}/api/v5/repos/${repo}/issues/${number}`);
          return [res.body] as RawItem[];
        }),
      );
      return raws.flat();
    },

    normalize(raw): Task {
      const issue = raw as unknown as GiteeIssue;
      return {
        id: makeTaskId(PROVIDER_ID, giteeRemoteId(repoOf(issue.html_url), issue.number)),
        providerId: PROVIDER_ID,
        title: issue.title,
        url: issue.html_url,
        state: issue.state,
        updatedAt: new Date(issue.updated_at).toISOString(),
      };
    },

    doneStates() {
      return ["finished"];
    },

    deletedStates() {
      return [];
    },

    // 占位数字：Q6 只定了「可见标签页轮询 + 手动 refresh」，间隔本身还没决策。
    pollIntervalMs() {
      return 30_000;
    },

    scopeDescriptor(scope) {
      return `${REPOS.length} 个仓库 · 指派给 ${scope.assignee}`;
    },
  };
}

/** 样例数据：Gitee 侧 v1 是假 provider（真连在 T15）。 */
export const SAMPLE_GITEE_ISSUES: GiteeIssue[] = [
  {
    number: 313,
    title: "回调地址改名后失效",
    html_url: `https://gitee.com/${REPOS[0]}/issues/313`,
    state: "progress",
    updated_at: "2026-11-16T17:05:00+08:00",
  },
  {
    number: 140,
    title: "Login 接口偶发 500",
    html_url: `https://gitee.com/${REPOS[1]}/issues/140`,
    state: "new",
    updated_at: "2026-11-16T11:40:00+08:00",
  },
  {
    number: 128,
    title: "导出历史工时报表",
    html_url: `https://gitee.com/${REPOS[1]}/issues/128`,
    state: "finished",
    updated_at: "2026-11-16T09:15:00+08:00",
  },
];
