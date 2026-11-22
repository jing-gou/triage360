import { decideCredentialAction, recordRefreshAttempt, rotateCredential, type CredentialRecord } from "../src/core/credentials";
import type { RawItem, Tier } from "../src/core/provider";
import { createGiteeProvider, GiteeUpstreamError } from "../src/providers/gitee";
import { createGithubProvider, GithubUpstreamError } from "../src/providers/github";
import type { ServerConfig } from "./config";
import { createGiteeHttp, refreshAccessToken } from "./gitee-oauth";
import { createGithubHttp } from "./github-oauth";
import type { EncryptedStore, GiteeCredential, Tenant } from "./store";

/**
 * 上游取数的共用路径：浏览器会话与演示租户的定时刷新都走这里。
 * 两家的失败互不遮掩——一家 401 只摘这一家的授权，另一家的条目照常返回（ADR-0003）。
 */

export interface GithubSnapshot {
  items: RawItem[];
  used: Tier;
  dropped: Tier[];
}

export type GiteeSnapshot =
  | { status: "ok"; items: RawItem[] }
  | { status: "reauth" }
  | { status: "unavailable"; detail: string };

/**
 * 只放行 provider 归一化要用的字段（Q23 的字段边界）：正文、评论、diff 既不进 demo.json，
 * 也不经 `/api/items` 发给浏览器；以后界面真要更多字段，先改这里再改声明。
 */
function githubMeta(item: RawItem): RawItem {
  const milestone = item.milestone as { due_on?: unknown } | null | undefined;
  return {
    number: item.number,
    title: item.title,
    html_url: item.html_url,
    state: item.state,
    updated_at: item.updated_at,
    milestone: milestone == null ? null : { due_on: milestone.due_on ?? null },
    repository_url: item.repository_url,
  };
}

function giteeMeta(item: RawItem): RawItem {
  const repository = item.repository as { full_name?: unknown } | null | undefined;
  return {
    number: item.number,
    title: item.title,
    html_url: item.html_url,
    state: item.state,
    updated_at: item.updated_at,
    deadline: item.deadline ?? null,
    repository: repository == null ? null : { full_name: repository.full_name },
  };
}

