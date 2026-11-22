import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";
import { createGiteeLikeProvider } from "../src/fakes/giteeLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function github(number: number, title: string, labels: string[]) {
  return {
    number,
    title,
    state: "open",
    updated_at: "2026-11-16T10:00:00Z",
    html_url: `https://github.com/jing-gou/triage360/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function gitee(repo: string, number: number, title: string, labels: string[]) {
  return {
    number,
    title,
    state: "open",
    updated_at: "2026-11-16T09:00:00Z",
    html_url: `https://gitee.com/${repo}/issues/${number}`,
    repository: { full_name: repo },
    labels: labels.map((name) => ({ name })),
  };
}

describe("seam 1 · 摘要通道要的标签（#20）", () => {
  it("条目的标签名从源站原件带出来，不塞进任务八键", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: fakeHttp({ github: { view: [github(7101, "修复登录回调", ["bug", "ui"])] } }),
      now: clock,
      scope,
    });

    expect(list.entries[0]?.labels).toEqual(["bug", "ui"]);
    expect(Object.keys(list.entries[0]?.task ?? {})).not.toContain("labels");
  });

  it("合并卡的标签是各来源的并集，重复的只留一次", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider(), createGiteeLikeProvider()],
      http: fakeHttp({
        github: { view: [github(7102, "登录页 500", ["bug"])] },
        gitee: { view: [gitee("jing-gou/triage360", 7102, "Login 接口偶发 500", ["bug", "backend"])] },
      }),
      now: clock,
      scope,
      sameEvent: (a, b) => a.title.includes("500") && b.title.includes("500"),
    });

    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]?.labels).toEqual(["bug", "backend"]);
  });
});
