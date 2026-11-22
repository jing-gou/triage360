import { decideCredentialAction, recordRefreshAttempt, rotateCredential, type CredentialRecord } from "../src/core/credentials";
import { providerIdOf, type Http, type Provider, type RawItem, type Tier } from "../src/core/provider";
import { createGiteeProvider, GiteeUpstreamError } from "../src/providers/gitee";
import { createGithubProvider, GithubUpstreamError } from "../src/providers/github";
import { createJiraProvider, JiraUpstreamError } from "../src/providers/jira";
import type { ServerConfig } from "./config";
import { createGiteeHttp, refreshAccessToken } from "./gitee-oauth";
import { createGithubHttp } from "./github-oauth";
import { createJiraHttp, refreshAccessToken as refreshJiraAccessToken } from "./jira-oauth";
import type { EncryptedStore, GiteeCredential, JiraCredential, Tenant } from "./store";

/**
 * 上游取数的共用路径：浏览器会话与演示租户的定时刷新都走这里。
 * 两家的失败互不遮掩——一家 401 只摘这一家的授权，另一家的条目照常返回（ADR-0003）。
 */

/**
 * GitHub 的一次取数结果。`none` 是没连过，`reauth` 是所有档都被 401 摘掉，
 * `unavailable` 是上游故障但仍保留授权（下一轮还能再试）。三者对访客的意思不同。
 */
export interface GithubSnapshot {
  status: "ok" | "reauth" | "unavailable" | "none";
  items: RawItem[];
  /**
   * 上一轮有、这一轮的活跃视图没返回的条目，按 id 向源站确认后的原始记录。
   * 面板据此走 `deletedStates`：确认到已关闭才让卡片消失，404 仍按 ADR-0003 保留。
   */
  previous: RawItem[];
  used: Tier | null;
  dropped: Tier[];
  detail?: string;
  /** 403 且不是限流：权限不足的强信号，面板据此把故障说成「权限未授予」。 */
  forbidden?: true;
}

export type GiteeSnapshot =
  | { status: "ok"; items: RawItem[]; previous: RawItem[] }
  | { status: "reauth"; previous: RawItem[] }
  | { status: "unavailable"; detail: string; previous: RawItem[] };

/** Jira 没有访客入口，也不进演示快照；`null` 表示这个租户没连过。 */
export type JiraSnapshot =
  | { status: "ok"; items: RawItem[]; previous: RawItem[] }
  | { status: "reauth"; previous: RawItem[] }
  | { status: "unavailable"; detail: string; previous: RawItem[] };

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

function jiraMeta(item: RawItem): RawItem {
  const fields = item.fields as {
    summary?: unknown;
    status?: { statusCategory?: { key?: unknown } } | null;
    updated?: unknown;
    duedate?: unknown;
  };
  return {
    id: item.id,
    key: item.key,
    fields: {
      summary: fields.summary,
      status: fields.status == null ? null : { statusCategory: { key: fields.status.statusCategory?.key } },
      updated: fields.updated,
      duedate: fields.duedate ?? null,
    },
  };
}

/**
 * 只补「上一轮见过、本轮活跃视图没有」的 id：确认到已关闭的记录能收敛掉，
 * 404 或确认请求失败都从返回数组里省略，交给 ADR-0003 的「未返回视为跳过」保留原卡。
 * 确认失败不能把整家翻成 unavailable——活跃视图已经取到了，旧卡只是这一轮没被确认。
 */
async function confirmPrevious(
  provider: Provider,
  active: readonly RawItem[],
  ids: readonly string[],
  http: Http,
  meta: (item: RawItem) => RawItem,
): Promise<RawItem[]> {
  const have = new Set(active.map((item) => provider.normalize(item).id));
  const missing = ids.filter((id) => providerIdOf(id) === provider.id && !have.has(id));
  if (missing.length === 0) return [];
  try {
    return (await provider.getByIds(missing, http)).map(meta);
  } catch {
    return [];
  }
}

export class Upstream {
  /**
   * 同一份 Gitee 授权只跑一次刷新：两个请求同时看见过期就会各换一次，后失败的那个
   * 会把刚轮换好的 token 写回旧的。键用 Gitee 登录名而不是会话——演示租户的定时器
   * 与维护者自己的会话可能是同一份授权，只按会话锁不住这条竞态。
   */
  private readonly giteeInFlight = new Map<string, Promise<GiteeSnapshot | null>>();

