import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { credentialFromTokens } from "../src/core/credentials";
import type { RawItem, Tier } from "../src/core/provider";
import type { ServerConfig } from "./config";
import type { DemoRefresher } from "./demo";
import { authorizeUrl as giteeAuthorizeUrl, exchangeCode as giteeExchangeCode, fetchIdentity as fetchGiteeIdentity } from "./gitee-oauth";
import { authorizeUrl, exchangeCode, fetchIdentity, isTier, missingScopes, SCOPES } from "./github-oauth";
import {
  authorizeUrl as jiraAuthorizeUrl,
  exchangeCode as jiraExchangeCode,
  fetchAccessibleSite,
  fetchIdentity as fetchJiraIdentity,
} from "./jira-oauth";
import {
  composeReasonWording,
  parseReasonCard,
  ReasonQualityError,
  ReasonTimeoutError,
  ReasonUnavailableError,
} from "./reason";
import {
  composeSummary,
  parseSummaryCard,
  SummaryTimeoutError,
  SummaryUnavailableError,
} from "./summary";
import type { EncryptedStore } from "./store";
import type { GiteeSnapshot, JiraSnapshot, Upstream } from "./upstream";

/**
 * OAuth 回调 handler 与 HTTP 细节按 spec 的 Testing Decisions 不写自动化测试
 * （失败是可见的），这里只把三件事钉死：state 单次有效、令牌不出服务端、CORS 只放行面板源。
 * #13 起账本换成加密落盘的 `EncryptedStore`：日志仍只记结果，不记 state / code / 令牌 / 身份。
 */

const STATE_TTL_MS = 10 * 60_000;
const MAX_BODY_CHARS = 16_384;
/** 上一轮 id 走查询串：只用来向源站确认已关闭的条目，超过这个数就不再补。 */
const MAX_PREVIOUS_IDS = 100;

/** 各档授权「本该」拿到的 scope；和实际授予的一比，就能指出 GitHub 侧被改小（T12）。 */
const EXPECTED_SCOPES: Record<Tier, string[]> = { public: [SCOPES.public], private: [SCOPES.private] };

interface PendingAuth {
  expiresAt: number;
  provider: "github" | "gitee" | "jira";
  /** GitHub 的第二档授权要挂回已有租户；首次连接为 null。 */
  sessionId: string | null;
  tier?: Tier;
}

export interface HandlerDeps {
  config: ServerConfig;
  store: EncryptedStore;
  now: () => number;
  /** 演示快照；未配置 `DEMO_LOGIN` 时为 null，两个 demo 路由都不存在。 */
  demo: DemoRefresher | null;
  /** 与定时刷新共用的一份：同一账号的 Gitee 轮换必须走同一张 in-flight 表。 */
  upstream: Upstream;
}

