import type { Http } from "../core/provider";

/**
 * 把服务端快照当成上游的 Http：真 provider 照旧按端点发请求，这里按 URL 形状从快照里切答案。
 * 不能对任何 URL 都回同一整份列表——Gitee 的 open / progressing 各取一次会把同一张卡出两遍，
 * 按 id 补取单条时也会拿到整份数组。
 */
export function createSnapshotHttp(
  githubItems: readonly unknown[],
  giteeItems: readonly unknown[],
): Http {
  return async (url) => {
    const target = new URL(url);
    const single = /\/repos\/([^/]+\/[^/]+)\/issues\/([^/]+)$/.exec(target.pathname);
    const isGitee = target.hostname === "gitee.com";
    const items = isGitee ? giteeItems : githubItems;

    if (single !== null) {
      const repo = decodeURIComponent(single[1] ?? "");
      const number = decodeURIComponent(single[2] ?? "");
      const hit = items.find(
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
    return { status: 200, headers: {}, body: { items: [...githubItems] } };
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