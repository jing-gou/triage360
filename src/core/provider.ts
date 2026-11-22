/**
 * provider 契约：每个平台实现同一套七个方法，构建器只认这个接口。
 * 传输层（Http）由调用方注入，provider 不自己发起连接。
 */

export interface HttpRequestInit {
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  /** 真实 fetch 的响应头。GitHub 用 `X-OAuth-Scopes` 做 scope 真值检测，缺了它 T09 只能改契约。 */
  headers: Record<string, string>;
  body: unknown;
}

/** 注入的取数通道：真实实现是 fetch，测试与假 provider 用替身。 */
export type Http = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

/** 平台原始条目：形状由各 provider 自己解释，核心层不认识它。 */
export type RawItem = Record<string, unknown>;

/**
 * 归一化后的任务：跨平台共用的最小形状，定稿于 T03、T04 补第八键、#36 补第九键 `labels`。
 * 九个键恒定，不按平台分叉；平台专有信息不许夹带在九键之外——各家差异一律在 `normalize` 里消化掉，
 * 否则跨平台合并（T05）与打分（T04）会建在原始字段上。
 * `dueAt` 之所以在里面：逾期与今日到期是跨平台共有的语义（US#23），不是 GitHub 的 milestone 泄漏进了全局形状。
 */
export interface Task {
  /** `${providerId}:${remoteId}`，跨轮次稳定。 */
  id: string;
  providerId: string;
  title: string;
  url: string;
  /** 平台原始状态字面量，由 doneStates / deletedStates 解释。 */
  state: string;
  /** 标签名（#36 的第九键）：学习加权按它多认一维，摘要按它上行；归一化后恒为数组，没有就是空。 */
  labels: readonly string[];
  /** 统一成 UTC 的 `toISOString()` 形状：各家原始格式（`Z` / `+0800`）不可直接比大小。 */
  updatedAt: string;
  /**
   * 截止时间，同样一律 UTC；没有截止时间的条目显式写 `undefined`，让键集合恒定。
   * 它是跨平台共有的语义（US#23 要逾期与今日到期在视觉上更强），不是某家平台的专有信息。
   */
  dueAt?: string;
  /**
   * `dueAt` 的粒度：源站只写了日期（`day`）还是写了时刻（`instant`），与 `dueAt` 同生同灭。
   * 少了它，「只写日期」和「恰好 UTC 午夜」进了定稿就长得一样，而这两件事对访客的意思相反：
   * 前者是「那一天做完都算及时」，得按日比；后者是一个瞬间，得按瞬间比（ADR-0005）。
   */
  duePrecision?: DuePrecision;
}

/** 清单范围：v1 只有「派给我的」；`includeDone` 让演示快照把已完成条目也取回来核对精选数据。 */
export interface Scope {
  assignee: string;
  includeDone?: boolean;
}

export interface Provider {
  readonly id: string;
  /** 当前视图：默认只取未完成；`includeDone` 时连已完成一起取回，交给 `doneStates` 收敛。 */
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
  /**
   * 这个平台的两件事：查的是哪一片（人可读），以及**授权粒度**。
   * 授权粒度必须从 provider 出来：GitHub 有公开/私有两档，Gitee / Jira / 飞书 没有，
   * 界面按这个结构渲染，不认得任何一家平台的名字（US#16、DECISIONS.md §0.4）。
   */
  scopeDescriptor(scope: Scope): ScopeDescriptor;
}

/** 授权档：同一平台内按公开/私有拆开的粒度。 */
export type Tier = "public" | "private";

/** 一档在界面上的名字：档位标识与标签由平台给。 */
export interface TierChoice {
  readonly tier: Tier;
  readonly label: string;
}

/**
 * 授权粒度：`tiered` 是可按档分别授权（GitHub），`uniform` 是平台侧没有这个维度。
 * `uniform.note` 直接给界面读，避免差异散落进每个 `if`。
 */
export type AuthGranularity =
  | { readonly kind: "tiered"; readonly tiers: readonly TierChoice[] }
  | { readonly kind: "uniform"; readonly note: string };

export interface ScopeDescriptor {
  /** 本轮查的是哪一片，人可读。 */
  readonly range: string;
  readonly auth: AuthGranularity;
}

/** 平台侧没有公开/私有维度时的那一行说明：措辞只在这里出现。 */
export function uniformAuth(range: string): ScopeDescriptor {
  return { range, auth: { kind: "uniform", note: "该平台授权粒度不区分公开/私有" } };
}

/** 可按档授权的平台的描述：档位与标签由平台给，怎么铺开由界面按档渲染。 */
export function tieredAuth(range: string, tiers: readonly TierChoice[]): ScopeDescriptor {
  return { range, auth: { kind: "tiered", tiers } };
}

/** 任务 id 的编解码只在这三个函数里出现，其余地方不解析它。 */
export function makeTaskId(providerId: string, remoteId: string | number): string {
  return `${providerId}:${remoteId}`;
}

export function remoteIdOf(taskId: string): string {
  return taskId.slice(taskId.indexOf(":") + 1);
}

export function providerIdOf(taskId: string): string {
  return taskId.slice(0, taskId.indexOf(":"));
}

/** 截止时间写到了哪一层精度：只有日期，还是带时刻。 */
export type DuePrecision = "day" | "instant";

/**
 * 原始截止值 → 定稿里那一对键。折算与粒度判定只在这一处，两件事共用同一个 `DATE_ONLY` 判断，
 * 所以不会出现 `dueAt` 说是午夜、`duePrecision` 说是日期。
 * 只写日期（`2026-11-17`）说的是「那天做完都算及时」：`dueAt` 取那一天的起点，「是哪一天」由它的
 * UTC 日期部分带下去，打分按日比而不拿它当时刻用。带时刻的原始串仍走 `Date` 解析。
 */
export function dueFrom(raw: string): { dueAt: string; duePrecision: DuePrecision } {
  return DATE_ONLY.test(raw)
    ? { dueAt: `${raw}T00:00:00.000Z`, duePrecision: "day" }
    : { dueAt: new Date(raw).toISOString(), duePrecision: "instant" };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 各家 `labels` 数组的公共读法：GitHub / Gitee 都是 `[{ name }]`，Jira 是字符串数组。
 * 只收名字、去空去重；provider 各自决定从原始条目的哪个键取，这里只认数组本身。
 */
export function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .map((one) => (typeof one === "string" ? one : (one as { name?: unknown })?.name))
    .filter((one): one is string => typeof one === "string")
    .map((one) => one.trim())
    .filter((one) => one !== "");
  return [...new Set(names)];
}
