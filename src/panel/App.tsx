import { useEffect, useState, type ReactNode } from "react";
import type { Provider, Scope, Tier } from "../core/provider";
import { sourceGroupOf } from "../core/source-group";
import { buildTodayList, type RuleId, type TodayList } from "../core/today-list";
import { createSampleProviders, demoSameEvent, sampleHttp } from "../fakes/samples";
import { createGithubProvider } from "../providers/github";
import {
  API_BASE,
  adoptSessionFromUrl,
  fetchGithubItems,
  forgetSession,
  requestAuthUrl,
  revokeSession,
  UnauthenticatedError,
  type GithubAuth,
  type TierGrant,
} from "./api";
import { appendLearningRecord, loadLearningRecords } from "./learning-records";
import { clearLocalRecords, hasLocalRecords } from "./local-records";
import { hasSeenOrderNotice, loadManualOrder, markOrderNoticeSeen, saveManualOrder } from "./manual-order";

const scope: Scope = { assignee: "me" };
const sampleProviders: Provider[] = createSampleProviders();
/** 真接入的平台；样例里 id 相同的让位，弹层里同一平台只出现一次。 */
const wiredProviders: Provider[] = [createGithubProvider()];
/** 授权档位弹层的平台清单：真接入的在前，其余用样例 provider 的粒度说明。 */
const authProviders: Provider[] = [
  ...wiredProviders,
  ...sampleProviders.filter((one) => !wiredProviders.some((wired) => wired.id === one.id)),
];
const WALL_CLOCK = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

/**
 * 来源在界面上的真实程度（`docs/PRD.md` 的真实程度表）。默认四家都是字面量数据，
 * 所以都标样例数据；接上 GitHub 会话之后这一家不再带样例标记（T09），其余三家等 T15 / T17 / T19。
 */
const SOURCE_LABELS: Record<string, { label: string; sample?: string }> = {
  github: { label: "GitHub", sample: "样例数据" },
  gitee: { label: "Gitee", sample: "样例数据" },
  jira: { label: "Jira", sample: "样例数据" },
  feishu: { label: "飞书", sample: "样例数据 · 真实接入需企业自建应用" },
};

/** 接上真实会话时真接入的平台不再标样例；其余几家原样保留。 */
function sourceLabel(providerId: string, live: boolean): { label: string; sample?: string } {
  const base = SOURCE_LABELS[providerId] ?? { label: providerId };
  return live && wiredProviders.some((one) => one.id === providerId) ? { label: base.label } : base;
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
  const [live, setLive] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  /** 浏览器手里还握着一枚会话标识：即便这一屏没连上，撤销入口也得在——否则旧租户没人能清。 */
  const [hasSession, setHasSession] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [hasLocal, setHasLocal] = useState(false);
  /** 服务端报回来的各档实际授权；只有连上真实会话之后才有。 */
  const [auth, setAuth] = useState<GithubAuth | null>(null);

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
          const payload = await fetchGithubItems(API_BASE, session);
          const next = await buildTodayList({
            providers: wiredProviders,
            // 条目已经从服务端取回，这一次取数不再出发请求；归一与排序仍在本机走 seam 1。
            http: async () => ({ status: 200, headers: {}, body: { items: payload.items } }),
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
          setLive(true);
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
            setReconnect(true);
          }
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
      setLive(false);
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
      window.location.href = await requestAuthUrl(API_BASE, session, tier);
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

  return (
    <main className="panel">
      <h1 className="panel-title">今日清单</h1>
      <ol className="cards">
        {list.entries.map(({ task, reason, learned, mergedFrom }, index) => {
          // 合并卡的来源槽一格一个来源，各自跳到各自的记录；没合并的卡片 DOM 不变。
          const sources = mergedFrom ?? [task];
          const samples = [
            ...new Set(
              sources
                .map((one) => sourceLabel(one.providerId, live).sample)
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
                  const source = sourceLabel(one.providerId, live);
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
        {(live ? wiredProviders : sampleProviders)
          .map((provider) => {
            const source = sourceLabel(provider.id, live);
            return source.sample ? `${source.label} 样例` : source.label;
          })
          .join(" · ")}
        {" · "}
        {API_BASE !== "" && !live && (
          <>
            <button className="corner-link" onClick={() => openDialog("consent")} type="button">
              {reconnect ? "连接已失效 · 重新连接 GitHub" : "连接 GitHub"}
            </button>
            {" · "}
          </>
        )}
        {(live || hasSession) && (
          <>
            <button className="corner-link" onClick={() => openDialog("revoke")} type="button">
              撤销授权
            </button>
            {" · "}
          </>
        )}
        {live && (
          <>
            <button className="corner-link" onClick={() => openDialog("tiers")} type="button">
              {authNote === null ? "授权档位" : `授权档位 · ${authNote}`}
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
        <Modal title="连接 GitHub 之前" onDismiss={() => setDialog(null)}>
          <p className="notice-body">
            同意后跳到 GitHub 的授权页面。服务端会存：你的 GitHub 登录名、加密后的各档 access token、这次授权是哪一档、GitHub 实际授予的 scope、以及这条记录的创建与最近访问时间。
            连上之后，右下角的「授权档位」可以再单独授权私有仓库——那是第二次授权，两个 token 分开存。
          </p>
          <p className="notice-body">
            token 只用来读指派给你、还没关闭的 issue 的标题、状态、更新时间与截止时间。正文、评论、diff、代码永不入库。
          </p>
          <p className="notice-body">
            谁看得见：只有你自己。面板没有共享入口，服务端不把这些数据交给任何第三方；日志不记 token、授权头与响应体。
          </p>
          <p className="notice-body">
            token 加密落盘：数据库文件泄露不导致凭据泄露。但这挡不住服务器被完全控制——进程运行时手里有密钥。
          </p>
          <p className="notice-body">
            怎么清：右下角的「撤销授权」会在服务端物理删除两档令牌和这条记录，删除后当场验证；连续
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
            会在服务端物理删除这条记录：加密的令牌（两档各一枚）、GitHub 登录名与这条租户的全部数据，删除后当场验证。之后面板回到样例清单，随时可以重新连接。
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
            const source = sourceLabel(provider.id, live);
            // 弹层同样受真实程度表约束：样例平台的档位说明也要带上限定词。
            const providerLabel = source.sample === undefined ? source.label : `${source.label} 样例`;
            if (descriptor.auth.kind === "uniform") {
              return (
                <p className="notice-body" key={provider.id}>
                  <span className="tier-name">{providerLabel}</span> · {descriptor.auth.note}
                </p>
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
