import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";
import { createGiteeLikeProvider } from "../src/fakes/giteeLikeProvider";
import { createJiraLikeProvider } from "../src/fakes/jiraLikeProvider";

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
  it("条目的标签名从源站原件带出来，作为任务第九键", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: fakeHttp({ github: { view: [github(7101, "修复登录回调", ["bug", "ui"])] } }),
      now: clock,
      scope,
    });

    expect(list.entries[0]?.task.labels).toEqual(["bug", "ui"]);
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
    expect(list.entries[0]?.task.labels).toEqual(["bug", "backend"]);
  });
});

describe("seam 1 · 各家的标签形状在 provider 里消化", () => {
  it("Jira 的 fields.labels 也能带出来，与 GitHub/Gitee 的 [{ name }] 同一个输出", async () => {
    const list = await buildTodayList({
      providers: [createJiraLikeProvider()],
      http: fakeHttp({
        jira: {
          view: [
            {
              id: "10041",
              key: "TRI-41",
              fields: {
                summary: "排查 Gitee 403",
                status: { name: "In Progress" },
                updated: "2026-11-16T14:00:00.000+0800",
                labels: ["backend", "bug"],
              },
            },
          ],
        },
      }),
      now: clock,
      scope,
    });

    expect(list.entries[0]?.task.labels).toEqual(["backend", "bug"]);
  });
});
