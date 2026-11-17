import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createGithubProvider, GithubUpstreamError } from "../src/providers/github";
import type { ServerConfig } from "./config";
import { authorizeUrl, createGithubHttp, exchangeCode, fetchLogin } from "./github-oauth";
import type { SessionStore } from "./sessions";

/**
 * OAuth 回调 handler 与 HTTP 细节按 spec 的 Testing Decisions 不写自动化测试
 * （失败是可见的），这里只把三件事钉死：state 单次有效、令牌不出服务端、CORS 只放行面板源。
 */

const STATE_TTL_MS = 10 * 60_000;

export interface HandlerDeps {
  config: ServerConfig;
  sessions: SessionStore;
  now: () => number;
}

export function createHandler({ config, sessions, now }: HandlerDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  // state → 过期时刻；走完一次就删，回调地址被重放也换不到第二个 token。
  const pendingStates = new Map<string, number>();

  return async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", config.frontendUrl);
    res.setHeader("Vary", "Origin");
    const url = new URL(req.url ?? "/", config.appBaseUrl);

    try {
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Authorization");
        res.setHeader("Access-Control-Max-Age", "600");
        return end(res, 204);
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/auth/github") {
        purgeExpired(pendingStates, now());
        const state = randomBytes(24).toString("base64url");
        pendingStates.set(state, now() + STATE_TTL_MS);
        return redirect(res, authorizeUrl(config, state));
      }

      if (req.method === "GET" && url.pathname === "/cb/github") {
        return await callback(res, url);
      }

      if (req.method === "GET" && url.pathname === "/api/items") {
        return await items(req, res);
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        const id = bearerOf(req);
        if (id !== null) sessions.delete(id);
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
    const expiresAt = pendingStates.get(state);
    pendingStates.delete(state);
    if (expiresAt === undefined || expiresAt < now() || code === "") {
      return text(res, 400, "授权没有走完，回到面板重新连接。");
    }
    const grant = await exchangeCode(config, code);
    const login = await fetchLogin(grant.accessToken);
    const id = sessions.create({ token: grant.accessToken, login, createdAt: now() });
    // 会话标识放进 fragment：它不进 Referer，也不会被服务端日志记到。
    return redirect(res, `${config.frontendUrl}/#session=${encodeURIComponent(id)}`);
  }

  async function items(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = bearerOf(req);
    const session = id === null ? undefined : sessions.get(id);
    if (session === undefined) return json(res, 401, { error: "unauthenticated" });
    try {
      const list = await createGithubProvider().search(
        { assignee: session.login },
        createGithubHttp(session.token),
      );
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, { items: list, login: session.login });
    } catch (error) {
      if (error instanceof GithubUpstreamError && error.status === 401) {
        if (id !== null) sessions.delete(id);
        return json(res, 401, { error: "reconnect" });
      }
      throw error;
    }
  }
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

function purgeExpired(pendingStates: Map<string, number>, at: number): void {
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt < at) pendingStates.delete(state);
  }
}
