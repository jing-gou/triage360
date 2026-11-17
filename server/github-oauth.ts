import type { Http, Tier } from "../src/core/provider";
import type { ServerConfig } from "./config";

/**
 * GitHub OAuth 的一手形状（docs.github.com › Authorizing OAuth apps）：
 * - 授权：`GET https://github.com/login/oauth/authorize`，query 带 client_id / redirect_uri / scope / state
 * - 换 token：`POST https://github.com/login/oauth/access_token`，`Accept: application/json`，
 *   form 体带 client_id / client_secret / code / redirect_uri
 * - 用 token 调 API：`Authorization: Bearer <token>`
 * 这些字符串只在这里出现，改一边就等于和三家的登记一起改。
 */

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * 公私两档（T12）：两次独立授权、两个 token 并存，官方 "Creating multiple tokens for OAuth apps"
 * 背书这一形态。`repo` 本身包含公开仓库，所以取数优先用高档 token。
 */
export const SCOPES: Record<Tier, string> = { public: "public_repo", private: "repo" };

/**
 * 实际授予是否覆盖这一档应有的 scope；返回缺的那些。
 * `repo` 是 `public_repo` 的超集，所以公开档拿到 `repo` 不算被缩小，其余按字面比。
 */
export function missingScopes(expected: readonly string[], actual: readonly string[]): string[] {
  return expected.filter((one) => !actual.includes(one) && !(one === SCOPES.public && actual.includes(SCOPES.private)));
}

export function isTier(value: string | null): value is Tier {
  return value === "public" || value === "private";
}

export function authorizeUrl(config: ServerConfig, state: string, tier: Tier): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.github.clientId);
  url.searchParams.set("redirect_uri", `${config.appBaseUrl}/cb/github`);
  url.searchParams.set("scope", SCOPES[tier]);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface TokenGrant {
  accessToken: string;
}

export async function exchangeCode(
  config: ServerConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenGrant> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: `${config.appBaseUrl}/cb/github`,
    }).toString(),
  });
  if (!res.ok) throw new Error(`GitHub 换 token 返回 ${res.status}`);
  const body = (await res.json()) as { access_token?: unknown; error?: unknown };
  if (typeof body.access_token !== "string") {
    const reason = typeof body.error === "string" ? `：${body.error}` : "";
    throw new Error(`GitHub 没有给出 access_token${reason}`);
  }
  return { accessToken: body.access_token };
}

/** 真值只在响应头里：用户在 GitHub 侧把 `repo` 编辑成 `public_repo` 时，这里会诚实变少（T12）。 */
function parseScopes(header: string): string[] {
  return header
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

/** 换到 token 后再问一次「你是谁」：用户可能在授权页换了账号。顺带取回**实际**授予的 scope；响应头缺失时给 `null`。 */
export async function fetchIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ login: string; scopes: string[] | null }> {
  const res = await fetchImpl("https://api.github.com/user", { headers: apiHeaders(accessToken) });
  if (!res.ok) throw new Error(`GitHub /user 返回 ${res.status}`);
  const header = res.headers.get("x-oauth-scopes");
  const scopes = header === null ? null : parseScopes(header);
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string") throw new Error("GitHub /user 没有给出 login");
  return { login: body.login, scopes };
}

/**
 * 交给 provider 的取数通道：每个请求都带上这个会话的令牌，令牌不出服务端。
 * `onScopes` 让调用方顺路观察 `X-OAuth-Scopes`：授权在 GitHub 侧被改小时，下一次取数就能看见。
 */
export function createGithubHttp(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
  onScopes?: (scopes: string[]) => void,
): Http {
  return async (url) => {
    const res = await fetchImpl(url, { headers: apiHeaders(accessToken) });
    const scopesHeader = res.headers.get("x-oauth-scopes");
    if (onScopes !== undefined && scopesHeader !== null) onScopes(parseScopes(scopesHeader));
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  };
}

function apiHeaders(accessToken: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
