import type { Http } from "../src/core/provider";
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

/** 只碰公开仓库：ticket #11 的范围，私有仓库的那一档在 T12。 */
const SCOPE = "public_repo";

export function authorizeUrl(config: ServerConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.github.clientId);
  url.searchParams.set("redirect_uri", `${config.appBaseUrl}/cb/github`);
  url.searchParams.set("scope", SCOPE);
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

/** 换到 token 后再问一次「你是谁」：用户可能在授权页换了账号。 */
export async function fetchLogin(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl("https://api.github.com/user", { headers: apiHeaders(accessToken) });
  if (!res.ok) throw new Error(`GitHub /user 返回 ${res.status}`);
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string") throw new Error("GitHub /user 没有给出 login");
  return body.login;
}

/** 交给 provider 的取数通道：每个请求都带上这个会话的令牌，令牌不出服务端。 */
export function createGithubHttp(accessToken: string, fetchImpl: typeof fetch = fetch): Http {
  return async (url) => {
    const res = await fetchImpl(url, { headers: apiHeaders(accessToken) });
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
