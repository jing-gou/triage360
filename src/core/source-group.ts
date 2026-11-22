import type { Task } from "./provider";

/**
 * 一条任务属于哪个**来源分组**——学习加权认的就是这个粒度（`DECISIONS.md` §0.5「按 repo / 某类 label 排到前面」）。
 *
 * repo 不在任务的九个键里，而平台专有信息不许夹带在九键之外（AGENTS.md），
 * 所以这个键只能从 `url` 派生：代码托管站的 issue 路径前两段就是 `owner/repo`，其余的站退到 host。
 *
 * 只认 `github.com` / `gitee.com` 这两个域名是有意粗糙的：v1 接的四家在 ADR-0001 里钉死了，
 * 私有化部署的 GitHub Enterprise 会落进 host 那一支，于是加权按整站算。那是口径，不是缺陷。
 */
export function sourceGroupOf(task: Task): string {
  let url: URL;
  try {
    url = new URL(task.url);
  } catch {
    // 访客手改过存储，或源站哪天给的不是绝对地址：退到 providerId，分组这件事至少还有个键。
    return task.providerId;
  }
  if (url.hostname === "github.com" || url.hostname === "gitee.com") {
    const [owner, repo] = url.pathname.split("/").filter((part) => part !== "");
    if (owner !== undefined && repo !== undefined) return `${owner}/${repo}`;
  }
  return url.hostname;
}