  /**
   * Atlassian 的 refresh token 一换就作废旧的：同一份授权若被两个请求同时看见过期，
   * 后一次会拿已退役的 refresh token 去换，并可能把新 token 覆盖回旧值。
   * 键用 cloudId + accountId，与浏览器会话解耦。
   */
  private readonly jiraInFlight = new Map<string, Promise<JiraSnapshot | null>>();

  constructor(
    private readonly config: ServerConfig,
    private readonly store: EncryptedStore,
    private readonly now: () => number,
  ) {}

  /** 演示租户的判定只留这一处：入口无论是定时器还是会话，取数口径都必须相同。 */
  private isDemoTenant(tenant: Tenant): boolean {
    return this.config.demo !== null && tenant.githubLogin === this.config.demo.login;
  }

  async github(tenant: Tenant, sessionId: string | null, previousIds: readonly string[] = []): Promise<GithubSnapshot> {
    const order: Tier[] = tenant.grants.private !== undefined ? ["private", "public"] : ["public"];
    // 演示快照要核对 12 条精选（含 2 条已完成），所以演示账号连 closed 一起取；
    // 访客自己的账号仍只取活跃视图，不把历史指派拉回来。
    const includeDone = this.isDemoTenant(tenant);
    const dropped: Tier[] = [];
    let attempted = false;
    for (const tier of order) {
      const grant = tenant.grants[tier];
      if (grant === undefined) continue;
      attempted = true;
      let scopesObserved = false;
      let liveScopes: string[] | null = null;
      const http = createGithubHttp(grant.token, fetch, (scopes) => {
        scopesObserved = true;
        liveScopes = scopes;
      });
      const provider = createGithubProvider();
      try {
        const items = await provider.search({ assignee: tenant.githubLogin ?? tenant.login, includeDone }, http);
        if (scopesObserved && sessionId !== null) {
          this.store.setScopes(sessionId, tier, liveScopes);
          grant.scopes = liveScopes;
        }
        return {
          status: "ok",
          items: items.map(githubMeta),
          previous: await confirmPrevious(provider, items, previousIds, http, githubMeta),
          used: tier,
          dropped,
        };
      } catch (error) {
        if (error instanceof GithubUpstreamError && error.status === 401) {
          if (sessionId !== null) this.store.removeGrant(sessionId, tier);
          else if (tenant.githubLogin !== undefined) this.store.removeGrantByGithubLogin(tenant.githubLogin, tier);
          delete tenant.grants[tier];
          dropped.push(tier);
          continue;
        }
        // 非 401 是这一轮的上游故障，别把它折成「没连过」；授权还在，下一轮可以再试。
        return {
          status: "unavailable",
          items: [],
          previous: [],
          used: null,
          dropped,
          detail: error instanceof Error ? error.message : "GitHub 不可达",
          ...(error instanceof GithubUpstreamError && error.status === 403 && !error.rateLimited
            ? { forbidden: true as const }
            : {}),
        };
      }
    }
    return { status: attempted ? "reauth" : "none", items: [], previous: [], used: null, dropped };
  }

  /**
   * Gitee 的一天过期在这里落地：真实租户在访问时懒刷新，演示租户由定时器按同一判定触发。
   * 刷新失败但旧 token 还未过期就继续用；已经过期才摘掉授权并显式回报 reauth。
   */
  async gitee(tenant: Tenant, sessionId: string | null, previousIds: readonly string[] = []): Promise<GiteeSnapshot | null> {
    if (tenant.gitee === undefined) return null;
    const isDemoTenant = this.isDemoTenant(tenant);
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
    const run = this.fetchGitee(tenant, sessionId, isDemoTenant, previousIds).finally(() => {
      this.giteeInFlight.delete(key);
    });
    this.giteeInFlight.set(key, run);
    return await run;
  }

