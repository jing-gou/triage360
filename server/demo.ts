import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { labelNames, type RawItem } from "../src/core/provider";
import { createGiteeProvider } from "../src/providers/gitee";
import { createGithubProvider } from "../src/providers/github";
import type { DemoConfig, ServerConfig } from "./config";
import type { EncryptedStore } from "./store";
import { Upstream } from "./upstream";
import { composeSummary } from "./summary";

/**
 * 演示租户的快照（#15）：服务端按 `DEMO_LOGIN` 找回那本账，定时取数并落盘。
 * 「24 小时无人访问也不会变空」靠的是进程内定时器，不靠有人打开面板；单实例部署下
 * 一次刷新的合并（in-flight 复用）就是那把锁，同时在跑的刷新不会叠加。
 * 失败保留上一份好快照：宁可旧一分钟，也不让首次访客看到空清单。
 */

export interface DemoSnapshot {
  generatedAt: string;
  items: RawItem[];
  gitee: RawItem[];
  connected: { github: boolean; gitee: boolean };
  /**
   * 「AI 提炼」的演示摘要（#20）：键是 `<html_url>@<updatedAt ISO>`，与面板的缓存键同源。
   * 演示屏没有会话、不能自己调模型，所以由刷新这侧预生成；键不变就不重算。
   */
  summaries: Record<string, string>;
}

/** 一次预生成的上限与并发：与「AI 提炼」按钮的 ≤20 条对齐，别让定时器一次打爆模型配额。 */
const SUMMARY_LIMIT = 20;
const SUMMARY_CONCURRENCY = 3;


export class DemoRefresher {
  private readonly file: string;
  private current: DemoSnapshot | null;
  private inFlight: Promise<DemoSnapshot | null> | null = null;

  constructor(
    private readonly config: ServerConfig,
    private readonly demo: DemoConfig,
    private readonly store: EncryptedStore,
    private readonly now: () => number,
    private readonly upstream: Upstream,
  ) {
    this.file = join(config.dataDir, "demo.json");
    this.current = this.readFile();
  }

  /** 公开给 `GET /api/demo/items`：只读内存里的这一份，不触发刷新。 */
  read(): DemoSnapshot | null {
    return this.current;
  }

  start(): void {
    const catchUp = (error: unknown): void => {
      // 定时器上没人接的 rejection 在 Node 里会结束进程；失败只留一句结果，下一轮照常再试。
      console.warn(`[demo] refresh failed: ${error instanceof Error ? error.message : "unknown"}`);
    };
    void this.refresh().catch(catchUp);
    setInterval(() => void this.refresh().catch(catchUp), this.demo.refreshMs).unref();
  }

