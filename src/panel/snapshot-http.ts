import type { Http } from "../core/provider";

/**
 * 把服务端快照当成上游的 Http：真 provider 照旧按端点发请求，这里按 URL 形状从快照里切答案。
 * 不能对任何 URL 都回同一整份列表——Gitee 的 open / progressing 各取一次会把同一张卡出两遍，
 * 按 id 补取单条时也会拿到整份数组。
 */
export type SnapshotFailure = "github" | "gitee";

export function createSnapshotHttp(
  githubItems: readonly unknown[],
  giteeItems: readonly unknown[],
  failed: readonly SnapshotFailure[] = [],
  githubPrevious: readonly unknown[] = [],
  giteePrevious: readonly unknown[] = [],
): Http {
  return async (url) => {
    const target = new URL(url);
    const single = /\/repos\/([^/]+\/[^/]+)\/issues\/([^/]+)$/.exec(target.pathname);
    const isGitee = target.hostname === "gitee.com";
    // 服务端已经判定这一家这一轮失败：让 provider 真的抛错，构建器才会退回上一轮并打水印；
    // 不能回一份空数组冒充「这一家今天没事」。
    if (failed.includes(isGitee ? "gitee" : "github")) {
      throw new Error(`${isGitee ? "Gitee" : "GitHub"} 这一轮没有取到数据`);
    }
    const items = isGitee ? giteeItems : githubItems;
    const previous = isGitee ? giteePrevious : githubPrevious;

    if (single !== null) {
      const repo = decodeURIComponent(single[1] ?? "");
      const number = decodeURIComponent(single[2] ?? "");
      // 活跃视图里找不到时，再去服务端上一轮按 id 核对回来的记录里找：
      // 命中已关闭的条目由构建器的 doneStates 收敛掉，这里不能替它判断。
      const hit = [...items, ...previous].find(
        (item) =>
          (isGitee ? giteeRepoOf(item) : githubRepoOf(item)) === repo &&
          String((item as { number?: unknown }).number) === number,
      );
      return hit === undefined
        ? { status: 404, headers: {}, body: null }
        : { status: 200, headers: {}, body: hit };
    }

    if (isGitee) {
      const state = target.searchParams.get("state");
      return {
        status: 200,
        headers: {},
        body:
          state === null
            ? [...giteeItems]
            : giteeItems.filter((item) => (item as { state?: unknown }).state === state),
      };
    }
    // GitHub 的 includeDone 分两次查（`is:open` / `is:closed`），这里必须按查询串各回一份：
    // 两次都回整份列表会把同一条算成两张卡，完整视图的条数也跟着翻倍。
    const query = target.searchParams.get("q") ?? "";
    const wantsOpen = query.includes("is:open");
    const wantsClosed = query.includes("is:closed");
    const itemsForQuery =
      wantsOpen === wantsClosed
        ? githubItems
        : githubItems.filter((item) =>
            wantsClosed
              ? (item as { state?: unknown }).state === "closed"
              : (item as { state?: unknown }).state !== "closed",
          );
    return { status: 200, headers: {}, body: { items: [...itemsForQuery] } };
  };
}

function giteeRepoOf(item: unknown): string | null {
  const it = item as { repository?: { full_name?: unknown } | null; html_url?: unknown };
  const fromApi = it.repository?.full_name;
  if (typeof fromApi === "string" && fromApi !== "") return fromApi;
  if (typeof it.html_url !== "string") return null;
  const { pathname } = new URL(it.html_url);
  const at = pathname.indexOf("/issues/");
  return at < 0 ? null : pathname.slice(1, at);
}

function githubRepoOf(item: unknown): string | null {
  const it = item as { repository_url?: unknown; html_url?: unknown };
  if (typeof it.repository_url === "string") {
    const fromApi = /\/repos\/([^/]+\/[^/]+)$/.exec(it.repository_url);
    if (fromApi?.[1] !== undefined) return fromApi[1];
  }
  if (typeof it.html_url !== "string") return null;
  const fromHtml = /^\/([^/]+\/[^/]+)\/issues\//.exec(new URL(it.html_url).pathname);
  return fromHtml?.[1] ?? null;
}