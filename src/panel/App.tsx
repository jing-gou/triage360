import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Provider, Scope, Tier } from "../core/provider";
import { sourceGroupOf } from "../core/source-group";
import { buildTodayList, type ListEntry, type RuleId, type TodayList } from "../core/today-list";
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
  revokeSession,
  UnauthenticatedError,
  type GithubAuth,
  type TierGrant,
} from "./api";
import { createSnapshotHttp } from "./snapshot-http";
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

/** 这一轮服务端手里还握着哪几家的授权；`null` = 这一屏没走真实链路。 */
type Connected = { github: boolean; gitee: boolean };

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

/** 这一家真的连上了才不标样例；其余几家原样保留限定词。 */
function sourceLabel(providerId: string, connected: Connected | null): { label: string; sample?: string } {
  const base = SOURCE_LABELS[providerId] ?? { label: providerId };
  return connected !== null && connected[providerId as keyof Connected] === true ? { label: base.label } : base;
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
  const [notice, setNotice] = useState<OrderNotice | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  /** 这一屏走的是真实链路：记录服务端还握着哪几家的授权；`null` = 样例屏。 */
  const [connected, setConnected] = useState<Connected | null>(null);
  /** 这一屏是公开演示快照：数据来自演示账号的真实取数，但没有访客自己的授权。 */
  const [demo, setDemo] = useState(false);
  const live = connected !== null && !demo;
  const [reconnect, setReconnect] = useState(false);
  /** Gitee 这一轮没取到数据时的一句标注；连上且取到就是 `null`（常态安静）。 */
  const [giteeNote, setGiteeNote] = useState<string | null>(null);
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
  // 拖拽会把在途请求的答案作废：请求发出时记下代数，回来时代数变了就丢掉，不把旧句写回手动区。
  const whyEpoch = useRef(0);

  useEffect(() => {
    let alive = true;
    // 「今日」按访客日历里的今天判：偏移由界面这一侧喂进来，构建器自己不读宿主时区（ADR-0005）。
    const zoneOffsetMinutes = -new Date().getTimezoneOffset();
    // 上一轮排的顺序与往期放置都回到构建器：存储归界面管，构建器只认注入（ADR-0007、ADR-0009）。
    const local = { manualOrder: loadManualOrder(), placements: loadLearningRecords() };
    // 本地那两份记录是否存在，决定右下角出不出现「清除本地记录」——它是它们唯一的删除入口。
    setHasLocal(hasLocalRecords());

    async function load() {
      // 没有构建期后端地址就没有真实链路：面板保持样例，右下角也不出现「连接」。
      const session = API_BASE === "" ? null : adoptSessionFromUrl();
      if (session !== null) {
        setHasSession(true);
        try {
          const payload = await fetchItems(API_BASE, session);
          // 只构建这一轮还连着的家：Gitee 没连就不拿样例顶替（那会和「已连上」混在一起），
          // 取数失败的那一家由角标单独说明，不拖白另一家。
          const providers: Provider[] = [];
          if (payload.connected.github) providers.push(createGithubProvider());
          if (payload.connected.gitee) providers.push(createGiteeProvider());
          const next = await buildTodayList({
            providers,
            // 条目已经从服务端取回，这一次取数不再出发请求；归一与排序仍在本机走 seam 1。
            http: createSnapshotHttp(payload.items, payload.gitee.items),
            now: () => new Date(),
            scope: { assignee: payload.login },
            zoneOffsetMinutes,
            // 演示用判定表：真实判据留给语义匹配（tracker 里还没有这张票），接进来的是同一个注入点，不是另一套逻辑。
            sameEvent: demoSameEvent,
            ...local,
          });
          if (!alive) return;
          setList(next);
          setAuth(payload.auth);
          setConnected(payload.connected);
          setDemo(false);
          setGiteeNote(
            payload.gitee.status === "reauth"
              ? "Gitee 授权已失效"
              : payload.gitee.status === "unavailable"
                ? "Gitee 暂不可达"
                : null,
          );
          setReconnect(false);
          return;
        } catch (error) {
          // 会话失效或后端不可达都退回样例清单：这一屏不说谎，角标里不写「已连上」。
          if (error instanceof UnauthenticatedError) {
            forgetSession();
            if (alive) setHasSession(false);
          }
          if (alive) {
            setAuth(null);
            setConnected(null);
            setGiteeNote(null);
            setReconnect(true);
          }
        }
      }
      // 没有会话（或会话已失效）：先看公开演示快照——首次访客落地即真实数据（#15）。
      if (API_BASE !== "") {
        try {
          const snapshot = await fetchDemoItems(API_BASE);
          const providers: Provider[] = [];
          if (snapshot.connected.github) providers.push(createGithubProvider());
          if (snapshot.connected.gitee) providers.push(createGiteeProvider());
          const next = await buildTodayList({
            providers,
            http: createSnapshotHttp(snapshot.items, snapshot.gitee),
            // 排序基准取快照时刻：访客看到的是那一轮取数的切片，不是「刚刚」。
            now: () => new Date(snapshot.generatedAt),
            scope,
            zoneOffsetMinutes,
            sameEvent: demoSameEvent,
            ...local,
          });
          if (!alive) return;
          setList(next);
          setConnected(snapshot.connected);
          setDemo(true);
          setAuth(null);
          setGiteeNote(null);
          return;
        } catch {
          // 演示快照也不可用就退回样例；这一屏仍不空白。
        }
      }
      const next = await buildTodayList({
        providers: sampleProviders,
        http: sampleHttp,
        now: () => new Date(),
        scope,
        zoneOffsetMinutes,
        // 演示用判定表：真实判据留给语义匹配（tracker 里还没有这张票），接进来的是同一个注入点，不是另一套逻辑。
        sameEvent: demoSameEvent,
        ...local,
      });
      if (!alive) return;
      setList(next);
      setConnected(null);
      setDemo(false);
      setGiteeNote(null);
    }

    load();
    return () => {
      alive = false;
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
  // 两家的问题都收进同一个入口：常态安静，出问题时角标说得出是哪一家。
  const tierNote = [authNote, giteeNote].filter((one): one is string => one !== null).join(" · ") || null;

  return (
    <main className="panel">
      <h1 className="panel-title">今日清单</h1>
      <ol className="cards">
        {list.entries.map((entry, index) => {
          const { task, reason, learned, mergedFrom } = entry;
          // 合并卡的来源槽一格一个来源，各自跳到各自的记录；没合并的卡片 DOM 不变。
          const sources = mergedFrom ?? [task];
          // 合并卡只解释表头这一条，其余来源以一句标注带出（#8 AC#5）——各写一条就是另一件事了。
          const otherSources =
            mergedFrom === undefined
              ? []
              : [...new Set(mergedFrom.slice(1).map((one) => sourceLabel(one.providerId, connected).label))];
          const whyState = why[task.id];
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
              className={`card card--${reason}${drag?.from === index ? " card--dragging" : ""}${dropClass}`}
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
              {/* 卡片本身是拖拽源：链接上的 draggable=false 让指针落在标题上时也从整张卡起手，
                  点击跳转不受影响（拖与点是两个手势）。 */}
              <a className="card-title" href={task.url} draggable={false}>
                {task.title}
              </a>
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
              const giteeConnected = connected?.gitee === true;
              return (
                <div className="tier-group" key={provider.id}>
                  <p className="tier-group-title">{providerLabel}</p>
                  <div className="tier-row">
                    <div className="tier-body">
                      <span className="tier-name">一次授权</span>
                      <span className="tier-scope">
                        {giteeConnected ? "已连接" : "未连接"} · {descriptor.auth.note}
                      </span>
                      {provider.id === "gitee" && giteeNote !== null && (
                        <span className="tier-warn">
                          {giteeNote}：access token 一天过期，自动续期没成功后需要重新授权。
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
                        {giteeConnected ? "重新授权" : "授权"}
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
