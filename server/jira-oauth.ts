import type { RefreshedTokens } from "../src/core/credentials";
import type { Http } from "../src/core/provider";
import type { ServerConfig } from "./config";

/**
 * Atlassian 3LO 的一手形状（developer.atlassian.com 的 3LO / OAuth 2.0 文档）：
 * - 授权：`GET https://auth.atlassian.com/authorize`，带 audience=api.atlassian.com、
 *   client_id、scope、redirect_uri、state、response_type=code、prompt=consent；
 * - 换 token / 续期：`POST https://auth.atlassian.com/oauth/token`，JSON 体；
 * - refresh token 会轮换：每次续期发回新的一对，旧的立即失效，必须整对替换；
 * - 取数前先 `GET https://api.atlassian.com/oauth/token/accessible-resources` 拿 cloudId，
 *   Jira REST 走 `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`。
 * 这些字符串只在这里出现，改一边就等于和后台登记的地址一起改。
 */

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const GATEWAY = "https://api.atlassian.com";
/** 官方写 access token 有效期 60 分钟；响应没给 expires_in 时按它算。 */
const DEFAULT_LIFETIME_MS = 60 * 60_000;
/**
 * 最小集合：读 issue 与用户身份；`offline_access` 才会发 refresh token。
 * 不用 `write:jira-work`——这个集成只读，少一个 scope 就少一份授权面。
 */
export const JIRA_SCOPES = "read:jira-work read:jira-user offline_access";

export function authorizeUrl(config: ServerConfig, state: string): string {
  if (config.atlassian === null) throw new Error("Atlassian 未配置");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("audience", "api.atlassian.com");
  url.searchParams.set("client_id", config.atlassian.clientId);
  url.searchParams.set("scope", JIRA_SCOPES);
  url.searchParams.set("redirect_uri", `${config.appBaseUrl}/cb/jira`);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  // 内部自证允许重新授权同一站点；不加这项时已授过权的账号会直接跳回去，看不到站点选择。
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

interface AtlassianTokenBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export async function exchangeCode(
  config: ServerConfig,
  code: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedTokens> {
  if (config.atlassian === null) throw new Error("Atlassian 未配置");
  return await requestToken(
    config,
    {
      grant_type: "authorization_code",
      code,
      client_id: config.atlassian.clientId,
      client_secret: config.atlassian.clientSecret,
      redirect_uri: `${config.appBaseUrl}/cb/jira`,
    },
    now,
    fetchImpl,
  );
}

/** 轮换：响应里的 refresh_token 是新的一枚，调用方必须整对替换。 */
export async function refreshAccessToken(
  config: ServerConfig,
  refreshToken: string,
  now: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshedTokens> {
  if (config.atlassian === null) throw new Error("Atlassian 未配置");
  return await requestToken(
    config,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.atlassian.clientId,
      client_secret: config.atlassian.clientSecret,
    },
    now,
    fetchImpl,
  );
}

async function requestToken(
  config: ServerConfig,
  body: Record<string, string>,
  now: number,
  fetchImpl: typeof fetch,
): Promise<RefreshedTokens> {
  if (config.atlassian === null) throw new Error("Atlassian 未配置");
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Atlassian 换 token 返回 ${res.status}`);
  const parsed = (await res.json().catch(() => ({}))) as AtlassianTokenBody;
  if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
    const reason = typeof parsed.error === "string" ? `：${parsed.error}` : "";
    throw new Error(`Atlassian 没有给出 access_token${reason}`);
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: typeof parsed.refresh_token === "string" && parsed.refresh_token !== "" ? parsed.refresh_token : null,
    expiresAt: now + (typeof parsed.expires_in === "number" ? parsed.expires_in * 1000 : DEFAULT_LIFETIME_MS),
  };
}

export interface JiraSite {
  cloudId: string;
  siteUrl: string;
}

/**
 * 一次授权可能覆盖多个站点。取第一个同时带 `read:jira-work` 的：
 * 只要身份与站点从同一枚 token 来，就不需要额外的站点选择 UI。
 */
export async function fetchAccessibleSite(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraSite> {
  const res = await fetchImpl(`${GATEWAY}/oauth/token/accessible-resources`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Atlassian accessible-resources 返回 ${res.status}`);
  const body: unknown = await res.json().catch(() => null);
  if (!Array.isArray(body)) throw new Error("Atlassian accessible-resources 不是数组");
  for (const one of body as { id?: unknown; url?: unknown; scopes?: unknown }[]) {
    if (
      typeof one.id === "string" &&
      one.id !== "" &&
      typeof one.url === "string" &&
      one.url !== "" &&
      Array.isArray(one.scopes) &&
      one.scopes.includes("read:jira-work")
    ) {
      return { cloudId: one.id, siteUrl: one.url.replace(/\/+$/, "") };
    }
  }
  throw new Error("Atlassian 授权里没有带 read:jira-work 的 Jira 站点");
}

export interface JiraIdentity {
  accountId: string;
  displayName: string;
}

/** 3LO 的 `/myself` 走网关；accountId 是 Atlassian 侧稳定身份，用来挡住换账号重连。 */
export async function fetchIdentity(
  accessToken: string,
  cloudId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JiraIdentity> {
  const res = await fetchImpl(`${GATEWAY}/ex/jira/${cloudId}/rest/api/3/myself`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Jira /myself 返回 ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { accountId?: unknown; displayName?: unknown };
  if (typeof body.accountId !== "string" || body.accountId === "") throw new Error("Jira /myself 没有给出 accountId");
  return {
    accountId: body.accountId,
    displayName: typeof body.displayName === "string" && body.displayName !== "" ? body.displayName : body.accountId,
  };
}

/** 交给 provider 的取数通道：Bearer 只活在这个闭包里，不出服务端。 */
export function createJiraHttp(accessToken: string, fetchImpl: typeof fetch = fetch): Http {
  return async (url) => {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, headers: Object.fromEntries(res.headers), body };
  };
}