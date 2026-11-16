/**
 * provider 契约：每个平台实现同一套七个方法，构建器只认这个接口。
 * 传输层（Http）由调用方注入，provider 不自己发起连接。
 */

export interface HttpRequestInit {
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** 注入的取数通道：真实实现是 fetch，测试与假 provider 用替身。 */
export type Http = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** 平台原始条目：形状由各 provider 自己解释，核心层不认识它。 */
export type RawItem = Record<string, unknown>;

/** 归一化后的任务：跨平台共用的最小形状。normalize 的定稿在 T03。 */
export interface Task {
  /** `${providerId}:${remoteId}`，跨轮次稳定。 */
  id: string;
  providerId: string;
  title: string;
  url: string;
  /** 平台原始状态字面量，由 doneStates / deletedStates 解释。 */
  state: string;
  /** ISO 8601，平台侧最后更新时间。 */
  updatedAt: string;
}

/** 清单范围：v1 只有「派给我的」。 */
export interface Scope {
  assignee: string;
}

export interface Provider {
  readonly id: string;
  /** 全量当前视图：一次查询返回「此刻范围内有哪些任务」。 */
  search(scope: Scope, http: Http): Promise<RawItem[]>;
  /** 增量补齐：按 id 取回单条。 */
  getByIds(ids: string[], http: Http): Promise<RawItem[]>;
  /** 平台原始条目 → 任务。 */
  normalize(raw: RawItem): Task;
  /** 哪些状态字面量算「已完成」。 */
  doneStates(): string[];
  /** 哪些状态字面量算「已删除」。 */
  deletedStates(): string[];
  /** 该平台的轮询间隔。 */
  pollIntervalMs(): number;
  /** 人可读的范围说明，用于界面上的角标与范围显示。 */
  scopeDescriptor(scope: Scope): string;
}

/** 任务 id 的编码只在这两个函数里出现，其余地方不解析它。 */
export function makeTaskId(providerId: string, remoteId: string | number): string {
  return `${providerId}:${remoteId}`;
}

export function remoteIdOf(taskId: string): string {
  return taskId.slice(taskId.indexOf(":") + 1);
}
