import { decideCredentialAction, recordRefreshAttempt, rotateCredential, type CredentialRecord } from "../src/core/credentials";
import type { RawItem, Tier } from "../src/core/provider";
import { createGiteeProvider, GiteeUpstreamError } from "../src/providers/gitee";
import { createGithubProvider, GithubUpstreamError } from "../src/providers/github";
import type { ServerConfig } from "./config";
import { createGiteeHttp, refreshAccessToken } from "./gitee-oauth";
import { createGithubHttp } from "./github-oauth";
import type { EncryptedStore, Tenant } from "./store";

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

export class Upstream {
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
        return { items, used: tier, dropped };
      } catch (error) {
        if (error instanceof GithubUpstreamError && error.status === 401) {
          if (sessionId !== null) this.store.removeGrant(sessionId, tier);
          else if (tenant.githubLogin !== undefined) this.store.removeGrantByLogin(tenant.githubLogin, tier);
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
    const stored = tenant.gitee;
    if (stored === undefined) return null;
    const persist = (next: CredentialRecord): void => {
      if (sessionId !== null) this.store.putGitee(sessionId, next);
      else if (tenant.giteeLogin !== undefined) this.store.putGiteeByLogin(tenant.giteeLogin, next);
      else throw new Error("Gitee 授权没有归属");
    };
    const remove = (): void => {
      if (sessionId !== null) this.store.removeGitee(sessionId);
      else if (tenant.giteeLogin !== undefined) this.store.removeGiteeByLogin(tenant.giteeLogin);
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
      return { status: "ok", items };
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