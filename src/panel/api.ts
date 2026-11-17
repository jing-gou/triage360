/**
 * 面板与后端之间只走两条路：拿会话标识（回调跳回来时放在 fragment 里）和取原始条目。
 * 令牌始终在服务端，这里能拿到的最多是一个不透明的会话标识。
 */

const SESSION_KEY = "triage360:session:v1";

/** 构建期的后端地址；没配就整条链路不启用，面板保持样例清单。 */
export const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").replace(/\/+$/, "");

export class UnauthenticatedError extends Error {}

/**
 * 回调把会话标识放在 fragment 里送回来：读一次就落进 sessionStorage，并把地址栏清干净。
 * 已经有过会话时直接复用；不清除它，刷新页面就得重新授权。
 */
export function adoptSessionFromUrl(): string | null {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
  const fromUrl = new URLSearchParams(hash).get("session");
  if (fromUrl !== null) {
    window.sessionStorage.setItem(SESSION_KEY, fromUrl);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return fromUrl;
  }
  return window.sessionStorage.getItem(SESSION_KEY);
}

export function forgetSession(): void {
  window.sessionStorage.removeItem(SESSION_KEY);
}

export interface GithubItems {
  items: unknown[];
  login: string;
}

export async function fetchGithubItems(base: string, session: string): Promise<GithubItems> {
  const res = await fetch(`${base}/api/items`, { headers: { Authorization: `Bearer ${session}` } });
  if (res.status === 401) throw new UnauthenticatedError(`items 返回 401`);
  if (!res.ok) throw new Error(`items 返回 ${res.status}`);
  return (await res.json()) as GithubItems;
}

/** 撤销（#13）：服务端物理删除该租户的 token 与全部数据，并当场验证；验证失败服务端回 500。 */
export async function revokeSession(base: string, session: string): Promise<void> {
  const res = await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!res.ok && res.status !== 401) throw new Error(`logout 返回 ${res.status}`);
}
