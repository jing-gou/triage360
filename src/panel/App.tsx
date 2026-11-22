import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Provider, Scope, Tier } from "../core/provider";
import { sourceGroupOf } from "../core/source-group";
import {
  buildTodayList,
  type ListEntry,
  type PlacementRecord,
  type RuleId,
  type TodayList,
} from "../core/today-list";
import { createSampleProviders, demoSameEvent, sampleHttp } from "../fakes/samples";
import { createGiteeProvider } from "../providers/gitee";
import { createGithubProvider } from "../providers/github";
import {
  API_BASE,
  adoptSessionFromUrl,
  fetchDemoItems,
  fetchItems,
  forgetSession,
  requestAuthUrl,
  requestReason,
  requestSummary,
  revokeSession,
  UnauthenticatedError,
  type DemoPayload,
  type GithubAuth,
  type ItemsPayload,
  type TierGrant,
} from "./api";
import { createSnapshotHttp, type SnapshotFailure } from "./snapshot-http";
import { cachedSummary, rememberSummary, summaryKey } from "./summary-cache";
import { SUMMARY_CONCURRENCY, SUMMARY_LIMIT } from "../core/summary-card";
import type { ReasonCard } from "../core/reason-card";
import { appendLearningRecord, loadLearningRecords } from "./learning-records";
import { clearLocalRecords, hasLocalRecords } from "./local-records";
import { hasSeenOrderNotice, loadManualOrder, markOrderNoticeSeen, saveManualOrder } from "./manual-order";

const scope: Scope = { assignee: "me" };
const sampleProviders: Provider[] = createSampleProviders();
/** 真接入的平台；样例里 id 相同的让位，弹层里同一平台只出现一次。 */
const wiredProviders: Provider[] = [createGithubProvider(), createGiteeProvider()];
/** 授权档位弹层的平台清单：真接入的在前，其余用样例 provider 的粒度说明。 */
const authProviders: Provider[] = [
  ...wiredProviders,
  ...sampleProviders.filter((one) => !wiredProviders.some((wired) => wired.id === one.id)),
];
const WALL_CLOCK = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 这一轮服务端手里还握着哪几家的授权；`null` = 这一屏没走真实链路。Jira 只出现在内部自证里，没有界面入口。 */
type Connected = { github: boolean; gitee: boolean; jira?: boolean };

/** 可见 tab 的轮询间隔：两家的 `pollIntervalMs()` 都是 30 秒，这里取同一个节拍。 */
const POLL_MS = 30_000;

/** 一家这一轮的问题：授权失效、权限没给够、还是上游暂时不可达。 */
interface ProviderProblem {
  providerId: SnapshotFailure;
  kind: "reauth" | "scope" | "unavailable";
  detail?: string;
}

function problemLabel(problem: ProviderProblem): string {
  const name = SOURCE_LABELS[problem.providerId]?.label ?? problem.providerId;
  const reason =
    problem.kind === "reauth" ? "授权已失效" : problem.kind === "scope" ? "权限未授予" : "暂不可达";
  return `${name} ${reason}`;
}

function providersFrom(flags: Connected): Provider[] {
  const providers: Provider[] = [];
  if (flags.github) providers.push(createGithubProvider());
  if (flags.gitee) providers.push(createGiteeProvider());
  return providers;
}

/**
 * 授权失效的家也留在构建里：它这一轮取不到数，正好走失败分支，把上一轮卡片连同水印一起留下
 * （Q37「保留上次快照水印」）。只把「从没连过」的家排除在外。
 */
function providersFromPayload(payload: ItemsPayload, expired: ReadonlySet<SnapshotFailure>): Provider[] {
  return providersFrom({
    github: payload.github.status !== "none" || expired.has("github"),
    gitee: payload.gitee.status !== "none" || expired.has("gitee"),
  });
}

/** `reauth` 与上游故障同走失败分支：前者卡片带水印留存，后者同样退回上一轮。 */
function failuresFrom(payload: ItemsPayload, expired: ReadonlySet<SnapshotFailure>): SnapshotFailure[] {
  const failed: SnapshotFailure[] = [];
  if (payload.github.status === "unavailable" || payload.github.status === "reauth" || expired.has("github")) {
    failed.push("github");
  }
  if (payload.gitee.status === "unavailable" || payload.gitee.status === "reauth" || expired.has("gitee")) {
    failed.push("gitee");
  }
  return failed;
}

function problemsFrom(
  payload: ItemsPayload,
  expired: ReadonlySet<SnapshotFailure>,
  droppedTiers: ReadonlySet<Tier>,
): ProviderProblem[] {
  const problems: ProviderProblem[] = [];
  const scopeMissing = Object.values(payload.auth.grants).some(
    (grant) => grant !== undefined && grant.missing.length > 0,
  );
  // 授权失效不会因为服务端下一轮不再报 reauth 就自愈：在重新授权之前，角标一直给入口。
  if (expired.has("github") || payload.github.status === "reauth" || droppedTiers.size > 0) {
    problems.push({ providerId: "github", kind: "reauth" });
  } else if (payload.github.status === "unavailable") {
    problems.push({
      providerId: "github",
      // 只有这一轮真的是 403 且非限流时才算权限问题；库存的 missing scope 不能替上游故障背锅。
      kind: payload.github.forbidden === true && scopeMissing ? "scope" : "unavailable",
      ...(payload.github.detail === undefined ? {} : { detail: payload.github.detail }),
    });
  }
  if (expired.has("gitee") || payload.gitee.status === "reauth") {
    problems.push({ providerId: "gitee", kind: "reauth" });
  } else if (payload.gitee.status === "unavailable") {
    problems.push({
      providerId: "gitee",
      kind: "unavailable",
      ...(payload.gitee.detail === undefined ? {} : { detail: payload.gitee.detail }),
    });
  }
  return problems;
}

/**
 * 演示截图用的确定性异常态：`?demoFail=github|gitee` 只在公开演示路径生效。
 * 先按真实快照成功建一轮，再让选中的那一家抛错，走的是和线上一样的失败分支与水印。
 */
function forcedDemoFailure(): SnapshotFailure | null {
  const value = new URLSearchParams(window.location.search).get("demoFail");
  return value === "github" || value === "gitee" ? value : null;
}

/** 合并卡的全部来源；没合并就是它自己。跨轮、水印与删除确认都按这个全集走（ADR-0003、ADR-0006）。 */
function sourcesOf(entry: ListEntry): readonly ListEntry["task"][] {
  return entry.mergedFrom ?? [entry.task];
}

/**
 * 每条上一轮任务按**自己的 provider**取最后成功时刻。
 * 合并卡只有一个 `snapshotAt`，分不清是哪一侧失败；把它抄给两边会让另一侧下次失败时
 * 显示更早的时间，所以这里维护的是逐家账，不是逐卡账。
 */
function snapshotTimes(
  list: TodayList | null,
  lastGoodAt: ReadonlyMap<string, string>,
): Record<string, string> {
  if (list === null) return {};
  const out: Record<string, string> = {};
  for (const entry of list.entries) {
    for (const task of sourcesOf(entry)) {
      const at = lastGoodAt.get(task.providerId);
      if (at !== undefined) out[task.id] = at;
    }
  }
  return out;
}

