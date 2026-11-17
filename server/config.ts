/**
 * 服务端配置只从环境变量读一次，缺项直接起不来：宁可起不来，也不要带着空凭据
 * 把 401 一路传到浏览器上假装「连过了」。
 */

export interface ServerConfig {
  host: string;
  port: number;
  /** 回调域名，例如 `https://api.example.com`；三家后台登记的地址都以它为基。 */
  appBaseUrl: string;
  /** 面板所在源（Qoder Sites），CORS 只放行它，同时是回调完成后的落地地址。 */
  frontendUrl: string;
  github: { clientId: string; clientSecret: string };
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    // 默认只听回环口：反代终结 TLS，8787 不该出现在公网面上（#39 的 AC#2）。
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 8787),
    appBaseUrl: trimSlash(required(env, "APP_BASE_URL")),
    frontendUrl: trimSlash(required(env, "FRONTEND_URL")),
    github: {
      clientId: required(env, "GITHUB_CLIENT_ID"),
      clientSecret: required(env, "GITHUB_CLIENT_SECRET"),
    },
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
