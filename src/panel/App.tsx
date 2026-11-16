import { useEffect, useState } from "react";
import { remoteIdOf, type Provider, type Scope } from "../core/provider";
import { buildTodayList, type TodayList } from "../core/today-list";
import { createGithubLikeProvider, fixtureHttp } from "../fakes/githubLikeProvider";

const scope: Scope = { assignee: "me" };
const providers: Provider[] = [createGithubLikeProvider()];

export function App() {
  const [list, setList] = useState<TodayList | null>(null);

  useEffect(() => {
    let alive = true;
    buildTodayList({ providers, http: fixtureHttp, now: () => new Date(), scope }).then((next) => {
      if (alive) setList(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!list) {
    return <main className="panel" />;
  }

  return (
    <main className="panel">
      <header className="panel-head">
        <h1>今日清单</h1>
        <p className="panel-meta">
          {providers.map((provider) => provider.scopeDescriptor(scope)).join("　")} · 生成于{" "}
          {formatTime(list.generatedAt, new Date())}
        </p>
      </header>
      <ol className="cards">
        {list.tasks.map((task) => (
          <li className="card" key={task.id}>
            <a className="card-title" href={task.url}>
              {task.title}
            </a>
            <p className="card-meta">
              {task.providerId} #{remoteIdOf(task.id)} · 更新于{" "}
              {formatTime(task.updatedAt, new Date(list.generatedAt))}
            </p>
          </li>
        ))}
      </ol>
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
