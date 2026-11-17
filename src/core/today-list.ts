import type { Http, Provider, Scope, Task } from "./provider";
import { hitsByGroup, type PlacementRecord } from "./learning";
import { sourceGroupOf } from "./source-group";

export type { PlacementRecord };

export interface TodayListDeps {
  providers: readonly Provider[];
  http: Http;
  now: () => Date;
  scope: Scope;
  /**
   * 上一轮清单里的任务，用来判断"这一轮有哪些条目该跟着刷新"。省略即第一轮。
   * 跨轮状态由调用方保管：provider 与构建器都不落盘，也不从别处读。
   */
  previous?: readonly Task[];
  /**
   * 访客相对 UTC 的分钟偏移（UTC+8 是 480），用来把「今日」判成访客日历里的今天。
   * 省略即 UTC 日界。构建器不自己读宿主时区：那样同一个输入在 CI（TZ=UTC）
   * 与用户浏览器里会判出两种顺序，门内绿的正是线上错的。
   */
  zoneOffsetMinutes?: number;
  /**
   * 「这两条任务是不是同一件事」的判定策略，跨平台合并（#7）的唯一入口。
   * 省略即不合并：宁可在清单上看见两张卡，也不在没有任何判据时把两条不同的事折成一条。
   * 构建器不自己写判据——标题相似度是 #18 的语义匹配要买的东西，写死在这里就等于宣布它不需要了。
   */
  sameEvent?: SameEvent;
  /**
   * 访客手动排过的顺序：卡片标识（合并卡的表头 id）按他留下的次序排好。
   * 排在这个表里的卡一律在前面，其余按规则打分跟在后面——手动那一票优先于档位（ADR-0007）。
   * 省略即完全按规则排。构建器不自己读浏览器存储：那样同一份输入在 CI 与访客浏览器里会排成两种顺序。
   */
  manualOrder?: readonly string[];
  /**
   * 访客往期的放置记录（`#10` 学习闭环）：命中的来源分组在**档内**获得优先权，档序一个字都不改。
   * 和 `manualOrder` 同一个理由——构建器不自己读浏览器存储，否则同一份输入在 CI 与访客浏览器里会排成两种顺序。
   * 省略或空数组即完全没有学习这回事，输出回到 ADR-0005 的档内序。
   */
  orderHistory?: readonly PlacementRecord[];
}

export interface TodayList {
  /** 构建器运行那一刻，来自注入的时钟。 */
  generatedAt: string;
  entries: ListEntry[];
}

/**
 * 清单条目 = 任务 + 它为什么排在这里。
 * 理由不塞进任务本身：定稿的八键是跨平台最小形状（T03），打分是构建器这一侧的事。
 */
export interface ListEntry {
  task: Task;
  reason: RuleId;
  /**
   * 这张卡是**被学习加权抬上来**的那一条时才有它：命中的是哪个来源分组、近期置顶过几次。
   * #8 的「为什么是这几条」与卡片上那句本地文案读它，八键不动——和 `reason` 同一个理由。
   * 手动区里的卡不带它：那张卡站在那儿是因为访客自己拖过它，说成「因为连续置顶」就是假话。
   */
  learned?: LearnedBoost;
  /**
   * 这张卡合成自哪几条原始记录，只在真的合并过时存在，第一条就是 `task`。
   * 和 `reason` 同一个理由：来源集合是构建器这一侧的结论，八键不因合并而长。
   * #8 的「为什么是这几条」与界面上的逐个跳转都读它。
   */
  mergedFrom?: readonly Task[];
}

/** 学习加权命中的那个来源分组，以及它在窗口内被置顶的次数（`#10`）。 */
export interface LearnedBoost {
  group: string;
  hits: number;
}

/** 「这两条是不是同一件事」：#18 的语义匹配与 #7 的判定表都实现这一个签名。 */
export type SameEvent = (a: Task, b: Task) => boolean;

/**
 * 命中规则的标识，不是句子。#8「为什么是这几条」与界面措辞要的是这个标识，
 * 分数留给 #10 学习加权再加——现在没有规则需要它。
 */
export type RuleId = "overdue" | "dueToday" | "noDeadline" | "dueLater";

/**
 * 档位表：谁排在谁前面。顺序只由这张表和档内比较决定，规则本身不写数字。
 * `noDeadline` 与 `dueLater` 同档：它们只是「为什么不在今天」的两个原因，不代表两种紧急度。
 */
const RANK: Record<RuleId, number> = { overdue: 0, dueToday: 1, noDeadline: 2, dueLater: 2 };

