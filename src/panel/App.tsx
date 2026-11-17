import { useEffect, useState } from "react";
import type { Provider, Scope } from "../core/provider";
import { buildTodayList, type RuleId, type TodayList } from "../core/today-list";
import { createSampleProviders, demoSameEvent, sampleHttp } from "../fakes/samples";

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

export function App() {
  const [list, setList] = useState<TodayList | null>(null);

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
    }).then((next) => {
      if (alive) setList(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!list) {
    return <main className="panel" />;
  }

  // 界面上只有这一个时间基准：构建器盖上的一致时间，不再伸手取第二个时钟。
  const generatedAt = new Date(list.generatedAt);

  return (
    <main className="panel">
      <h1 className="panel-title">今日清单</h1>
      <ol className="cards">
        {list.entries.map(({ task, reason, mergedFrom }) => {
          // 合并卡的来源槽一格一个来源，各自跳到各自的记录；没合并的卡片 DOM 不变。
          const sources = mergedFrom ?? [task];
          const samples = [
            ...new Set(sources.map((one) => SOURCE_LABELS[one.providerId]?.sample).filter((one) => one !== undefined)),
          ];
          return (
            <li className={`card card--${reason}`} key={task.id}>
              <a className="card-title" href={task.url}>
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
                    <a className="card-source" href={one.url} key={one.id}>
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