/** 上一轮清单里的全部任务 id：合并卡的每个来源都要保留，源站关掉其中一侧时卡片才会收紧。 */
function previousIdsOf(list: TodayList | null): string[] {
  if (list === null) return [];
  return [...new Set(list.entries.flatMap((entry) => sourcesOf(entry).map((task) => task.id)))];
}

interface RoundOptions {
  providers: readonly Provider[];
  githubItems: readonly unknown[];
  giteeItems: readonly unknown[];
  /** 上一轮见过、这一轮活跃视图没返回、由服务端按 id 核对回来的记录。 */
  githubPrevious?: readonly unknown[];
  giteePrevious?: readonly unknown[];
  failed: readonly SnapshotFailure[];
  now: Date;
  scope: Scope;
  zoneOffsetMinutes: number;
  previous: TodayList | null;
  /** 各 provider 最后一次成功取数的时刻；失败家的上一轮任务靠它停在水印上。 */
  lastGoodAt: ReadonlyMap<string, string>;
  manualOrder: readonly string[];
  placements: readonly PlacementRecord[];
}

/** 服务端已经取回原始条目；归一、收敛、打分与跨轮补取仍在本机走 seam 1。 */
function buildRound({
  providers,
  githubItems,
  giteeItems,
  githubPrevious = [],
  giteePrevious = [],
  failed,
  now,
  scope,
  zoneOffsetMinutes,
  previous,
  lastGoodAt,
  manualOrder,
  placements,
}: RoundOptions): Promise<TodayList> {
  const previousTasks = previous === null ? [] : previous.entries.flatMap(sourcesOf);
  return buildTodayList({
    providers: [...providers],
    http: createSnapshotHttp(githubItems, giteeItems, failed, githubPrevious, giteePrevious),
    now: () => now,
    scope,
    zoneOffsetMinutes,
    sameEvent: demoSameEvent,
    ...(previous === null
      ? {}
      : {
          previous: previousTasks,
          previousGeneratedAt: previous.generatedAt,
          previousSnapshotAt: snapshotTimes(previous, lastGoodAt),
        }),
    manualOrder,
    placements,
  });
}

/**
 * 来源在界面上的真实程度（`docs/PRD.md` 的真实程度表）。默认四家都是字面量数据，
 * 所以都标样例数据；某一家真的连上之后这一家才不带样例标记（GitHub T09、Gitee #17），
 * 其余没连的仍要带限定词——「面板连着后端」不等于「这一家是真实的」。
 */
const SOURCE_LABELS: Record<string, { label: string; sample?: string }> = {
  github: { label: "GitHub", sample: "样例数据" },
  gitee: { label: "Gitee", sample: "样例数据" },
  jira: { label: "Jira", sample: "样例数据" },
  feishu: { label: "飞书", sample: "样例数据 · 真实接入需企业自建应用" },
};

/**
 * 真实链路上的 GitHub / Gitee 不再标样例——包括这一家本轮授权失效、暂时不在 connected 里的情况：
 * 它仍是已接线的平台，只是需要重连；把失效说成「样例」会把问题指错方向。
 * 样例屏（connected === null）与 Jira / 飞书仍保留限定词。
 */
function sourceLabel(providerId: string, connected: Connected | null): { label: string; sample?: string } {
  const base = SOURCE_LABELS[providerId] ?? { label: providerId };
  const wired = wiredProviders.some((provider) => provider.id === providerId);
  return wired && connected !== null ? { label: base.label } : base;
}

/**
 * 理由标识的措辞（`docs/PRD.md`：规则打分决定顺序，措辞是另一层）。
 * 界面只翻译标识，不再判断一次档位——判断在 seam 1 里，两处口径会分叉。
 */
const REASON_LABELS: Record<RuleId, string> = {
  overdue: "已逾期",
  dueToday: "今日到期",
  noDeadline: "无截止时间",
  dueLater: "未到截止日",
};

/** 纯规则理由：AI 不可用或失败时的回落句。有学习信号时同一句里说清两个来源层（AC#6）。
 *  只说档位、不承诺名次：拖过之后位置归访客，句子仍得为真。 */
const RULE_WORDINGS: Record<RuleId, string> = {
  overdue: "它已经逾期，按规则落在逾期这一档。",
  dueToday: "它今天到期，按规则落在今日到期这一档。",
  noDeadline: "它没有写截止时间，按规则排在未写截止日的那一档。",
  dueLater: "它的截止日在更晚的一天，按规则排在未到截止日的那一档。",
};

/** 一张卡被问过「为什么」之后的状态：加载中，或者一句话（AI 措辞 / 规则回落）。 */
type WhyState = { status: "loading" } | { status: "ready"; text: string };
/** 「AI 提炼」的卡片状态：与 why 同一个形状，但键是 `task.id@updatedAt`（源站一更新就自动失效）。 */
type SummaryState = WhyState;

/** 首次主动排序后要说的话：动了哪一条、从第几位到第几位。 */
interface OrderNotice {
  title: string;
  from: number;
  to: number;
}

/** 右下角的四个弹层（#13、#14）：连接前的自陈、撤销授权、清除本地记录、授权档位。同一时刻只有一个。 */
type Dialog = "consent" | "revoke" | "clear-local" | "tiers";

