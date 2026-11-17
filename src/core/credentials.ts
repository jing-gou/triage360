/**
 * seam 2：凭据生命周期决策器（`docs/PRD.md` 的 Testing Decisions 第 2 条）。
 *
 * 纯函数：不读系统时钟、不碰存储。时间一律 epoch 毫秒，由调用方注入。
 * Gitee 的一天过期与 Atlassian 的轮换失效都会静默让面板变空，这一块单独锁死。
 */

export type CredentialAction = "serve" | "lazy-refresh" | "scheduled-refresh" | "expire-to-reauth";

/** 过期前多久开始视为「该刷」：一次请求途中不该有过期风险，留 5 分钟。 */
export const REFRESH_SKEW_MS = 5 * 60_000;

export interface CredentialSnapshot {
  now: number;
  /** null = 没有已知过期时刻（平台不给或不作废）。 */
  expiresAt: number | null;
  /** 最近一次刷新**尝试**的时刻，成功失败都记——失败后下一次判定才能指向重连而不是空转。 */
  lastRefreshAt: number | null;
  isDemoTenant: boolean;
}

export function decideCredentialAction({
  now,
  expiresAt,
  lastRefreshAt,
  isDemoTenant,
}: CredentialSnapshot): CredentialAction {
  if (expiresAt === null) return "serve";
  if (now < expiresAt - REFRESH_SKEW_MS) return "serve";
  // 过期（或临近）之后已经刷新过、手里这枚却仍然过期：refresh token 救不回来，
  // 再刷只是空转。演示租户也走这条——由维护者重置，而不是让访客看一片空白。
  if (lastRefreshAt !== null && lastRefreshAt >= expiresAt) return "expire-to-reauth";
  // 演示租户归 cron + 分布式锁，请求路径不阻塞在刷新上；真实租户在访问时懒刷新。
  return isDemoTenant ? "scheduled-refresh" : "lazy-refresh";
}

/** 落库的形状：一对 token 与它们的过期时刻，永远整对出现。 */
export interface CredentialRecord {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  lastRefreshAt: number | null;
}

/** 平台刷新接口的返回；没发新 refresh token 时写 null，不假装轮换过。 */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export function freshCredential(tokens: RefreshedTokens, now: number): CredentialRecord {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    lastRefreshAt: now,
  };
}

export type RotationOutcome =
  | { kind: "committed"; record: CredentialRecord; retiredRefreshToken: string | null }
  | { kind: "failed"; record: CredentialRecord; retiredRefreshToken: null };

/**
 * 轮换的原子替换（Atlassian：每个新 refresh token 都让旧的那个失效）。
 * 先整对写库，写成功才把旧 refresh token 交回去退役；写失败返回原记录，
 * 旧的一对继续可用——坏一次轮换不丢租户，重连即可恢复。
 */
export function rotateCredential(
  current: CredentialRecord,
  refreshed: RefreshedTokens,
  persist: (next: CredentialRecord) => void,
  now: number,
): RotationOutcome {
  const replacedRefresh = refreshed.refreshToken !== null;
  const next = freshCredential(
    { ...refreshed, refreshToken: replacedRefresh ? refreshed.refreshToken : current.refreshToken },
    now,
  );
  try {
    persist(next);
  } catch {
    return { kind: "failed", record: current, retiredRefreshToken: null };
  }
  return {
    kind: "committed",
    record: next,
    retiredRefreshToken: replacedRefresh ? current.refreshToken : null,
  };
}

/** 记下一次刷新尝试（不碰 token 本身）；下一次判定据此从「再试」转到「重连」。 */
export function recordRefreshAttempt(record: CredentialRecord, at: number): CredentialRecord {
  return { ...record, lastRefreshAt: at };
}