  /** 定时器与维护者重置共用这一条路径；已经在跑就复用同一个 Promise。 */
  refresh(): Promise<DemoSnapshot | null> {
    if (this.inFlight !== null) return this.inFlight;
    const run = this.run().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async run(): Promise<DemoSnapshot | null> {
    const tenant = this.store.findByGithubLogin(this.demo.login);
    if (tenant === undefined) {
      // 演示账号还没走过一次授权：服务端照常起，等那条账出现之后下一轮自动接上。
      console.warn("[demo] no tenant for DEMO_LOGIN yet; skipping refresh");
      return null;
    }
    const started = this.now();
    let github;
    try {
      github = await this.upstream.github(tenant, null);
    } catch {
      // 上游故障不覆盖上一份快照；日志只说结果。
      console.warn("[demo] github refresh failed; keeping last snapshot");
      return null;
    }
    const gitee = await this.upstream.gitee(tenant, null);
    if (github.status === "unavailable") {
      console.warn("[demo] github refresh failed; keeping last snapshot");
      return null;
    }
    if (github.status === "reauth") {
      console.warn("[demo] github authorization expired; keeping last snapshot");
      return null;
    }
    if (gitee !== null && (gitee.status === "unavailable" || gitee.status === "reauth")) {
      console.warn("[demo] gitee refresh failed; keeping last snapshot");
      return null;
    }
    if (github.status === "none" && gitee === null) {
      console.warn("[demo] demo tenant has no credentials; skipping refresh");
      return null;
    }
    const snapshot: DemoSnapshot = {
      generatedAt: new Date(this.now()).toISOString(),
      items: github.items,
      gitee: gitee?.status === "ok" ? gitee.items : [],
      connected: { github: github.status === "ok", gitee: gitee?.status === "ok" },
      summaries: { ...(this.current?.summaries ?? {}) },
    };
    await this.fillSummaries(snapshot);
    this.persist(snapshot);
    this.current = snapshot;
    console.log(
      `[demo] refreshed in ${this.now() - started}ms: github ${snapshot.items.length}, gitee ${snapshot.gitee.length}`,
    );
    return snapshot;
  }

  /**
   * 演示摘要：只补缺失的键，失败的留空等下一轮；其余摘要原样保留。
   * 模型钥匙没配就直接跳过——演示屏退化成「没有提炼按钮」，不是报错。
   */
  private async fillSummaries(snapshot: DemoSnapshot): Promise<void> {
    if (this.config.deepseek.apiKey === "") return;
    const all = [...snapshot.items, ...snapshot.gitee];
    const keep = new Set(all.map(summaryKeyOf).filter((key): key is string => key !== null));
    snapshot.summaries = Object.fromEntries(
      Object.entries(snapshot.summaries).filter(([key]) => keep.has(key)),
    );

    // 完成态的判定跟构建器同一处来：provider 的 doneStates，不在这里再抄一份平台字面量。
    const githubDone = new Set(createGithubProvider().doneStates());
    const giteeDone = new Set(createGiteeProvider().doneStates());
    const todo = [
      ...snapshot.items.filter((raw) => !githubDone.has(String(raw.state ?? ""))),
      ...snapshot.gitee.filter((raw) => !giteeDone.has(String(raw.state ?? ""))),
    ]
      .map((raw) => ({ raw, key: summaryKeyOf(raw) }))
      .filter((one): one is { raw: RawItem; key: string } => one.key !== null && snapshot.summaries[one.key] === undefined)
      .sort((a, b) => String(b.raw.updated_at ?? "").localeCompare(String(a.raw.updated_at ?? "")))
      .slice(0, SUMMARY_LIMIT);
    if (todo.length === 0) return;

    const started = this.now();
    let cursor = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const at = cursor++;
        const item = todo[at];
        if (item === undefined) return;
        try {
          const { text } = await composeSummary(this.config.deepseek, {
            title: typeof item.raw.title === "string" ? item.raw.title : "",
            labels: labelNames(item.raw.labels),
            updatedAt: typeof item.raw.updated_at === "string" ? item.raw.updated_at : "",
          });
          snapshot.summaries[item.key] = text;
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SUMMARY_CONCURRENCY, todo.length) }, worker));
    console.log(
      `[demo] summaries ${todo.length - failed}/${todo.length} ready in ${this.now() - started}ms`,
    );
  }

  private persist(snapshot: DemoSnapshot): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  private readFile(): DemoSnapshot | null {
    if (!existsSync(this.file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DemoSnapshot>;
      if (
        typeof parsed.generatedAt !== "string" ||
        !Array.isArray(parsed.items) ||
        !Array.isArray(parsed.gitee) ||
        parsed.connected === undefined
      ) {
        return null;
      }
      return { ...(parsed as DemoSnapshot), summaries: parsed.summaries ?? {} };
    } catch {
      return null;
    }
  }
}

/** 演示摘要的键：URL 加归一化后的更新时间，与面板按任务（url + updatedAt）查表的口径一致。 */
function summaryKeyOf(raw: RawItem): string | null {
  const url = raw.html_url;
  const updated = raw.updated_at;
  if (typeof url !== "string" || typeof updated !== "string") return null;
  const at = new Date(updated);
  return Number.isNaN(at.getTime()) ? null : `${url}@${at.toISOString()}`;
}