/**
 * seam 1「今日清单构建器」：取数 → 归一 → 收敛 → 打分 → 手动那一票。
 * 每个 provider 每轮一个 search，外加至多一次按 id 批量取回。
 */
export async function buildTodayList({
  providers,
  http,
  now,
  scope,
  previous = [],
  zoneOffsetMinutes,
  sameEvent,
  manualOrder,
  orderHistory = [],
}: TodayListDeps): Promise<TodayList> {
  const batches = await Promise.all(providers.map((provider) => buildOne(provider, http, scope, previous)));

  // 打分（T04）先按规则分堆，堆内按最近有动静排。
  // normalize 已把各家时间统一成 UTC，字符串比较才成立；时钟只取一次，同一轮里不许变。
  const instant = now().toISOString();
  const boost = hitsByGroup(orderHistory, instant);
  const entries: ListEntry[] = batches
    .flat()
    .map((task) => {
      const group = sourceGroupOf(task);
      const hits = boost.get(group);
      return {
        task,
        reason: ruleOf(task, instant, zoneOffsetMinutes),
        ...(hits === undefined ? {} : { learned: { group, hits } }),
      };
    });
  // 学习加权插在档位**之后**、更新时间之前（ADR-0009）：它表达的是「同一种紧急度里先看哪条」，
  // 不是「这条比逾期还急」。没命中的那些条 `learned` 缺席，取 0，于是这一层是平的，
  // 比较落到原来的 updatedAt → 码元序，ADR-0005 定下来的档内序一个字没动。
  // 末位按 id 破平：档位与更新时间都相同的那些条目不能由 provider 返回的数组顺序决定，
  // 那个顺序不属于本应用（T05 合并四家之后更明显）。
  entries.sort(
    (a, b) =>
      RANK[a.reason] - RANK[b.reason] ||
      (b.learned?.hits ?? 0) - (a.learned?.hits ?? 0) ||
      byCode(b.task.updatedAt, a.task.updatedAt) ||
      byCode(a.task.id, b.task.id),
  );

  return { generatedAt: instant, entries: applyManualOrder(mergeDuplicates(entries, sameEvent), manualOrder) };
}

/**
 * 手动那一票（#9）：排在 `manualOrder` 里的卡按访客留下的次序在前，其余保持规则序跟在后面。
 * 作用在合并**之后**：`manualOrder` 记的是界面上看得见的卡，而被并掉的那条已经不是卡了。
 * 若放在合并之前，把某条来源排到最前会让它当上表头、连带把整张卡的档位改掉——ADR-0006 要守的正是那个。
 * 代价记在 ADR-0007：界面一次落盘写的是整份可见顺序，所以那一次之后所有已有卡都在手动区里，
 * 之后新变成逾期的那条不会挤进来，它落在未排区的最前面。
 * 手动区里的那些条目同时去掉命中标记：那张卡的位置是访客那一票给的，
 * 文案再说「因为你连续把它排在前面」就是把规则那一层记在了别人头上（AC#3 与 ADR-0007 的交界）。
 */
function applyManualOrder(entries: ListEntry[], manualOrder?: readonly string[]): ListEntry[] {
  if (manualOrder === undefined) return entries;
  const posOf = new Map(manualOrder.map((id, at) => [id, at] as const));
  const placed: { entry: ListEntry; at: number }[] = [];
  const rest: ListEntry[] = [];
  for (const entry of entries) {
    const at = posOf.get(entry.task.id);
    if (at === undefined) rest.push(entry);
    else placed.push({ entry: withoutLearned(entry), at });
  }
  placed.sort((a, b) => a.at - b.at);
  return [...placed.map(({ entry }) => entry), ...rest];
}

/** 去掉命中标记，其余原样：`learned` 这个键缺席而不是等于 undefined，界面上「有没有它」只有一种读法。 */
function withoutLearned(entry: ListEntry): ListEntry {
  const { learned, ...rest } = entry;
  return rest;
}

/**
 * 跨平台重复项合并（#7）：按已经排好的顺序走一遍，每条先看能不能并进某个已开卡片的表头。
 * 顺序放在打分之后带来两个不用另外规定的结果：表头天然站在这一组最紧急的档位上
 * （并卡不会把逾期折成今日到期），而谁当表头只由档位与更新时间决定，与 provider 返回的数组顺序无关。
 * 判定只拿表头比：`sameEvent` 说的是「这两条是不是同一件事」，一组对外由表头代表。
 */