export function createHandler({ config, store, now, demo, upstream }: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // state → 待完成的授权；走完一次就删，回调地址被重放也换不到第二个 token。
  const pendingStates = new Map<string, PendingAuth>();

  function startAuth(tier: Tier, sessionId: string | null): string {
    purgeExpired(pendingStates, now());
    const state = randomBytes(24).toString("base64url");
    pendingStates.set(state, { expiresAt: now() + STATE_TTL_MS, provider: "github", sessionId, tier });
    return authorizeUrl(config, state, tier);
  }

  function startGiteeAuth(sessionId: string | null): string {
    purgeExpired(pendingStates, now());
    const state = randomBytes(24).toString("base64url");
    pendingStates.set(state, { expiresAt: now() + STATE_TTL_MS, provider: "gitee", sessionId });
    return giteeAuthorizeUrl(config, state);
  }

  /** #19 的内部自证入口：面板不链接它，只用于维护者完成一次真实 3LO 闭环。 */
  function startJiraAuth(sessionId: string | null): string {
    purgeExpired(pendingStates, now());
    const state = randomBytes(24).toString("base64url");
    pendingStates.set(state, { expiresAt: now() + STATE_TTL_MS, provider: "jira", sessionId });
    return jiraAuthorizeUrl(config, state);
  }

  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", config.frontendUrl);
    const url = new URL(req.url ?? "/", config.appBaseUrl);

    try {
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
        return end(res, 204);
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          gitee: config.gitee !== null,
          jira: config.atlassian !== null,
          demo: config.demo !== null,
        });
      }

      if (req.method === "GET" && url.pathname === "/auth/github") {
        const tierParam = url.searchParams.get("tier");
        return redirect(res, startAuth(isTier(tierParam) ? tierParam : "public", null));
      }

      if (req.method === "GET" && url.pathname === "/auth/gitee") {
        if (config.gitee === null) return text(res, 503, "Gitee 未配置：服务端缺少 GITEE_CLIENT_ID / GITEE_CLIENT_SECRET。");
        return redirect(res, startGiteeAuth(null));
      }

      if (req.method === "GET" && url.pathname === "/auth/jira") {
        if (config.atlassian === null) {
          return text(res, 503, "Atlassian 未配置：服务端缺少 ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET。");
        }
        return redirect(res, startJiraAuth(null));
      }

      if (req.method === "POST" && url.pathname === "/api/auth-url") {
        // 第二档授权从面板发起：会话标识走 Authorization 头，不放 query（ADR-0010 的边界）。
        const id = bearerOf(req);
        if (id === null || store.find(id) === undefined) return json(res, 401, { error: "unauthenticated" });
        const body = await readJsonBody(req);
        if (body !== null && body.provider === "jira") {
          if (config.atlassian === null) return json(res, 503, { error: "jira_unconfigured" });
          return json(res, 200, { url: startJiraAuth(id) });
        }
        if (body !== null && body.provider === "gitee") {
          if (config.gitee === null) return json(res, 503, { error: "gitee_unconfigured" });
          return json(res, 200, { url: startGiteeAuth(id) });
        }
        const tier = body !== null && typeof body.tier === "string" && isTier(body.tier) ? body.tier : null;
        if (tier === null) return json(res, 400, { error: "bad_tier" });
        return json(res, 200, { url: startAuth(tier, id) });
      }

      if (req.method === "GET" && url.pathname === "/cb/github") {
        return await callback(res, url);
      }

      if (req.method === "GET" && url.pathname === "/cb/gitee") {
        return await giteeCallback(res, url);
      }

      if (req.method === "GET" && url.pathname === "/cb/jira") {
        return await jiraCallback(res, url);
      }

      if (req.method === "GET" && url.pathname === "/api/items") {
        return await items(req, res);
      }

      // 首次访客不登录也要看得到：演示快照是公开只读的，不含任何访客身份。
      if (req.method === "GET" && url.pathname === "/api/demo/items") {
        if (demo === null) return json(res, 404, { error: "demo_unconfigured" });
        const snapshot = demo.read();
        if (snapshot === null) return json(res, 503, { error: "demo_unavailable" });
        res.setHeader("Cache-Control", "no-store");
        return json(res, 200, snapshot);
      }

      // 维护者重置：立刻重取一次并覆盖快照。没有配 token 就不存在这个入口。
      if (req.method === "POST" && url.pathname === "/api/demo/reset") {
        if (demo === null || config.demo === null || config.demo.resetToken === null) {
          return json(res, 404, { error: "not_found" });
        }
        if (bearerOf(req) !== config.demo.resetToken) return json(res, 401, { error: "unauthorized" });
        const snapshot = await demo.refresh();
        if (snapshot === null) return json(res, 503, { error: "demo_unavailable" });
        return json(res, 200, { ok: true, generatedAt: snapshot.generatedAt });
      }

      if (req.method === "POST" && url.pathname === "/api/reason") {
        return await reasonWording(req, res);
      }

      if (req.method === "POST" && url.pathname === "/api/summary") {
        return await summaryWording(req, res);
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        const id = bearerOf(req);
        if (id !== null) {
          // 撤销 = 物理删除该租户 token 与该租户在服务端的全部数据；验证失败就不回 204。
          if (!store.delete(id)) {
            console.error("[logout] delete verification failed");
            return json(res, 500, { error: "delete_failed" });
          }
          console.log("[logout] tenant deleted");
        }
        return end(res, 204);
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      // 上游故障一律折成 502，响应体不带上游原文：那里可能有令牌之外的东西。
      return json(res, 502, { error: "upstream_unavailable" });
    }
  };

  async function callback(res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (pending === undefined || pending.provider !== "github" || pending.tier === undefined || pending.expiresAt < now() || code === "") {
      // 留痕只说结果，不带 state / code / 身份：journalctl 是排障入口，不是数据出口。
      console.warn("[cb/github] rejected: state expired, unknown or code missing");
      return text(res, 400, "授权没有走完，回到面板重新连接。");
    }
    const grant = await exchangeCode(config, code);
    const identity = await fetchIdentity(grant.accessToken);
    // 两档 token 必须属于同一个账号：第二档换了账号就拒绝，不把两枚 token 混进一条租户。
    const existing = pending.sessionId === null ? undefined : store.find(pending.sessionId);
    // v1 账本没有 githubLogin，那时的 login 就是 GitHub 名；Gitee 先连的账还没绑 GitHub 名，不拦首次绑定。
    const githubBound =
      existing === undefined
        ? undefined
        : existing.githubLogin ?? (existing.giteeLogin === undefined ? existing.login : undefined);
    if (githubBound !== undefined && githubBound !== identity.login) {
      console.warn("[cb/github] rejected: account mismatch");
      return text(res, 400, "这次授权的 GitHub 账号与已连接的账号不同，换回原账号再试。");
    }
    const id = store.attachGrant(
      pending.sessionId,
      pending.tier,
      { token: grant.accessToken, scopes: identity.scopes },
      identity.login,
      now(),
    );
    console.log("[cb/github] session created");
    // 会话标识放进 fragment：它不进 Referer，也不会被服务端日志记到。
    return redirect(res, `${config.frontendUrl}/#session=${encodeURIComponent(id)}`);
  }

  /** Gitee 没有公私档：一次授权一枚 token；回调同样只把会话标识放进 fragment。 */
  async function giteeCallback(res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (pending === undefined || pending.provider !== "gitee" || pending.expiresAt < now() || code === "") {
      console.warn("[cb/gitee] rejected: state expired, unknown or code missing");
      return text(res, 400, "授权没有走完，回到面板重新连接。");
    }
    if (config.gitee === null) return text(res, 503, "Gitee 未配置。");
    try {
      const tokens = await giteeExchangeCode(config, code, now());
      const login = await fetchGiteeIdentity(tokens.accessToken);
      const existing = pending.sessionId === null ? undefined : store.find(pending.sessionId);
      if (existing !== undefined && existing.giteeLogin !== undefined && existing.giteeLogin !== login) {
        console.warn("[cb/gitee] rejected: account mismatch");
        return text(res, 400, "这次授权的 Gitee 账号与已连接的账号不同，换回原账号再试。");
      }
      const id = store.attachGitee(pending.sessionId, credentialFromTokens(tokens, now()), login, now());
      console.log("[cb/gitee] session created");
      return redirect(res, `${config.frontendUrl}/#session=${encodeURIComponent(id)}`);
    } catch (error) {
      // 403 的成因（缺 User-Agent / 凭据不匹配）只在服务端日志里留结果，页面上给可操作的一句。
      console.warn(`[cb/gitee] failed: ${error instanceof Error ? error.message : "unknown"}`);
      return text(res, 400, error instanceof Error ? error.message : "Gitee 授权没有走完。");
    }
  }

  /**
   * Jira 3LO 回调：换 token → 找带 `read:jira-work` 的站点 → 认账号 → 挂到会话。
   * 没有面板入口，这个回调只服务于 #19 的内部自证；日志只记结果，不记 code / token / 身份。
   */
  async function jiraCallback(res: ServerResponse, url: URL): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    if (pending === undefined || pending.provider !== "jira" || pending.expiresAt < now() || code === "") {
      console.warn("[cb/jira] rejected: state expired, unknown or code missing");
      return text(res, 400, "授权没有走完，回到面板重新连接。");
    }
    if (config.atlassian === null) return text(res, 503, "Atlassian 未配置。");
    try {
      const tokens = await jiraExchangeCode(config, code, now());
      const site = await fetchAccessibleSite(tokens.accessToken);
      const identity = await fetchJiraIdentity(tokens.accessToken, site.cloudId);
      const existing = pending.sessionId === null ? undefined : store.find(pending.sessionId);
      if (existing?.jira !== undefined && existing.jira.accountId !== identity.accountId) {
        console.warn("[cb/jira] rejected: account mismatch");
        return text(res, 400, "这次授权的 Atlassian 账号与已连接的账号不同，换回原账号再试。");
      }
      const id = store.attachJira(
        pending.sessionId,
        {
          ...credentialFromTokens(tokens, now()),
          cloudId: site.cloudId,
          siteUrl: site.siteUrl,
          accountId: identity.accountId,
          displayName: identity.displayName,
        },
        identity.displayName,
        now(),
      );
      console.log("[cb/jira] session created");
      return redirect(res, `${config.frontendUrl}/#session=${encodeURIComponent(id)}`);
    } catch (error) {
      console.warn(`[cb/jira] failed: ${error instanceof Error ? error.message : "unknown"}`);
      return text(res, 400, error instanceof Error ? error.message : "Jira 授权没有走完。");
    }
  }

  async function items(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = bearerOf(req);
    const tenant = id === null ? undefined : store.find(id);
    if (id === null || tenant === undefined) return json(res, 401, { error: "unauthenticated" });

    // 上一轮见过、这一轮活跃视图没返回的 id：只补这些，确认到已关闭的才让卡片消失。
    const previous = new URL(req.url ?? "/", config.appBaseUrl).searchParams
      .getAll("previous")
      .slice(0, MAX_PREVIOUS_IDS);

    // 两家各取各的：GitHub 的两档回退与 Gitee 的懒刷新都在 Upstream 里，一家的 401 / 刷新失败
    // 只摘这一家，另一家的条目照常返回；两家的 raw 形状不同，归一留给浏览器那侧的 provider。
    const github = await upstream.github(tenant, id, previous);
    // 演示账号即使被维护者用会话打开，刷新也归定时器管：请求路径不续期。
    const gitee = await upstream.gitee(tenant, id, previous);
    // Jira 只用于内部自证，原始条目随响应返回给会话本人，面板不构建它。
    const jira = await upstream.jira(tenant, id, previous);

    // 租户是 materialize 出来的副本：被摘掉的授权要在副本上同步删掉，否则响应还会报「已连接」。
    const githubConnected = tenant.grants.public !== undefined || tenant.grants.private !== undefined;
    const giteeConnected = tenant.gitee !== undefined;
    const jiraConnected = tenant.jira !== undefined;
    if (!githubConnected && !giteeConnected && !jiraConnected) {
      // 三家都不可用：整条租户删掉，让面板回到「重新连接」而不是留一条死记录。
      if (!store.delete(id)) console.error("[items] delete verification failed");
      return json(res, 401, { error: "reconnect" });
    }

    res.setHeader("Cache-Control", "no-store");
    return json(res, 200, {
      items: github.items,
      login: tenant.login,
      // 逐家状态：面板要区分「没连过 / 授权过期 / 上游故障」，不能只看条目是否为空。
      github: {
        status: github.status,
        ...(github.detail === undefined ? {} : { detail: github.detail }),
        ...(github.forbidden === true ? { forbidden: true } : {}),
        previous: github.previous,
      },
      auth: {
        grants: scopesOf(tenant),
        used: github.used,
        expected: EXPECTED_SCOPES,
        dropped: github.dropped,
      },
      gitee: providerSnapshot(gitee),
      jira: providerSnapshot(jira),
      connected: { github: githubConnected, gitee: giteeConnected, jira: jiraConnected },
    });
  }

  /**
   * 「AI 提炼」（#20）：一次一条，面板并发调用。鉴权与错误映射跟单卡理由同形，
   * 只是超时放宽到 6 秒（批量摘要不在 2 秒交互承诺里），摘要质量走人工判断。
   */
  async function summaryWording(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = bearerOf(req);
    if (id === null || store.find(id) === undefined) return json(res, 401, { error: "unauthenticated" });
    const body = await readJsonBody(req);
    const card = body === null ? null : parseSummaryCard(body.card);
    if (card === null) return json(res, 400, { error: "bad_card" });
    try {
      const result = await composeSummary(config.deepseek, card);
      console.log(`[summary] ok in ${result.elapsedMs}ms`);
      return json(res, 200, result);
    } catch (error) {
      if (error instanceof SummaryUnavailableError) {
        console.warn("[summary] unavailable: no api key");
        return json(res, 503, { error: "unavailable" });
      }
      if (error instanceof SummaryTimeoutError) {
        console.warn("[summary] timeout");
        return json(res, 504, { error: "timeout" });
      }
      // 失败只记结果类型，不记标题或上游原文。
      console.error(`[summary] upstream failed: ${error instanceof Error ? error.message : "unknown"}`);
      throw error;
    }
  }

  /**
   * 单张卡的理由（#8）：同步等一句措辞，规则理由在浏览器那侧已经先渲染好，这里失败也不留空白。
   * 只收元数据（`parseReasonCard` 逐字段白名单），日志只记结果、耗时与失败类型。
   */
  async function reasonWording(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = bearerOf(req);
    if (id === null || store.find(id) === undefined) return json(res, 401, { error: "unauthenticated" });
    const body = await readJsonBody(req);
    const card = body === null ? null : parseReasonCard(body.card);
    if (card === null) return json(res, 400, { error: "bad_card" });
    try {
      const result = await composeReasonWording(config.deepseek, card);
      console.log(`[reason] ok in ${result.elapsedMs}ms`);
      return json(res, 200, result);
    } catch (error) {
      if (error instanceof ReasonUnavailableError) {
        console.warn("[reason] unavailable: no api key");
        return json(res, 503, { error: "unavailable" });
      }
      if (error instanceof ReasonTimeoutError) {
        console.warn("[reason] timeout");
        return json(res, 504, { error: "timeout" });
      }
      if (error instanceof ReasonQualityError) {
        console.warn(`[reason] rejected: ${error.message}`);
        return json(res, 422, { error: "wording_rejected" });
      }
      // 失败也只记结果类型：上游原文可能带别的东西，不进 journalctl。
      console.error(`[reason] upstream failed: ${error instanceof Error ? error.message : "unknown"}`);
      throw error;
    }
  }
}

