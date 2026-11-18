import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Tier } from "../src/core/provider";
import { createGithubProvider, GithubUpstreamError } from "../src/providers/github";
import type { ServerConfig } from "./config";
import { authorizeUrl, createGithubHttp, exchangeCode, fetchIdentity, isTier, missingScopes, SCOPES } from "./github-oauth";
import {
  composeReasonWording,
  parseReasonCard,
  ReasonQualityError,
  ReasonTimeoutError,
  ReasonUnavailableError,
} from "./reason";
import type { EncryptedStore } from "./store";

/**
 * OAuth 回调 handler 与 HTTP 细节按 spec 的 Testing Decisions 不写自动化测试
 * （失败是可见的），这里只把三件事钉死：state 单次有效、令牌不出服务端、CORS 只放行面板源。
 * #13 起账本换成加密落盘的 `EncryptedStore`：日志仍只记结果，不记 state / code / 令牌 / 身份。
 */

const STATE_TTL_MS = 10 * 60_000;
const MAX_BODY_CHARS = 16_384;

/** 各档授权「本该」拿到的 scope；和实际授予的一比，就能指出 GitHub 侧被改小（T12）。 */
const EXPECTED_SCOPES: Record<Tier, string[]> = { public: [SCOPES.public], private: [SCOPES.private] };

interface PendingAuth {
  expiresAt: number;
  tier: Tier;
  /** 第二档授权挂在已存在的租户上；首次连接为 null。 */
  sessionId: string | null;
}

export interface HandlerDeps {
  config: ServerConfig;
  store: EncryptedStore;
  now: () => number;
}

export function createHandler({ config, store, now }: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // state → 待完成的授权；走完一次就删，回调地址被重放也换不到第二个 token。
  const pendingStates = new Map<string, PendingAuth>();

  function startAuth(tier: Tier, sessionId: string | null): string {
    purgeExpired(pendingStates, now());
    const state = randomBytes(24).toString("base64url");
    pendingStates.set(state, { expiresAt: now() + STATE_TTL_MS, tier, sessionId });
    return authorizeUrl(config, state, tier);
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
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/auth/github") {
        const tierParam = url.searchParams.get("tier");
        return redirect(res, startAuth(isTier(tierParam) ? tierParam : "public", null));
      }

      if (req.method === "POST" && url.pathname === "/api/auth-url") {
        // 第二档授权从面板发起：会话标识走 Authorization 头，不放 query（ADR-0010 的边界）。
        const id = bearerOf(req);
        if (id === null || store.find(id) === undefined) return json(res, 401, { error: "unauthenticated" });
        const body = await readJsonBody(req);
        const tier = body !== null && typeof body.tier === "string" && isTier(body.tier) ? body.tier : null;
        if (tier === null) return json(res, 400, { error: "bad_tier" });
        return json(res, 200, { url: startAuth(tier, id) });
      }

      if (req.method === "GET" && url.pathname === "/cb/github") {
        return await callback(res, url);
      }

      if (req.method === "GET" && url.pathname === "/api/items") {
        return await items(req, res);
      }

      if (req.method === "POST" && url.pathname === "/api/reason") {
        return await reasonWording(req, res);
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
    if (pending === undefined || pending.expiresAt < now() || code === "") {
      // 留痕只说结果，不带 state / code / 身份：journalctl 是排障入口，不是数据出口。
      console.warn("[cb/github] rejected: state expired, unknown or code missing");
      return text(res, 400, "授权没有走完，回到面板重新连接。");
    }
    const grant = await exchangeCode(config, code);
    const identity = await fetchIdentity(grant.accessToken);
    // 两档 token 必须属于同一个账号：第二档换了账号就拒绝，不把两枚 token 混进一条租户。
    const existing = pending.sessionId === null ? undefined : store.find(pending.sessionId);
    if (existing !== undefined && existing.login !== identity.login) {
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

  async function items(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = bearerOf(req);
    const tenant = id === null ? undefined : store.find(id);
    if (id === null || tenant === undefined) return json(res, 401, { error: "unauthenticated" });

    // 高档 token 是公开档的超集，优先用它；某一档被上游判 401 就只删那一档再试另一档。
    // 被删的档记进 `dropped`：主屏角标要能说出「刚刚丢了哪一档」，而不是静默少几条。
    const order: Tier[] = tenant.grants.private !== undefined ? ["private", "public"] : ["public"];
    const dropped: Tier[] = [];
    for (const tier of order) {
      const grant = tenant.grants[tier];
      if (grant === undefined) continue;
      // 头拿到（哪怕是空的、乃至缺失回调的 null）就覆盖旧值；`scopesObserved` 区分「这轮没回调」。
      let scopesObserved = false;
      let liveScopes: string[] | null = null;
      const http = createGithubHttp(grant.token, fetch, (scopes) => {
        scopesObserved = true;
        liveScopes = scopes;
      });
      try {
        const list = await createGithubProvider().search({ assignee: tenant.login }, http);
        if (scopesObserved) {
          store.setScopes(id, tier, liveScopes);
          grant.scopes = liveScopes;
        }
        res.setHeader("Cache-Control", "no-store");
        return json(res, 200, {
          items: list,
          login: tenant.login,
          auth: { grants: scopesOf(tenant), used: tier, expected: EXPECTED_SCOPES, dropped },
        });
      } catch (error) {
        if (error instanceof GithubUpstreamError && error.status === 401) {
          store.removeGrant(id, tier);
          // 租户是 materialize 出来的副本：不删这一份，响应里还会把它当已授权报回去。
          delete tenant.grants[tier];
          dropped.push(tier);
          continue;
        }
        throw error;
      }
    }

    // 两档都不可用：整条租户删掉，让面板回到「重新连接」而不是留一条死记录。
    if (!store.delete(id)) console.error("[items] delete verification failed");
    return json(res, 401, { error: "reconnect" });
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