export class Upstream {
  /**
   * 同一份 Gitee 授权只跑一次刷新：两个请求同时看见过期就会各换一次，后失败的那个
   * 会把刚轮换好的 token 写回旧的。键用 Gitee 登录名而不是会话——演示租户的定时器
   * 与维护者自己的会话可能是同一份授权，只按会话锁不住这条竞态。
   */
  private readonly giteeInFlight = new Map<string, Promise<GiteeSnapshot | null>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store: EncryptedStore,
    private readonly now: () => number,
  ) {}

  async github(tenant: Tenant, sessionId: string | null): Promise<GithubSnapshot | null> {
    const order: Tier[] = tenant.grants.private !== undefined ? ["private", "public"] : ["public"];
    const dropped: Tier[] = [];
    for (const tier of order) {
      const grant = tenant.grants[tier];
      if (grant === undefined) continue;
      let scopesObserved = false;
      let liveScopes: string[] | null = null;
      const http = createGithubHttp(grant.token, fetch, (scopes) => {
        scopesObserved = true;
        liveScopes = scopes;
      });
      try {
        const items = await createGithubProvider().search({ assignee: tenant.githubLogin ?? tenant.login }, http);
        if (scopesObserved && sessionId !== null) {
          this.store.setScopes(sessionId, tier, liveScopes);
          grant.scopes = liveScopes;
        }
        return { items: items.map(githubMeta), used: tier, dropped };
      } catch (error) {
        if (error instanceof GithubUpstreamError && error.status === 401) {
          if (sessionId !== null) this.store.removeGrant(sessionId, tier);
          else if (tenant.githubLogin !== undefined) this.store.removeGrantByGithubLogin(tenant.githubLogin, tier);
          delete tenant.grants[tier];
          dropped.push(tier);
          continue;
        }
        throw error;
      }
    }
    return null;
  }

  /**
   * Gitee 的一天过期在这里落地：真实租户在访问时懒刷新，演示租户由定时器按同一判定触发。
   * 刷新失败但旧 token 还未过期就继续用；已经过期才摘掉授权并显式回报 reauth。
   */
  async gitee(tenant: Tenant, sessionId: string | null, isDemoTenant: boolean): Promise<GiteeSnapshot | null> {
    if (tenant.gitee === undefined) return null;
    const key = tenant.giteeLogin ?? tenant.login;
    const running = this.giteeInFlight.get(key);
    if (running !== undefined) {
      const snapshot = await running;
      // 等来的结果出自别人那份租户副本：自己这份可能还带着被轮换掉的 token，
      // 或仍以为授权在。重读一次账本，`connected` 与下一次刷新才对得上。
      if (sessionId !== null) {
        const fresh = this.store.find(sessionId);
        if (fresh !== undefined) {
          // Object.assign 不会删掉目标上多出来的键：先清掉旧的 Gitee 授权，
          // 否则上级 401 摘掉的授权又会被这份副本报成「已连接」。
          delete tenant.gitee;
          Object.assign(tenant, fresh);
        }
      }
      return snapshot;
    }
    const run = this.fetchGitee(tenant, sessionId, isDemoTenant).finally(() => {
      this.giteeInFlight.delete(key);
    });
    this.giteeInFlight.set(key, run);
    return await run;
  }

  private async fetchGitee(tenant: Tenant, sessionId: string | null, isDemoTenant: boolean): Promise<GiteeSnapshot | null> {
    const stored = tenant.gitee;
    if (stored === undefined) return null;
    const persist = (next: GiteeCredential): void => {
      if (sessionId !== null) this.store.putGitee(sessionId, next);
      else if (tenant.giteeLogin !== undefined) this.store.putGiteeByGiteeLogin(tenant.giteeLogin, next);
      else throw new Error("Gitee 授权没有归属");
    };
    const remove = (): void => {
      if (sessionId !== null) this.store.removeGitee(sessionId);
      else if (tenant.giteeLogin !== undefined) this.store.removeGiteeByGiteeLogin(tenant.giteeLogin);
      delete tenant.gitee;
    };
    const reauth = (): GiteeSnapshot => {
      remove();
      return { status: "reauth" };
    };

    let current: CredentialRecord = { ...stored };
    const action = decideCredentialAction({
      now: this.now(),
      expiresAt: current.expiresAt,
      lastRefreshAt: current.lastRefreshAt,
      isDemoTenant,
    });
    if (action === "expire-to-reauth") return reauth();

    if (action !== "serve") {
      if (current.refreshToken === null) {
        if (current.expiresAt !== null && this.now() >= current.expiresAt) return reauth();
      } else {
        try {
          const refreshed = await refreshAccessToken(this.config, current.refreshToken, this.now());
          const outcome = rotateCredential(current, refreshed, persist, this.now());
          if (outcome.kind === "committed") {
            current = outcome.record;
          } else {
            current = this.recordAttempt(current, persist);
          }
        } catch {
          current = this.recordAttempt(current, persist);
        }
        const after = decideCredentialAction({
          now: this.now(),
          expiresAt: current.expiresAt,
          lastRefreshAt: current.lastRefreshAt,
          isDemoTenant,
        });
        if (after === "expire-to-reauth") return reauth();
      }
    }

    try {
      const items = await createGiteeProvider().search(
        { assignee: tenant.giteeLogin ?? tenant.login },
        createGiteeHttp(current.accessToken),
      );
      tenant.gitee = current;
      return { status: "ok", items: items.map(giteeMeta) };
    } catch (error) {
      if (error instanceof GiteeUpstreamError && error.status === 401) return reauth();
      return { status: "unavailable", detail: error instanceof Error ? error.message : "Gitee 不可达" };
    }
  }

  /** 记一次失败的刷新尝试；落盘也失败就保留原值，下次访问再试。 */
  private recordAttempt(current: CredentialRecord, persist: (next: CredentialRecord) => void): CredentialRecord {
    const attempted = recordRefreshAttempt(current, this.now());
    try {
      persist(attempted);
    } catch {
      return current;
    }
    return attempted;
  }
}