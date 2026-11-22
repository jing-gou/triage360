import type { RefreshedTokens } from "../src/core/credentials";
import type { Http } from "../src/core/provider";
import type { ServerConfig } from "./config";

/**
 * Gitee OAuth 的一手形状（gitee.com/api/v5/oauth_doc）：
 * - 授权：`GET https://gitee.com/oauth/authorize`，query 带 client_id / redirect_uri / response_type=code / scope / state
 * - 换 token：`POST https://gitee.com/oauth/token`，form 体带 grant_type=authorization_code / code / client_id / redirect_uri / client_secret
 * - 续期：同一端点 `grant_type=refresh_token`；官方原话「access_token 有效期为一天」
 * - token 与 API 请求缺 `User-Agent` 会返回 403（官方文档点名的坑）
 * 这些字符串只在这里出现，改一边就等于和后台登记的地址一起改。
 */

const AUTHORIZE_URL = "https://gitee.com/oauth/authorize";
const TOKEN_URL = "https://gitee.com/oauth/token";
const API = "https://gitee.com/api/v5";
/** 非空即可；官方只要求请求带 User-Agent。 */
const USER_AGENT = "triage360/0.1";
/** 官方写明一天；响应没给 expires_in 时按它算。 */
const DEFAULT_LIFETIME_MS = 24 * 60 * 60_000;
/** 最小集合：身份、私有仓库与 issue 读取。没有公私粒度，也没有 pull_requests/notes 的需要。 */
export const GITEE_SCOPES = "user_info projects issues";

export function authorizeUrl(config: ServerConfig, state: string): string {
  if (config.gitee === null) throw new Error("Gitee 未配置");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.gitee.clientId);
  url.searchParams.set("redirect_uri", `${config.appBaseUrl}/cb/gitee`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GITEE_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

interface GiteeTokenBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  created_at?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export async function exchangeCode(
  config: ServerConfig,
  code: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedTokens> {
  if (config.gitee === null) throw new Error("Gitee 未配置");
  return await requestToken(
    config,
    {
      grant_type: "authorization_code",
      code,
      client_id: config.gitee.clientId,
      redirect_uri: `${config.appBaseUrl}/cb/gitee`,
      client_secret: config.gitee.clientSecret,
    },
    now,
    fetchImpl,
  );
}

/** Gitee 的 refresh token 跟 access token 一起发；没发新的就沿用旧值（seam 2 会保留）。 */
export async function refreshAccessToken(
  config: ServerConfig,
  refreshToken: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedTokens> {
  if (config.gitee === null) throw new Error("Gitee 未配置");
  return await requestToken(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.gitee.clientId,
      client_secret: config.gitee.clientSecret,
    },
    now,
    fetchImpl,
  );
}

async function requestToken(
  config: ServerConfig,
  form: Record<string, string>,
  now: number,
  fetchImpl: typeof fetch,
): Promise<RefreshedTokens> {
  if (config.gitee === null) throw new Error("Gitee 未配置");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error("Gitee 拒绝了 token 请求（403）：请求必须带 User-Agent，或应用凭据/回调地址与后台登记不一致。");
    }
    throw new Error(`Gitee 换 token 返回 ${res.status}`);
  }
  const body = (await res.json().catch(() => ({}))) as GiteeTokenBody;
  if (typeof body.access_token !== "string" || body.access_token === "") {
    const reason = typeof body.error === "string" ? `：${body.error}` : "";
    throw new Error(`Gitee 没有给出 access_token${reason}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    expiresAt: expiresAtOf(body, now),
  };
}

function expiresAtOf(body: GiteeTokenBody, now: number): number {
  const created = typeof body.created_at === "number" ? body.created_at * 1000 : now;
  const lifetime = typeof body.expires_in === "number" ? body.expires_in * 1000 : DEFAULT_LIFETIME_MS;
  return created + lifetime;
}

/** 换到 token 后再问一次「你是谁」：第二家授权可能换过账号。 */
export async function fetchIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(`${API}/user`);
  url.searchParams.set("access_token", accessToken);
  const res = await fetchImpl(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Gitee /user 返回 ${res.status}`);
  const body = (await res.json()) as { login?: unknown };
  if (typeof body.login !== "string" || body.login === "") throw new Error("Gitee /user 没有给出 login");
  return body.login;
}

/**
 * 交给 provider 的取数通道：token 按官方文档放在 query（不是 Authorization 头），
 * 每个请求都带 User-Agent；令牌不出服务端。错误响应体也不回传给调用方之外的日志。
 */
export function createGiteeHttp(accessToken: string, fetchImpl: typeof fetch = fetch): Http {
  return async (url) => {
    const target = new URL(url);
    target.searchParams.set("access_token", accessToken);
    const res = await fetchImpl(target.toString(), {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  };
}