export function App() {
  const [list, setList] = useState<TodayList | null>(null);
  /** 完整视图（#18）：展开只切换渲染哪一份，取数在每一轮里早已完成，不会再发请求。 */
  const [fullViewOpen, setFullViewOpen] = useState(false);
  const [notice, setNotice] = useState<OrderNotice | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  /** 这一屏走的是真实链路：记录服务端还握着哪几家的授权；`null` = 样例屏。 */
  const [connected, setConnected] = useState<Connected | null>(null);
  /** 这一屏是公开演示快照：数据来自演示账号的真实取数，但没有访客自己的授权。 */
  const [demo, setDemo] = useState(false);
  const live = connected !== null && !demo;
  /** 这一屏最终落在哪条数据源上；样例屏不提供刷新，重载页面才会重新探测后端。 */
  const [dataMode, setDataMode] = useState<"live" | "demo" | "sample" | null>(null);
  const [reconnect, setReconnect] = useState(false);
  /** 这一轮每一家各自出了什么问题；空数组 = 常态，界面不多说一句。 */
  const [problems, setProblems] = useState<ProviderProblem[]>([]);
  /** 整轮刷新失败（后端不可达等）：保留上一轮清单，只角标里说一句。 */
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 轮询与手动刷新共用一个入口；由挂载时的 effect 装填，按钮只负责喊一声。 */
  const refreshRef = useRef<() => void>(() => {});
  /** 浏览器手里还握着一枚会话标识：即便这一屏没连上，撤销入口也得在——否则旧租户没人能清。 */
  const [hasSession, setHasSession] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [hasLocal, setHasLocal] = useState(false);
  /** 服务端报回来的各档实际授权；只有连上真实会话之后才有。 */
  const [auth, setAuth] = useState<GithubAuth | null>(null);
  /** 每张卡被问过「为什么」之后的那句话；键是卡片标识（合并卡即表头 id）。 */
  const [why, setWhy] = useState<Record<string, WhyState>>({});
  /** 「AI 提炼」的结果；键带 updatedAt，源站更新后旧摘要自然不再命中。 */
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const [summarizing, setSummarizing] = useState(false);
  /** 这一轮没提炼出来的张数：解析失败、超时或上游故障都算，给用户一句可见的反馈。 */
  const [summaryNote, setSummaryNote] = useState<string | null>(null);
  /** 演示屏没有会话，摘要由服务端刷新时预生成（#20）；没有它就藏起按钮。 */
  const [demoSummaries, setDemoSummaries] = useState<Record<string, string> | null>(null);
  // 拖拽会把在途请求的答案作废：请求发出时记下代数，回来时代数变了就丢掉，不把旧句写回手动区。
  const whyEpoch = useRef(0);

  useEffect(() => {
    let alive = true;
    /** 这一屏的数据源已经定了：轮询只沿用它，不因为一次失败就悄悄换成样例。 */
    let mode: "live" | "demo" | "sample" | null = null;
    /** 上一轮的清单：下一轮把它交给构建器，源站已删除的条目才会真的消失。 */
    let previous: TodayList | null = null;
    /** 各 provider 最后一次成功取数的时刻：一家失败多轮时，水印停在那里不往后滚。 */
    const lastGoodAt = new Map<string, string>();
    /** 已经报过授权失效的家/档：服务端下一轮不再报 reauth，也不等于授权自己恢复了。 */
    const expired = new Set<SnapshotFailure>();
    const droppedTiers = new Set<Tier>();
    let busy = false;
    // 「今日」按访客日历里的今天判：偏移由界面这一侧喂进来，构建器自己不读宿主时区（ADR-0005）。
    const zoneOffsetMinutes = -new Date().getTimezoneOffset();
    // 演示异常态只在公开快照这一屏生效，登录用户不会被一个查询参数改变数据源。
    const forcedFailure = forcedDemoFailure();

    /** 手动顺序与放置记录每轮重读：刚拖过的卡不能被上一轮的内存副本覆盖（ADR-0007、ADR-0009）。 */
    function localRecords() {
      const records = { manualOrder: loadManualOrder(), placements: loadLearningRecords() };
      if (alive) setHasLocal(hasLocalRecords());
      return records;
    }

    /** 只有这一轮整家真的取到数的才推进时刻；失败家与被摘掉一档的家保持原值，水印才停得住。 */
    function rememberGood(list: TodayList, providers: readonly Provider[], holdBack: ReadonlySet<string> = new Set()): void {
      for (const provider of providers) {
        if (!list.failures.includes(provider.id) && !holdBack.has(provider.id)) {
          lastGoodAt.set(provider.id, list.generatedAt);
        }
      }
    }

    async function runLive(session: string, initial: boolean): Promise<boolean> {
      let payload: ItemsPayload;
      try {
        // 上一轮的 id 交给服务端向源站确认：活跃视图不再返回的卡片才有机会收敛掉。
        payload = await fetchItems(API_BASE, session, previousIdsOf(previous));
      } catch (error) {
        if (error instanceof UnauthenticatedError) {
          forgetSession();
          if (!alive) return false;
          setHasSession(false);
          setAuth(null);
          // 会话都没了：保留上一屏，但角标必须说「重新连接」，不能静默空列表。
          setRefreshNote(null);
          setReconnect(true);
          return false;
        }
        if (!alive) return false;
        if (!initial) {
          // 网络 / 服务端抖动不该把已显示的清单换成空屏，也不该伪装成「今天没有任务」。
          setRefreshNote("刷新失败，显示上一轮快照");
          return false;
        }
        setAuth(null);
        setConnected(null);
        setProblems([]);
        setReconnect(true);
        return false;
      }

      // 服务端这一轮重新报 ok，才说明那一家真的接回来了；否则授权失效要在角标上留到重新授权。
      if (payload.github.status === "ok") expired.delete("github");
      if (payload.github.status === "reauth") expired.add("github");
      if (payload.gitee.status === "ok") expired.delete("gitee");
      if (payload.gitee.status === "reauth") expired.add("gitee");
      for (const tier of payload.auth.dropped) droppedTiers.add(tier);
      for (const tier of [...droppedTiers]) {
        if (payload.auth.grants[tier] !== undefined) droppedTiers.delete(tier);
      }
      // 某一档被摘掉但另一档还能用时，GitHub 整家不算「整轮成功」：最后成功时刻不前进，
      // 那一档的旧卡才不会在下一轮被盖上更晚的水印。
      if (payload.github.status === "none" && droppedTiers.size > 0) expired.add("github");

      const local = localRecords();
      const providers = providersFromPayload(payload, expired);
      const next = await buildRound({
        providers,
        githubItems: payload.items,
        giteeItems: payload.gitee.items,
        githubPrevious: payload.github.previous,
        giteePrevious: payload.gitee.previous,
        failed: failuresFrom(payload, expired),
        now: new Date(),
        // 服务端快照里可能带已完成条目（演示租户的 includeDone）：带上它，Gitee 才会把
        // closed / rejected 的状态也取进完整视图；真实访客的快照没有这些条目，多取两次只会是空集。
        scope: { assignee: payload.login, includeDone: true },
        zoneOffsetMinutes,
        previous,
        lastGoodAt,
        ...local,
      });
      if (!alive) return true;
      rememberGood(next, providers, droppedTiers.size > 0 ? new Set(["github"]) : new Set());
      previous = next;
      setList(next);
      setAuth(payload.auth);
      setConnected(payload.connected);
      setDemo(false);
      setProblems(problemsFrom(payload, expired, droppedTiers));
      setRefreshNote(null);
      setReconnect(false);
      setDemoSummaries(null);
      return true;
    }

    async function runDemo(initial: boolean): Promise<boolean> {
      let snapshot: DemoPayload;
      try {
        snapshot = await fetchDemoItems(API_BASE);
      } catch {
        if (alive && !initial) setRefreshNote("刷新失败，显示上一轮快照");
        return false;
      }
      const providers = providersFrom(snapshot.connected);
      const local = localRecords();
      const base = {
        providers,
        githubItems: snapshot.items,
        giteeItems: snapshot.gitee,
        // 排序基准取快照时刻：访客看到的是那一轮取数的切片，不是「刚刚」。
        now: new Date(snapshot.generatedAt),
        // 演示快照是唯一确定带已完成条目的来源：Gitee 要把 closed / rejected 也取回来，
        // 否则「12 条未完成 + 71 条已完成」的 83 条在完整视图里只剩 12 条（#18 AC#3）。
        scope: { ...scope, includeDone: true },
        zoneOffsetMinutes,
        lastGoodAt,
        manualOrder: local.manualOrder,
        placements: local.placements,
      };
      let next = await buildRound({ ...base, previous, failed: [] });
      rememberGood(next, providers);
      const forcedHere = forcedFailure !== null && providers.some((provider) => provider.id === forcedFailure);
      if (forcedHere) {
        // 先成功建一轮、再让选中的一家失败：水印来自真实快照，不是手写的假数据。
        next = await buildRound({ ...base, previous: next, failed: [forcedFailure] });
        rememberGood(next, providers);
      }
      if (!alive) return true;
      previous = next;
      setList(next);
      setConnected(snapshot.connected);
      setDemo(true);
      setAuth(null);
      const precomputed = snapshot.summaries ?? {};
      setDemoSummaries(Object.keys(precomputed).length === 0 ? null : precomputed);
      setProblems(
        forcedHere && forcedFailure !== null
          ? [{ providerId: forcedFailure, kind: "unavailable", detail: "演示：模拟这一家取数失败。" }]
          : [],
      );
      setRefreshNote(null);
      return true;
    }

    async function runSample(): Promise<void> {
      const local = localRecords();
      const next = await buildTodayList({
        providers: sampleProviders,
        http: sampleHttp,
        now: () => new Date(),
        scope,
        zoneOffsetMinutes,
        sameEvent: demoSameEvent,
        ...local,
      });
      if (!alive) return;
      previous = next;
      setList(next);
      setConnected(null);
      setDemo(false);
      setAuth(null);
      setDemoSummaries(null);
      setProblems([]);
      setRefreshNote(null);
    }

    async function refresh(initial: boolean): Promise<void> {
      if (busy || !alive) return;
      busy = true;
      if (!initial) setRefreshing(true);
      try {
        if (mode === "live") {
          const session = adoptSessionFromUrl();
          if (session !== null) {
            await runLive(session, false);
            return;
          }
          // 会话在这台浏览器里已经没了：这条链路走不下去，退回公开快照；角标仍留着重新连接。
          // 数据源换了，上一轮是访客自己的清单，不能带进公开演示屏——否则私人卡片会被当成演示数据留着。
          previous = null;
          lastGoodAt.clear();
          expired.clear();
          droppedTiers.clear();
          if (await runDemo(false)) {
            mode = "demo";
            setDataMode("demo");
          }
          return;
        }
        if (mode === "demo") {
          await runDemo(false);
          return;
        }
        if (mode === "sample") return;

        // 首屏才决定数据源：有会话走真实链路，否则公开演示快照，再不行才样例。
        const session = API_BASE === "" ? null : adoptSessionFromUrl();
        if (session !== null) {
          setHasSession(true);
          if (await runLive(session, true)) {
            mode = "live";
            setDataMode("live");
            return;
          }
        }
        if (API_BASE !== "" && (await runDemo(true))) {
          mode = "demo";
          setDataMode("demo");
          return;
        }
        await runSample();
        mode = "sample";
        setDataMode("sample");
      } finally {
        busy = false;
        if (alive && !initial) setRefreshing(false);
      }
    }

    refreshRef.current = () => void refresh(false);
    void refresh(true);

    const poll = (): void => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    const timer = window.setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, []);

  /**
   * 把第 `from` 张卡挪到第 `to` 张的位置：落点用目标原来的序号，向上向下两侧读起来都直观。
   * 写进去的是**整份**可见顺序，所以这一次拖拽之后所有已有卡片都归访客，规则只对新条目说话（ADR-0007）。
   * 同一次拖拽另外记一条放置（#10）：`to` 就是它放完落在的第几位，0 基。
   */
  function move(from: number, to: number): void {
    if (list === null || from === to) return;
    const moved = list.entries[from];
    if (moved === undefined) return;
    const rest = list.entries.filter((_, index) => index !== from);
    rest.splice(to, 0, moved);
    // 落盘的是整份可见顺序 ⇒ 这些卡从这一次起都归手动区，命中标记一并去掉，与下一次刷新看到的一致（ADR-0009）。
    setList({ ...list, entries: rest.map(({ learned, ...entry }) => entry) });
    // 旧句是按档位与学习信号说的：拖过之后整份清单归手动区、命中标记被剥掉，
    // 「排在最前面」「连续置顶」就不再为真，一句都不留（ADR-0009、ADR-0013）。
    setWhy({});
    whyEpoch.current += 1;
    saveManualOrder(rest.map((entry) => entry.task.id));
    // 分组键当场算下来存：这一轮之后那条任务可能从清单上消失（关掉、转派），届时没人能重算它属于哪个来源。
    appendLearningRecord({
      providerId: moved.task.providerId,
      taskId: moved.task.id,
      group: sourceGroupOf(moved.task),
      at: new Date().toISOString(),
      position: to,
    });
    // 第一笔本地记录刚落下：右下角当场出现「清除本地记录」，不必等下一次刷新。
    setHasLocal(true);
    // 标记要等这句话真被看过才落盘：没关就刷新，下一次拖拽还会说一遍。
    if (!hasSeenOrderNotice()) setNotice({ title: moved.task.title, from, to });
  }

  function dismissNotice(): void {
    markOrderNoticeSeen();
    setNotice(null);
  }

  /**
   * 「为什么是这几条」（#8）：规则理由在本机就能算，AI 只是把它说成一句人话。
   * 没连真实会话、接口失败、客户端 2 秒兜底到点——都回落到同一句规则理由，卡片上不会出现空白。
   * 只有真会话才发请求：样例屏不碰网络，连不上时也不拿旧租户去试。
   */
  async function askWhy(entry: ListEntry): Promise<void> {
    const id = entry.task.id;
    if (why[id]?.status === "loading") return;
    const session = live && API_BASE !== "" ? adoptSessionFromUrl() : null;
    if (session === null) {
      setWhy((one) => ({ ...one, [id]: { status: "ready", text: ruleWording(entry) } }));
      return;
    }
    setWhy((one) => ({ ...one, [id]: { status: "loading" } }));
    const epoch = whyEpoch.current;
    try {
      const reply = await requestReason(API_BASE, session, reasonCardOf(entry));
      if (whyEpoch.current !== epoch) return;
      setWhy((one) => ({ ...one, [id]: { status: "ready", text: reply.text } }));
    } catch (error) {
      if (whyEpoch.current !== epoch) return;
      // 会话失效与取数走同一条出路：忘掉它、把角落换成重新连接，这张卡仍回落到规则句。
      if (error instanceof UnauthenticatedError) {
        forgetSession();
        setHasSession(false);
        setAuth(null);
        setReconnect(true);
      }
      setWhy((one) => ({ ...one, [id]: { status: "ready", text: ruleWording(entry) } }));
    }
  }

  /**
   * 「AI 提炼」（#20）：一次最多 20 张卡，并发 3 条、哪条先回来先填哪张。
   * 演示屏读服务端预生成的摘要；真实屏按 `task.id@updatedAt` 先看本机缓存，再打 `/api/summary`。
   * 只更新摘要状态，不碰 list / 拖拽，所以摘要长出来的过程中排序照常可用。
   */
  async function summarize(): Promise<void> {
    if (list === null || summarizing) return;
    const cards = list.entries.slice(0, SUMMARY_LIMIT);
    setSummarizing(true);
    setSummaryNote(null);
    try {
      if (demoSummaries !== null) {
        const ready: Record<string, SummaryState> = {};
        for (const entry of cards) {
          const text = demoSummaries[summaryKey(entry.task)];
          if (text !== undefined) ready[summaryKey(entry.task)] = { status: "ready", text };
        }
        setSummaries((one) => ({ ...one, ...ready }));
        const missing = cards.length - Object.keys(ready).length;
        if (missing > 0) setSummaryNote(`${missing} 张卡的演示摘要还没生成，下一轮刷新后再试。`);
        return;
      }
      const session = live ? adoptSessionFromUrl() : null;
      if (session === null) return;
      const pending = cards.filter((entry) => {
        const key = summaryKey(entry.task);
        return summaries[key] === undefined && cachedSummary(entry.task) === null;
      });
      if (pending.length === 0) return;
      setSummaries((one) => {
        const next = { ...one };
        for (const entry of pending) next[summaryKey(entry.task)] = { status: "loading" };
        return next;
      });
      let cursor = 0;
      let failed = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const chunk = pending[cursor++];
          if (chunk === undefined) return;
          const key = summaryKey(chunk.task);
          try {
            const { text } = await requestSummary(API_BASE, session, {
              title: chunk.task.title,
              labels: [...(chunk.labels ?? [])],
            });
            rememberSummary(chunk.task, text);
            setSummaries((one) => ({ ...one, [key]: { status: "ready", text } }));
          } catch (error) {
            if (error instanceof UnauthenticatedError) {
              forgetSession();
              setHasSession(false);
              setAuth(null);
              setReconnect(true);
            }
            failed += 1;
            setSummaries((one) => {
              const { [key]: _dropped, ...rest } = one;
              return rest;
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SUMMARY_CONCURRENCY, pending.length) }, worker));
      if (failed > 0) setSummaryNote(`${failed} 张卡这次没有提炼出来，稍后再试。`);
    } finally {
      setSummarizing(false);
    }
  }

  function openDialog(next: Dialog): void {
    setDialogError(null);
    setDialogBusy(false);
    setDialog(next);
  }

  /** 撤销（#13）：服务端物理删除并当场验证；失败就留在这一层说清楚，不假装成功。 */
  async function revoke(): Promise<void> {
    const session = adoptSessionFromUrl();
    if (session === null) {
      setDialogError("这台浏览器里没有会话记录，可能已经撤销过了。");
      return;
    }
    setDialogBusy(true);
    try {
      await revokeSession(API_BASE, session);
    } catch {
      setDialogBusy(false);
      setDialogError("撤销没有完成：服务端不可达或删除验证失败了，稍后再试。");
      return;
    }
    forgetSession();
    window.location.reload();
  }

  /** 某一档（或原授权被改小后重来）：服务端把这次授权挂回同一租户，返回 GitHub 授权页。 */
  async function authorizeTier(tier: Tier): Promise<void> {
    const session = adoptSessionFromUrl();
    if (session === null) {
      setDialogError("这台浏览器里没有会话记录，先连接 GitHub 再来。");
      return;
    }
    setDialogBusy(true);
    try {
      window.location.href = await requestAuthUrl(API_BASE, session, { provider: "github", tier });
    } catch {
      setDialogBusy(false);
      setDialogError("没有发起授权：会话已失效或服务端不可达，稍后再试。");
    }
  }

  /** Gitee 没有档位：一次授权一枚 token，过期后同样从这里重新走一遍。 */
  async function authorizeGitee(): Promise<void> {
    const session = adoptSessionFromUrl();
    if (session === null) {
      setDialogError("这台浏览器里没有会话记录，先连接再来。");
      return;
    }
    setDialogBusy(true);
    try {
      window.location.href = await requestAuthUrl(API_BASE, session, { provider: "gitee" });
    } catch {
      setDialogBusy(false);
      setDialogError("没有发起授权：会话已失效或服务端不可达，稍后再试。");
    }
  }

  /** 清完重载：内存里那份顺序还按旧记录排着，重载才和盘上一致。 */
  function clearLocal(): void {
    clearLocalRecords();
    window.location.reload();
  }

  if (!list) {
    return <main className="panel" />;
  }

  // 界面上只有这一个时间基准：构建器盖上的一致时间，不再伸手取第二个时钟。
  const generatedAt = new Date(list.generatedAt);
  // GitHub 侧把某一档授权改小时，角标当场标出来：缺的 scope 不藏在弹层里（T12 AC#3）。
  const scopeGap =
    auth !== null && Object.values(auth.grants).some((grant) => grant !== undefined && grant.missing.length > 0);
  // 本轮取数里被 401 摘掉的档更急：私有条目已经少了几条，角标先说这个。
  const authNote =
    auth === null ? null : auth.dropped.length > 0 ? "授权已失效" : scopeGap ? "实际授权已缩小" : null;
  // 角标已经点名 GitHub 的问题时，「授权档位」按钮不再重复同一句。
  const tierNote = problems.some((problem) => problem.providerId === "github") ? null : authNote;
  const giteeProblem = problems.find((problem) => problem.providerId === "gitee");
  const connectedAny = connected !== null && Object.values(connected).some(Boolean);
  // 会话没了、一家都没接上、或有授权问题：空清单要说得像「去处理授权」，不能像「今天没事」。
  const blockedEmpty =
    reconnect ||
    (connected !== null && !connectedAny) ||
    problems.some((problem) => problem.kind === "reauth" || problem.kind === "scope");
  const emptyMessage = blockedEmpty
    ? problems.some((problem) => problem.kind === "scope")
      ? "权限还没授予。按右下角重新授权后再刷新。"
      : "授权不可用。按右下角重新连接后再刷新。"
    : problems.length > 0
      ? "这一轮没有可显示的任务，原因在右下角。"
      : "今天没有指派给你的任务。";
  // 完整视图的入口与计数都从这里读一次，不在 JSX 里各算一遍。
  const completedCount = list.full.filter((entry) => entry.done).length;
  const hasFullView = connected !== null && completedCount > 0;

  return (
    <main className="panel">
      <h1 className="panel-title">今日清单</h1>
      {/* 完整视图只在源站确实带回了已完成条目时出现；样例屏（connected === null）不给，
          那一屏全是字面量，展开只会把样例当成对照数据。 */}
      {hasFullView && (
        <p className="view-toggle-row">
          <button
            aria-expanded={fullViewOpen}
            className="view-toggle"
            onClick={() => setFullViewOpen(!fullViewOpen)}
            type="button"
          >
            {fullViewOpen ? "收起，回到今日清单" : `展开完整视图（${list.full.length} 条）`}
          </button>
          {fullViewOpen && (
            <span className="view-toggle-note">
              今日清单 {list.entries.length} 张卡 · 完整视图 {list.full.length} 条源站条目（含已完成{" "}
              {completedCount}）
            </span>
          )}
        </p>
      )}
      {(live || demoSummaries !== null) && (
        <p className="ai-row">
          <button className="ai-button" disabled={summarizing} onClick={() => void summarize()} type="button">
            {summarizing ? "正在提炼…" : "AI 提炼"}
          </button>
          <span className="ai-note">
            AI 只看得到标题和标签，看不到正文和评论
            {list !== null && list.entries.length > SUMMARY_LIMIT ? `；一次最多 ${SUMMARY_LIMIT} 张卡` : ""}
          </span>
          {summaryNote !== null && <span className="ai-note ai-note--alert">{summaryNote}</span>}
        </p>
      )}
      {fullViewOpen && hasFullView ? (
        <ol className="full-list">
          {list.full.map((entry) => {
            const { task, reason, done, snapshotAt } = entry;
            const source = sourceLabel(task.providerId, connected);
            return (
              <li className={`full-item${done ? " full-item--done" : ""}`} key={`full-${task.id}`}>
                <a className="full-item-title" href={task.url}>
                  {task.title}
                </a>
                <span className="full-item-meta">
                  <span className="card-source">{source.label}</span>
                  <span className="card-reason">{done ? "已完成" : REASON_LABELS[reason]}</span>
                  <span>更新于 {formatTime(task.updatedAt, generatedAt)}</span>
                  {snapshotAt !== undefined && (
                    <span className="full-item-snapshot">
                      来自 {WALL_CLOCK.format(new Date(snapshotAt))} 快照
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      ) : list.entries.length === 0 ? (
        <p className={blockedEmpty ? "empty-state empty-state--blocked" : "empty-state"}>{emptyMessage}</p>
      ) : (
        <ol className="cards">
        {list.entries.map((entry, index) => {
          const { task, reason, learned, mergedFrom, snapshotAt } = entry;
          // 合并卡的来源槽一格一个来源，各自跳到各自的记录；没合并的卡片 DOM 不变。
          const sources = mergedFrom ?? [task];
          // 合并卡只解释表头这一条，其余来源以一句标注带出（#8 AC#5）——各写一条就是另一件事了。
          const otherSources =
            mergedFrom === undefined
              ? []
              : [...new Set(mergedFrom.slice(1).map((one) => sourceLabel(one.providerId, connected).label))];
          const whyState = why[task.id];
          const known = summaries[summaryKey(task)];
          const cached = known === undefined ? cachedSummary(task) : null;
          const summary = known ?? (cached === null ? undefined : { status: "ready" as const, text: cached });
          const samples = [
            ...new Set(
              sources
                .map((one) => sourceLabel(one.providerId, connected).sample)
                .filter((one) => one !== undefined),
            ),
          ];
          // 落点线画在目标的上沿还是下沿，取决于这张卡是往上拖还是往下拖。
          const dropClass =
            drag === null || drag.over !== index || drag.from === index
              ? ""
              : drag.from < index
                ? " card--dropAfter"
                : " card--dropBefore";
          return (
            <li
              className={`card card--${reason}${snapshotAt === undefined ? "" : " card--stale"}${drag?.from === index ? " card--dragging" : ""}${dropClass}`}
              key={task.id}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDrag({ from: index, over: index });
              }}
              onDragOver={(event) => {
                if (drag === null) return;
                // 不拦住浏览器的「不能放这里」，否则 drop 永远不触发。
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (drag.over !== index) setDrag({ ...drag, over: index });
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (drag !== null) move(drag.from, index);
                setDrag(null);
              }}
              onDragEnd={() => setDrag(null)}
            >
              {snapshotAt !== undefined && (
                <span className="card-snapshot">来自 {WALL_CLOCK.format(new Date(snapshotAt))} 快照</span>
              )}
              {/* 卡片本身是拖拽源：链接上的 draggable=false 让指针落在标题上时也从整张卡起手，
                  点击跳转不受影响（拖与点是两个手势）。 */}
              <a className="card-title" href={task.url} draggable={false}>
                {task.title}
              </a>
              {summary !== undefined && (
                <p className={`card-summary${summary.status === "loading" ? " card-summary--loading" : ""}`}>
                  {summary.status === "loading" ? "正在提炼…" : summary.text}
                </p>
              )}
              <p className="card-meta">
                {sources.map((one) => {
                  const source = sourceLabel(one.providerId, connected);
                  const label = source.label;
                  return mergedFrom === undefined ? (
                    <span className="card-source" key={one.id}>
                      {label}
                    </span>
                  ) : (
                    <a className="card-source" href={one.url} draggable={false} key={one.id}>
                      {label}
                    </a>
                  );
                })}
                {samples.map((sample) => (
                  <span className="card-sample" key={sample}>
                    {sample}
                  </span>
                ))}
                <span className="card-reason">{REASON_LABELS[reason]}</span>
                {/* 命中行只在被抬起来的那些卡上出现（AC#3）；手动区里的卡不带它，构建器已经把 `learned` 剥掉了。 */}
                {learned !== undefined && <span>因为你连续把 {learned.group} 排在前面</span>}
                <span>更新于 {formatTime(task.updatedAt, generatedAt)}</span>
                {/* 展开前只是一个弱化入口；展开后那句话整行落到下面，不挤压这一行的元数据。 */}
                {whyState === undefined ? (
                  <button
                    aria-label={`为什么是这几条：${task.title}`}
                    className="card-why"
                    onClick={() => void askWhy(entry)}
                    title="为什么是这几条"
                    type="button"
                  >
                    为什么
                  </button>
                ) : whyState.status === "loading" ? (
                  <span className="card-why-line">正在想…</span>
                ) : (
                  <span className="card-why-line">
                    {whyState.text}
                    {otherSources.length > 0 && (
                      <span className="card-why-note">（这张卡还来自 {otherSources.join("、")}）</span>
                    )}
                  </span>
                )}
              </p>
            </li>
          );
        })}
        </ol>
      )}
      {/*
        状态信息只有一个位置：右下角。来源名写在这里，卡片上只写自己那一家。
        角标列的是本轮接线的家，顺序取注册顺序而不是清单项次：按清单排的话，一家被收敛到零条时它连名字一起消失。
        样例标记也必须出现在这里：某一家本轮被收敛到零条时，卡片全没了，角标是唯一还无条件可见的元素，
        不带限定词就等于宣称这一家已经接通（`docs/PRD.md` 的真实程度表：必须各自标明，不得含糊）。
        连接入口只在「有后端地址、但这一屏还是样例」时出现：连上了就不再占位置（常态要安静），
        失效时说「重新连接」而不是把整屏换成错误信息。
      */}
      <p className="corner">
        {(connected === null
          ? sampleProviders
          : wiredProviders.filter((provider) => connected[provider.id as keyof Connected])
        )
          .map((provider) => {
            const source = sourceLabel(provider.id, connected);
            return source.sample ? `${source.label} 样例` : source.label;
          })
          .join(" · ")}
        {" · "}
        {demo && (
          <>
            演示账号
            {" · "}
          </>
        )}
        {!reconnect && problems.length > 0 && (
          <>
            {problems.map((problem) => (
              <span key={problem.providerId}>
                {problem.kind === "unavailable" ? (
                  <span className="corner-alert" title={problem.detail}>
                    {problemLabel(problem)}
                  </span>
                ) : (
                  <button
                    className="corner-link corner-link--alert"
                    onClick={() => openDialog("tiers")}
                    type="button"
                  >
                    {problemLabel(problem)} · {problem.kind === "scope" ? "重新授权" : "重新连接"}
                  </button>
                )}
                {" · "}
              </span>
            ))}
          </>
        )}
        {refreshNote !== null && (
          <>
            <span className="corner-alert">{refreshNote}</span>
            {" · "}
          </>
        )}
        {API_BASE !== "" && (!live || reconnect) && (
          <>
            <button className="corner-link" onClick={() => openDialog("consent")} type="button">
              {reconnect ? "连接已失效 · 重新连接" : demo ? "连接自己的账号" : "连接 GitHub / Gitee"}
            </button>
            {" · "}
          </>
        )}
        {!reconnect && (live || hasSession) && (
          <>
            <button className="corner-link" onClick={() => openDialog("revoke")} type="button">
              撤销授权
            </button>
            {" · "}
          </>
        )}
        {!reconnect && live && (
          <>
            <button className="corner-link" onClick={() => openDialog("tiers")} type="button">
              {tierNote === null ? "授权档位" : `授权档位 · ${tierNote}`}
            </button>
            {" · "}
          </>
        )}
        {hasLocal && (
          <>
            <button className="corner-link" onClick={() => openDialog("clear-local")} type="button">
              清除本地记录
            </button>
            {" · "}
          </>
        )}
        {(dataMode === "live" || dataMode === "demo") && (
          <>
            <button className="corner-link" disabled={refreshing} onClick={() => refreshRef.current()} type="button">
              {refreshing ? "刷新中…" : "刷新"}
            </button>
            {" · "}
          </>
        )}
        {WALL_CLOCK.format(generatedAt)}
      </p>
      {/* 只在第一次主动排序后出现，看过并关掉才落「已说过」的标记（AC#3）。 */}
      {notice !== null && (
        <Modal title="这份顺序归你了" onDismiss={dismissNotice}>
          <p className="notice-body">
            你把「{notice.title}」从第 {notice.from + 1} 位放到了第 {notice.to + 1} 位。从现在起，这一屏的次序就按你排的走：
            {""}
            刷新之后卡片还在原位，规则打分不再挪动它们，只负责把新出现的条目按紧急度接在后面。
          </p>
          <p className="notice-body">
            记下来的只有这些：每条的标识、它属于哪个来源，和你把它放在第几位。标题、正文、评论都不在里面。
            {""}
            最近七天里你把某个来源的任务往前三位放过两次，它的新任务就会在同一档里排得靠前一点——越不过逾期的那些。
          </p>
          <p className="notice-body">
            这些都存在这台浏览器的本地存储里——换浏览器或清空站点数据，顺序回到规则打分。撤销授权和 30
            天未访问的自动清除管的是服务端那份账，
            {""}
            不会清掉这里的顺序和记录；要清它们，用右下角的「清除本地记录」。
          </p>
          <button autoFocus className="notice-close" onClick={dismissNotice} type="button">
            知道了
          </button>
        </Modal>
      )}
      {/*
        连接前的自陈屏（#13 AC#1）：点「连接」先出这一层，显式同意才跳 OAuth。
        四栏对齐 PRD US#10：存什么 / 不存什么 / 谁可见 / 怎么清。
        不做常驻入口、不加说明行——它只在伸手连接的那一刻占住一屏。
      */}
      {dialog === "consent" && (
        <Modal title="连接之前" onDismiss={() => setDialog(null)}>
          <p className="notice-body">
            同意后跳到所选平台的授权页面：GitHub 或 Gitee。服务端会存：两边各自的登录名、加密后的 access token、GitHub 实际授予的 scope、Gitee 的 refresh token 与过期时刻，以及这条记录的创建与最近访问时间。
            GitHub 连上之后，右下角的「授权档位」可以再单独授权私有仓库——那是第二次授权，两个 token 分开存。
          </p>
          <p className="notice-body">
            两家的 token 都只用来读指派给你、还没关闭的 issue 的标题、状态、更新时间与截止时间。Gitee 的 access token
            一天过期，过期前后服务端会拿 refresh token 自动续期，不会让清单静默变空。正文、评论、diff、代码永不入库。
          </p>
          <p className="notice-body">
            点卡片上的「为什么」时，服务端只把这张卡的标题与排序元数据（档位、截止、更新时间、学习信号）发给 DeepSeek
            生成一句措辞；正文、评论、diff 不参与，日志只记结果、耗时与失败类型。
          </p>
          <p className="notice-body">
            谁看得见：只有你自己。面板没有共享入口；除了上一段说的 DeepSeek 措辞通道（只收标题与排序元数据），服务端不把这些数据交给其他第三方；日志不记 token、授权头与响应体。
          </p>
          <p className="notice-body">
            token 加密落盘：数据库文件泄露不导致凭据泄露。但这挡不住服务器被完全控制——进程运行时手里有密钥。
          </p>
          <p className="notice-body">
            怎么清：右下角的「撤销授权」会在服务端物理删除两家令牌和这条记录，删除后当场验证；连续
            30 天未访问也会自动清除。
          </p>
          <p className="notice-body">
            两处例外：① 你主动排序时会记下放置记录（哪条任务、哪个来源、放到第几位、什么时间），让之后的新条目排得聪明一点；②
            手动顺序和这些放置记录只存在这台浏览器的本地存储里，上面两条删除义务不覆盖它们，何时清理由浏览器决定。右下角的「清除本地记录」是它们唯一的删除入口。
          </p>
          <div className="notice-actions">
            <button className="notice-secondary" onClick={() => setDialog(null)} type="button">
              先不连接
            </button>
            <button
              className="notice-secondary"
              onClick={() => {
                window.location.href = `${API_BASE}/auth/gitee`;
              }}
              type="button"
            >
              同意并连接 Gitee
            </button>
            <button
              autoFocus
              className="notice-close"
              onClick={() => {
                window.location.href = `${API_BASE}/auth/github?tier=public`;
              }}
              type="button"
            >
              同意并连接 GitHub
            </button>
          </div>
        </Modal>
      )}
      {dialog === "revoke" && (
        <Modal title="撤销授权" onDismiss={() => { if (!dialogBusy) setDialog(null); }}>
          <p className="notice-body">
            会在服务端物理删除这条记录：加密的令牌（GitHub 各档各一枚；Gitee 的 access 与 refresh 各一枚）、两家的登录名与这条租户的全部数据，删除后当场验证。之后面板回到样例清单，随时可以重新连接。
          </p>
          <p className="notice-body">
            只关掉私有仓库、保留公开档：到 GitHub 的已授权应用页把这一档的 scope 调小，回来刷新即可——面板会如实标出差异。
          </p>
          <p className="notice-body">
            这台浏览器里的手动顺序与放置记录不受影响——要清它们，用「清除本地记录」。
          </p>
          {dialogError !== null && <p className="notice-error">{dialogError}</p>}
          <div className="notice-actions">
            <button className="notice-secondary" disabled={dialogBusy} onClick={() => setDialog(null)} type="button">
              取消
            </button>
            <button autoFocus className="notice-close" disabled={dialogBusy} onClick={revoke} type="button">
              {dialogBusy ? "撤销中…" : "撤销并删除"}
            </button>
          </div>
        </Modal>
      )}
      {dialog === "clear-local" && (
        <Modal title="清除本地记录" onDismiss={() => setDialog(null)}>
          <p className="notice-body">
            会删掉这台浏览器里的两份记录：手动顺序与放置记录。之后这一屏回到规则打分，学习加权消失。
            服务端保存的授权与数据不受影响。
          </p>
          <div className="notice-actions">
            <button className="notice-secondary" onClick={() => setDialog(null)} type="button">
              取消
            </button>
            <button autoFocus className="notice-close" onClick={clearLocal} type="button">
              清除
            </button>
          </div>
        </Modal>
      )}
      {/*
        授权档位（#14）：两档各是一次独立授权，令牌分开存；实际授予以 GitHub 返回为准。
        按 provider 自报的粒度铺开，平台差异全在 descriptor 里——这一层不认任何一家的名字。
      */}
      {dialog === "tiers" && (
        <Modal title="授权档位" onDismiss={() => { if (!dialogBusy) setDialog(null); }}>
          <p className="notice-body">
            每一档是一次独立的 GitHub 授权，令牌分开存。实际授予的 scope 以 GitHub 返回为准：在 GitHub
            侧把授权改小，这里会指出来，不会静默少显示。
          </p>
          {authProviders.map((provider) => {
            const descriptor = provider.scopeDescriptor(scope);
            const source = sourceLabel(provider.id, connected);
            // 弹层同样受真实程度表约束：样例平台的档位说明也要带上限定词。
            const providerLabel = source.sample === undefined ? source.label : `${source.label} 样例`;
            if (descriptor.auth.kind === "uniform") {
              // 没有档位的平台（Gitee）也在这里接：一次授权一枚令牌，续期失败时从这里重来。
              const wired = wiredProviders.some((one) => one.id === provider.id);
              // 连接态只对真实接线的 uniform 档成立；Jira / 飞书样例不跟着 Gitee 的会话说「已连接」。
              const uniformConnected = wired && connected?.gitee === true;
              return (
                <div className="tier-group" key={provider.id}>
                  <p className="tier-group-title">{providerLabel}</p>
                  <div className="tier-row">
                    <div className="tier-body">
                      <span className="tier-name">一次授权</span>
                      <span className="tier-scope">
                        {wired ? `${uniformConnected ? "已连接" : "未连接"} · ` : ""}
                        {descriptor.auth.note}
                      </span>
                      {wired && giteeProblem !== undefined && (
                        <span className="tier-warn">
                          {problemLabel(giteeProblem)}
                          {giteeProblem.kind === "unavailable"
                            ? `：${giteeProblem.detail ?? "上游没有给出原因。"}`
                            : "：access token 一天过期，自动续期没成功后需要重新授权。"}
                        </span>
                      )}
                    </div>
                    {API_BASE !== "" && wired && (
                      <button
                        className="notice-secondary"
                        disabled={dialogBusy}
                        onClick={() => void authorizeGitee()}
                        type="button"
                      >
                        {uniformConnected ? "重新授权" : "授权"}
                      </button>
                    )}
                  </div>
                </div>
              );
            }
            return (
              <div className="tier-group" key={provider.id}>
                <p className="tier-group-title">{providerLabel}</p>
                {descriptor.auth.tiers.map(({ tier, label }) => {
                  const grant = auth?.grants[tier];
                  const dropped = auth?.dropped.includes(tier) ?? false;
                  return (
                    <div className="tier-row" key={tier}>
                      <div className="tier-body">
                        <span className="tier-name">{label}</span>
                        <span className="tier-scope">{grant === undefined ? "未授权" : grantLine(grant)}</span>
                        {dropped && (
                          <span className="tier-warn">
                            这一档刚被 GitHub 拒绝（401），已从服务端删除；重新授权即可。
                          </span>
                        )}
                        {!dropped && grant !== undefined && grant.missing.length > 0 && (
                          <span className="tier-warn">
                            GitHub 实际授予比这一档应有的少：缺 {grant.missing.join("、")}。到 GitHub
                            授权页调整后点「重新授权」。
                          </span>
                        )}
                      </div>
                      <button
                        className="notice-secondary"
                        disabled={dialogBusy}
                        onClick={() => authorizeTier(tier)}
                        type="button"
                      >
                        {grant === undefined ? "授权" : "重新授权"}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
          <p className="notice-body">
            这一屏的顺序和放置记录存在浏览器里，与授权无关；撤销授权不会清它们。
          </p>
          {dialogError !== null && <p className="notice-error">{dialogError}</p>}
          <div className="notice-actions">
            <button className="notice-secondary" disabled={dialogBusy} onClick={() => setDialog(null)} type="button">
              关闭
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

/** 纯规则那句：没有 AI 时的唯一措辞来源，也是 AI 失败与超时时的回落。 */
function ruleWording(entry: ListEntry): string {
  const base = RULE_WORDINGS[entry.reason];
  if (entry.learned === undefined) return base;
  return `${base}你最近连续把 ${entry.learned.group} 排在前面，同档内它因此被提前。`;
}

/** 上行给措辞通道的那张卡：白名单字段，正文、评论与 diff 不在其中（#8 AC#2）。 */
function reasonCardOf(entry: ListEntry): ReasonCard {
  return {
    title: entry.task.title,
    reason: entry.reason,
    ...(entry.learned === undefined ? {} : { learned: entry.learned }),
    ...(entry.task.dueAt === undefined ? {} : { dueAt: entry.task.dueAt }),
    ...(entry.task.duePrecision === undefined ? {} : { duePrecision: entry.task.duePrecision }),
    updatedAt: entry.task.updatedAt,
  };
}

/** 弹层里一行「实际授予」：`null` 是响应头缺失（不知道），空数组是「有头但没列 scope」，两种都是真值，不吞掉。 */
function grantLine(grant: TierGrant): string {
  if (grant.scopes === null) return "已授权 · GitHub 未报告 scope";
  return grant.scopes.length === 0 ? "已授权 · 未授予任何 scope" : `已授权 · ${grant.scopes.join(" ")}`;
}

/** 四个弹层共用的一层壳：遮罩点掉即退，点内容不冒泡；标题与关闭都只有一份写法。 */
function Modal({ title, onDismiss, children }: { title: string; onDismiss: () => void; children: ReactNode }) {
  return (
    <div className="notice-mask" onClick={onDismiss}>
      <div
        className="notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="notice-title" id="dialog-title">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

function formatTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(then);
}
