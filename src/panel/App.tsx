import { useEffect, useState } from "react";
import type { Provider, Scope } from "../core/provider";
import { buildTodayList, type TodayList } from "../core/today-list";
import { createSampleProviders, sampleHttp } from "../fakes/samples";

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

export function App() {
  const [list, setList] = useState<TodayList | null>(null);

  useEffect(() => {
    let alive = true;
    buildTodayList({ providers, http: sampleHttp, now: () => new Date(), scope }).then((next) => {
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
        {list.tasks.map((task) => {
          const source = SOURCE_LABELS[task.providerId];
          return (
            <li className="card" key={task.id}>
              <a className="card-title" href={task.url}>
                {task.title}
              </a>
              <p className="card-meta">
                <span className="card-source">{source?.label ?? task.providerId}</span>
                {source?.sample && <span className="card-sample">{source.sample}</span>}
                <span>更新于 {formatTime(task.updatedAt, generatedAt)}</span>
              </p>
            </li>
          );
        })}
      </ol>
      {/* 状态信息只有一个位置：右下角。来源名写在这里，卡片上只写自己那一家。 */}
      <p className="corner">
        {providers.map((provider) => SOURCE_LABELS[provider.id]?.label ?? provider.id).join(" · ")} ·{" "}
        {WALL_CLOCK.format(generatedAt)}
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
