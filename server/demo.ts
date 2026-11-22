import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawItem } from "../src/core/provider";
import type { DemoConfig, ServerConfig } from "./config";
import type { EncryptedStore } from "./store";
import { Upstream } from "./upstream";

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
}

export class DemoRefresher {
  private readonly file: string;
  private current: DemoSnapshot | null;
  private inFlight: Promise<DemoSnapshot | null> | null = null;

  constructor(
    config: ServerConfig,
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
    const gitee = await this.upstream.gitee(tenant, null, true);
    if (gitee !== null && gitee.status === "unavailable") {
      console.warn("[demo] gitee refresh failed; keeping last snapshot");
      return null;
    }
    if (github === null && gitee === null) {
      console.warn("[demo] demo tenant has no credentials; skipping refresh");
      return null;
    }
    const snapshot: DemoSnapshot = {
      generatedAt: new Date(this.now()).toISOString(),
      items: github?.items ?? [],
      gitee: gitee?.status === "ok" ? gitee.items : [],
      connected: { github: github !== null, gitee: gitee?.status === "ok" },
    };
    this.persist(snapshot);
    this.current = snapshot;
    console.log(
      `[demo] refreshed in ${this.now() - started}ms: github ${snapshot.items.length}, gitee ${snapshot.gitee.length}`,
    );
    return snapshot;
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
      return parsed as DemoSnapshot;
    } catch {
      return null;
    }
  }
}