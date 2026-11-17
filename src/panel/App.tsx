import { useEffect, useState } from "react";
import type { Provider, Scope } from "../core/provider";
import { buildTodayList, type RuleId, type TodayList } from "../core/today-list";
import { createSampleProviders, demoSameEvent, sampleHttp } from "../fakes/samples";
import { hasSeenOrderNotice, loadManualOrder, markOrderNoticeSeen, saveManualOrder } from "./manual-order";

const scope: Scope = { assignee: "me" };
const providers: Provider[] = createSampleProviders();
const WALL_CLOCK = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" });

/**
 * 来源在界面上的真实程度（`docs/PRD.md` 的真实程度表）。四条现在都是字面量数据，
 * 所以都标样例数据；T09 / T15 真连后各自摘掉这个标记。
 */
const SOURCE_LABELS: Record<string, { label: string; sample?: string }> = {
  github: { label: "GitHub", sample: "样例数据" },
  gitee: { label: "Gitee", sample: "样例数据" },
  jira: { label: "Jira", sample: "样例数据" },
  feishu: { label: "飞书", sample: "样例数据 · 真实接入需企业自建应用" },
};

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

export function App() {
  const [list, setList] = useState<TodayList | null>(null);
  const [notice, setNotice] = useState<OrderNotice | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);

  useEffect(() => {
    let alive = true;
    // 「今日」按访客日历里的今天判：偏移由界面这一侧喂进来，构建器自己不读宿主时区（ADR-0005）。
    const zoneOffsetMinutes = -new Date().getTimezoneOffset();
    buildTodayList({
      providers,
      http: sampleHttp,
      now: () => new Date(),
      scope,
      zoneOffsetMinutes,
      // 演示用判定表：真实判据在 #18，接进来的是同一个注入点，不是另一套逻辑。
      sameEvent: demoSameEvent,
      // 上一轮排的顺序在这里回到构建器：存储归界面管，构建器只认注入（ADR-0007）。
      manualOrder: loadManualOrder(),
    }).then((next) => {
      if (alive) setList(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * 把第 `from` 张卡挪到第 `to` 张的位置：落点用目标原来的序号，向上向下两侧读起来都直观。
   * 写进去的是**整份**可见顺序，所以这一次拖拽之后所有已有卡片都归访客，规则只对新条目说话（ADR-0007）。
   */
  function move(from: number, to: number): void {
    if (list === null || from === to) return;
    const moved = list.entries[from];
    if (moved === undefined) return;
    const rest = list.entries.filter((_, index) => index !== from);
    rest.splice(to, 0, moved);
    setList({ ...list, entries: rest });
    saveManualOrder(rest.map((entry) => entry.task.id));
    // 标记要等这句话真被看过才落盘：没关就刷新，下一次拖拽还会说一遍。
    if (!hasSeenOrderNotice()) setNotice({ title: moved.task.title, from, to });
  }

  function dismissNotice(): void {
    markOrderNoticeSeen();
    setNotice(null);
  }

  if (!list) {
    return <main className="panel" />;
  }

  // 界面上只有这一个时间基准：构建器盖上的一致时间，不再伸手取第二个时钟。
  const generatedAt = new Date(list.generatedAt);

  return (
    <main className="panel">
      <h1 className="panel-title">今日清单</h1>
      <ol className="cards">
        {list.entries.map(({ task, reason, mergedFrom }, index) => {
          // 合并卡的来源槽一格一个来源，各自跳到各自的记录；没合并的卡片 DOM 不变。
          const sources = mergedFrom ?? [task];
          const samples = [
            ...new Set(sources.map((one) => SOURCE_LABELS[one.providerId]?.sample).filter((one) => one !== undefined)),
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
                  const source = SOURCE_LABELS[one.providerId];
                  const label = source?.label ?? one.providerId;
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
      */}
      <p className="corner">
        {providers
          .map((provider) => {
            const source = SOURCE_LABELS[provider.id];
            const name = source?.label ?? provider.id;
            return source?.sample ? `${name} 样例` : name;
          })
          .join(" · ")}{" "}
        · {WALL_CLOCK.format(generatedAt)}
      </p>
      {/* 只在第一次主动排序后出现，看过并关掉才落「已说过」的标记（AC#3）。 */}
      {notice !== null && (
        <div className="notice-mask" onClick={dismissNotice}>
          <div className="notice" role="dialog" aria-modal="true" aria-labelledby="notice-title">
            <h2 className="notice-title" id="notice-title">
              这份顺序归你了
            </h2>
            <p className="notice-body">
              你把「{notice.title}」从第 {notice.from + 1} 位放到了第 {notice.to + 1} 位。从现在起，这一屏的次序就按你排的走：
              {""}
              刷新之后卡片还在原位，规则打分不再挪动它们，只负责把新出现的条目按紧急度接在后面。
            </p>
            <p className="notice-body">
              记下来的只有这些：每条的标识，和你把它放在第几位。标题、正文、评论都不在里面。它现在还只记顺序，
              {""}
              不会猜你想先做哪一类任务。
            </p>
            <p className="notice-body">这份顺序存在这台浏览器的本地存储里——换浏览器或清空站点数据，顺序回到规则打分。</p>
            <button autoFocus className="notice-close" onClick={dismissNotice} type="button">
              知道了
            </button>
          </div>
        </div>
      )}
    </main>
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
