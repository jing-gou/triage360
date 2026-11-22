import { describe, expect, it } from "vitest";
import type { Http } from "../src/core/provider";
import { buildTodayList } from "../src/core/today-list";
import { demoSameEvent } from "../src/fakes/samples";
import { createGiteeProvider } from "../src/providers/gitee";
import { createGithubProvider } from "../src/providers/github";

const githubRaw = {
  number: 54,
  title: "登录后偶发白屏，需要刷新一次才恢复",
  state: "open",
  updated_at: "2026-11-22T10:00:00Z",
  html_url: "https://github.com/jing-gou/triage360/issues/54",
  repository_url: "https://api.github.com/repos/jing-gou/triage360",
};

const giteeRaw = {
  number: "IKX5K3",
  title: "登录后偶尔白屏，刷新页面后恢复",
  state: "open",
  updated_at: "2026-11-22T10:05:00Z",
  html_url: "https://gitee.com/sugarpub/triage360-demo/issues/IKX5K3",
  repository: { full_name: "sugarpub/triage360-demo" },
};

const http: Http = async () => {
  throw new Error("清单已经在快照里，构建器不该再发请求");
};

describe("seam 1 · 演示源站的同一件事", () => {
  it("GitHub #54 与 Gitee IKX5K3 按真实 id 合成一张卡", async () => {
    const [github, gitee] = [createGithubProvider(), createGiteeProvider()];
    const list = await buildTodayList({
      providers: [
        { ...github, search: async () => [githubRaw] },
        { ...gitee, search: async () => [giteeRaw] },
      ],
      http,
      now: () => new Date("2026-11-22T09:00:00Z"),
      scope: { assignee: "TinoJg" },
      sameEvent: demoSameEvent,
    });

    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.mergedFrom?.map((task) => task.id).sort()).toEqual([
      "gitee:sugarpub/triage360-demo#IKX5K3",
      "github:jing-gou/triage360#54",
    ]);
  });
});