  private async fetchGitee(
    tenant: Tenant,
    sessionId: string | null,
    isDemoTenant: boolean,
    previousIds: readonly string[],
  ): Promise<GiteeSnapshot | null> {
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
      return { status: "reauth", previous: [] };
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
      const provider = createGiteeProvider();
      const http = createGiteeHttp(current.accessToken);
      const items = await provider.search(
        { assignee: tenant.giteeLogin ?? tenant.login, includeDone: isDemoTenant },
        http,
      );
      tenant.gitee = current;
      return {
        status: "ok",
        items: items.map(giteeMeta),
        previous: await confirmPrevious(provider, items, previousIds, http, giteeMeta),
      };
    } catch (error) {
      if (error instanceof GiteeUpstreamError && error.status === 401) return reauth();
      return {
        status: "unavailable",
        previous: [],
        detail: error instanceof Error ? error.message : "Gitee 不可达",
      };
    }
  }

  /**
   * Jira 只在内部自证路径上取数：入口永远是某个浏览器会话，没有演示租户的定时刷新，
   * 因此轮换后的凭据必须按会话写回。刷新失败但 access token 未过期时继续用旧的；
   * 已经过期才摘掉这一家并显式回报 reauth。
   */
  async jira(tenant: Tenant, sessionId: string, previousIds: readonly string[] = []): Promise<JiraSnapshot | null> {
    const stored = tenant.jira;
    if (stored === undefined) return null;
    const key = `${stored.cloudId}:${stored.accountId}`;
    const running = this.jiraInFlight.get(key);
    if (running !== undefined) {
      const snapshot = await running;
      // 等来的结果出自别人那份租户副本：先清掉旧的 Jira 授权，再重读账本。
      // 首请求若因 401 把整条租户删了，这里 `find` 会返回 undefined，清理不能只放在分支里。
      delete tenant.jira;
      const fresh = this.store.find(sessionId);
      if (fresh !== undefined) Object.assign(tenant, fresh);
      return snapshot;
    }
    const run = this.fetchJira(tenant, sessionId, previousIds).finally(() => {
      this.jiraInFlight.delete(key);
    });
    this.jiraInFlight.set(key, run);
    return await run;
  }

  private async fetchJira(
    tenant: Tenant,
    sessionId: string,
    previousIds: readonly string[],
  ): Promise<JiraSnapshot | null> {
    const stored = tenant.jira;
    if (stored === undefined) return null;
    const persist = (next: CredentialRecord): void => {
      const credential: JiraCredential = { ...stored, ...next };
      this.store.putJira(sessionId, credential);
    };
    const remove = (): void => {
      this.store.removeJira(sessionId);
      delete tenant.jira;
    };
    const reauth = (): JiraSnapshot => {
      remove();
      return { status: "reauth", previous: [] };
    };

    let current: CredentialRecord = { ...stored };
    const action = decideCredentialAction({
      now: this.now(),
      expiresAt: current.expiresAt,
      lastRefreshAt: current.lastRefreshAt,
      isDemoTenant: false,
    });
    if (action === "expire-to-reauth") return reauth();

    if (action !== "serve") {
      if (current.refreshToken === null) {
        if (current.expiresAt !== null && this.now() >= current.expiresAt) return reauth();
      } else {
        try {
          const refreshed = await refreshJiraAccessToken(this.config, current.refreshToken, this.now());
          const outcome = rotateCredential(current, refreshed, persist, this.now());
          if (outcome.kind === "committed") {
            current = outcome.record;
            // 只记事件与是否真的拿到新的一对，不记 token 本身；#19 的轮换自证读这一行。
            console.log(`[jira] refresh committed (rotated=${refreshed.refreshToken !== null})`);
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
          isDemoTenant: false,
        });
        if (after === "expire-to-reauth") return reauth();
      }
    }

    try {
      const provider = createJiraProvider({ cloudId: stored.cloudId, siteUrl: stored.siteUrl });
      const http = createJiraHttp(current.accessToken);
      const items = await provider.search({ assignee: stored.displayName, includeDone: false }, http);
      tenant.jira = { ...stored, ...current };
      console.log(`[jira] fetched ${items.length} items`);
      return {
        status: "ok",
        items: items.map(jiraMeta),
        previous: await confirmPrevious(provider, items, previousIds, http, jiraMeta),
      };
    } catch (error) {
      if (error instanceof JiraUpstreamError && error.status === 401) return reauth();
      return {
        status: "unavailable",
        previous: [],
        detail: error instanceof Error ? error.message : "Jira 不可达",
      };
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