/** Gitee / Jira 的取数结果换算成面板可读的一段；`none` 与 `reauth` 分开：没连过和刚被摘掉不是一件事。 */
function providerSnapshot(snapshot: GiteeSnapshot | JiraSnapshot | null): {
  status: "ok" | "reauth" | "unavailable" | "none";
  items: RawItem[];
  previous: RawItem[];
  detail?: string;
} {
  if (snapshot === null) return { status: "none", items: [], previous: [] };
  if (snapshot.status === "ok") return { status: "ok", items: snapshot.items, previous: snapshot.previous };
  if (snapshot.status === "reauth") return { status: "reauth", items: [], previous: [] };
  return { status: "unavailable", items: [], previous: [], detail: snapshot.detail };
}

function scopesOf(tenant: { grants: Partial<Record<Tier, { scopes: string[] | null }>> }): Partial<
  Record<Tier, { scopes: string[] | null; missing: string[] }>
> {
  const out: Partial<Record<Tier, { scopes: string[] | null; missing: string[] }>> = {};
  for (const tier of ["public", "private"] as const) {
    const grant = tenant.grants[tier];
    if (grant === undefined) continue;
    const scopes = grant.scopes === null ? null : [...grant.scopes];
    out[tier] = {
      scopes,
      // 响应头缺失时不知道实际授予了什么，就不报差异：宁可不猜，也不把「不知道」说成「少了」。
      missing: scopes === null ? [] : missingScopes(EXPECTED_SCOPES[tier], scopes),
    };
  }
  return out;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY_CHARS) throw new Error("请求体过大");
  }
  if (text === "") return null;
  const parsed: unknown = JSON.parse(text);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  const match = header === undefined ? null : /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.writeHead(status);
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location });
  res.end();
}

function end(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}

function purgeExpired(pendingStates: Map<string, PendingAuth>, at: number): void {
  for (const [state, pending] of pendingStates) {
    if (pending.expiresAt < at) pendingStates.delete(state);
  }
}