function mergeDuplicates(entries: ListEntry[], sameEvent?: SameEvent): ListEntry[] {
  if (sameEvent === undefined) return entries;
  const groups: ListEntry[] = [];
  for (const entry of entries) {
    const home = groups.find((head) => sameEvent(head.task, entry.task));
    if (home === undefined) groups.push(entry);
    else home.mergedFrom = [...(home.mergedFrom ?? [home.task]), entry.task];
  }
  return groups;
}

/**
 * 这条排在这里是哪条规则决定的。第三档有两个标识：压根没写截止，与截止在更晚的那天——
 * 「最近更新」对后者是句假话，而 AC#2 要的就是原因本身。
 * 「今日」比的才是日界，所以它需要知道访客在哪一天。
 * 先比瞬间再比日：今天但已经过去的时刻算逾期，不算今日到期。
 * 不是「未来 24 小时内」：那是时长，不是日历日。
 *
 * 只写日期的截止走另一条路，因为它没有瞬间可比：源站写 `2026-11-17` 说的是「访客的 11-17 这天
 * 做完都算及时」，那一天归哪一天由源站已经写死了，再套一次访客偏移反而会把它推到相邻日。
 * 于是它比的是两个日历日——写下的那天 vs 访客的今天，`YYYY-MM-DD` 的字典序就是时间序。
 */
function ruleOf(task: Task, instant: string, zoneOffsetMinutes?: number): RuleId {
  if (task.dueAt === undefined) return "noDeadline";
  if (task.duePrecision === "day") {
    const dueDay = task.dueAt.slice(0, 10);
    const today = dayOf(instant, zoneOffsetMinutes);
    return dueDay < today ? "overdue" : dueDay === today ? "dueToday" : "dueLater";
  }
  if (task.dueAt < instant) return "overdue";
  return dayOf(task.dueAt, zoneOffsetMinutes) === dayOf(instant, zoneOffsetMinutes) ? "dueToday" : "dueLater";
}

/**
 * 一条瞬间落在哪一天。没有偏移就取它的 UTC 日（ISO 串的前十个字符）；
 * 给了偏移先把墙上时间平移到访客那一侧，再取日。
 */
function dayOf(instant: string, zoneOffsetMinutes?: number): string {
  if (zoneOffsetMinutes === undefined) return instant.slice(0, 10);
  return new Date(Date.parse(instant) + zoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * 比较用码元序：`<` 比的是 UTF-16 码元序列，结果不随宿主环境变。id 由 `${providerId}:${remoteId}`
 * 拼成（provider.ts:76-82），里面带 `:` `#` `/` 与大小写，所以破平判据不能是 `localeCompare`——
 * 它的序是宿主语言环境的函数，门内 CI 与访客浏览器可能排成两种顺序。（这一层在本机没有反例：
 * `"\u{10000}".localeCompare("\uFFFF")` 与 `<` 同向；不用它是因为序要可复现，不是因为已测出它错。）
 * 码元序与码点序在 BMP 内重合，出了 BMP 才分家：`"\u{10000}" < "\uFFFF"` 为真（码元 55296 < 65535），
 * 码点序里 U+10000 > U+FFFF 反过来。今天这批 ASCII 样本两者重合，seam 测试分辨不了这个差别。
 */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function buildOne(
  provider: Provider,
  http: Http,
  scope: Scope,
  previous: readonly Task[],
): Promise<Task[]> {
  // 空数组 = 这个平台任何状态都不算完成/删除，条目一律留在清单里。
  const done = new Set(provider.doneStates());
  const deleted = new Set(provider.deletedStates());
  const stillOpen = (task: Task) => !done.has(task.state) && !deleted.has(task.state);

  const seen = (await provider.search(scope, http)).map(provider.normalize);

  // 本轮视图已经给出这条的状态，就不再按 id 问第二次：再问一次只会把上一轮的旧状态请回来。
  const unseen = previous.filter(
    (task) => task.providerId === provider.id && !seen.some((s) => s.id === task.id),
  );
  const carried = unseen.length === 0 ? [] : await carryOver(provider, http, unseen);

  return [...seen, ...carried].filter(stillOpen);
}

/**
 * 上一轮有、本轮视图里没有的条目：一次批量取回分辨「已被删除」与「这次没返回」。
 * 批量没返回的 id 视为跳过——保留上一轮那条，而不是当成已删除。
 */
async function carryOver(provider: Provider, http: Http, unseen: readonly Task[]): Promise<Task[]> {
  const refreshed = new Map(
    (await provider.getByIds(unseen.map((task) => task.id), http))
      .map(provider.normalize)
      .map((task) => [task.id, task] as const),
  );
  return unseen.map((task) => refreshed.get(task.id) ?? task);
}
