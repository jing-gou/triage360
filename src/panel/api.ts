/**
 * 面板与后端之间只走两条路：拿会话标识（回调跳回来时放在 fragment 里）和取原始条目。
 * 令牌始终在服务端，这里能拿到的最多是一个不透明的会话标识。
 */

import type { Tier } from "../core/provider";
import type { ReasonCard } from "../core/reason-card";

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

/** 服务端观察到的各档实际授权（`X-OAuth-Scopes` 与授权时的真值）。 */
export interface TierGrant {
  /** `null` = 响应头缺失、实际授予未知；空数组才是「有头但没列 scope」。 */
  scopes: string[] | null;
  /** 这一档应有、实际没拿到的 scope；非空就是 GitHub 侧把授权改小了（T12）。未知时不报。 */
  missing: string[];
}

export interface GithubAuth {
  grants: Partial<Record<Tier, TierGrant>>;
  /** 这一轮取数实际用了哪一档；只有 Gitee 连着、GitHub 未授权时是 `null`。 */
  used: Tier | null;
  expected: Record<Tier, string[]>;
  /** 这一轮取数里被 GitHub 判 401、已从服务端删掉的档。 */
  dropped: Tier[];
}

/** 一家的取数结果：`none` 是没连过，`reauth` 是授权被摘掉，`unavailable` 是上游故障但授权还在。 */
export interface ProviderStatus {
  status: "ok" | "reauth" | "unavailable" | "none";
  /** `unavailable` 时给一句可读的原因；不含上游原文之外的凭据。 */
  detail?: string;
}

/** 上一轮见过、这一轮活跃视图没返回的条目：服务端按 id 向源站核对后的原始记录。 */
export interface PreviousRecords {
  previous: unknown[];
}

/** Gitee 侧这一段：状态与条目一起回来。 */
export interface GiteeAuth extends ProviderStatus, PreviousRecords {
  items: unknown[];
}

/** `forbidden` 只在这一轮真的是 403（且非限流）时出现，不能只看库存的 missing scope 猜。 */
export type GithubStatus = ProviderStatus & PreviousRecords & { forbidden?: true };

export interface ItemsPayload {
  /** GitHub 的原始条目；GitHub 未授权或这一轮取数失败时为空数组。 */
  items: unknown[];
  login: string;
  github: GithubStatus;
  auth: GithubAuth;
  gitee: GiteeAuth;
  /** 这一轮服务端手里各家的授权是否还在；面板据此决定构建哪几家。 */
  connected: { github: boolean; gitee: boolean };
}

export async function fetchItems(
  base: string,
  session: string,
  previousIds: readonly string[] = [],
): Promise<ItemsPayload> {
  const query = new URLSearchParams();
  for (const id of previousIds.slice(0, 100)) query.append("previous", id);
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
  const res = await fetch(`${base}/api/items${suffix}`, { headers: { Authorization: `Bearer ${session}` } });
  if (res.status === 401) throw new UnauthenticatedError(`items 返回 401`);
  if (!res.ok) throw new Error(`items 返回 ${res.status}`);
  return (await res.json()) as ItemsPayload;
}

/** 首次访客看的公开演示快照：服务端定时从演示账号取，访客不需要任何授权。 */
export interface DemoPayload {
  generatedAt: string;
  items: unknown[];
  gitee: unknown[];
  connected: { github: boolean; gitee: boolean };
}

export async function fetchDemoItems(base: string): Promise<DemoPayload> {
  const res = await fetch(`${base}/api/demo/items`);
  if (!res.ok) throw new Error(`demo/items 返回 ${res.status}`);
  return (await res.json()) as DemoPayload;
}

/** 授权页地址：GitHub 按档取，Gitee 没有档位。 */
export type AuthTarget = { provider: "github"; tier: Tier } | { provider: "gitee" };

/** 第二档（或重新）授权 / Gitee 首次授权：服务端把这次授权挂回已有租户，返回平台授权页地址。 */
export async function requestAuthUrl(base: string, session: string, target: AuthTarget): Promise<string> {
  const res = await fetch(`${base}/api/auth-url`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: JSON.stringify(target.provider === "gitee" ? { provider: "gitee" } : { tier: target.tier }),
  });
  if (res.status === 401) throw new UnauthenticatedError(`auth-url 返回 401`);
  if (!res.ok) throw new Error(`auth-url 返回 ${res.status}`);
  const body = (await res.json()) as { url?: unknown };
  if (typeof body.url !== "string") throw new Error("auth-url 没有给出授权页地址");
  return body.url;
}

/** 撤销（#13）：服务端物理删除该租户的 token 与全部数据，并当场验证；验证失败服务端回 500。 */
export async function revokeSession(base: string, session: string): Promise<void> {
  const res = await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}` },
  });
  if (!res.ok && res.status !== 401) throw new Error(`logout 返回 ${res.status}`);
}

export interface ReasonReply {
  text: string;
}

/** 单张卡的理由：服务端 1.8 秒超时；客户端多留 200ms 当兜底，超了就是失败，由调用方回落。 */
export async function requestReason(base: string, session: string, card: ReasonCard): Promise<ReasonReply> {
  const res = await fetch(`${base}/api/reason`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/json" },
    body: JSON.stringify({ card }),
    signal: AbortSignal.timeout(2000),
  });
  if (res.status === 401) throw new UnauthenticatedError(`reason 返回 401`);
  if (!res.ok) throw new Error(`reason 返回 ${res.status}`);
  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== "string" || body.text === "") throw new Error("reason 没有给出文案");
  return { text: body.text };
}
