import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { createGithubLikeProvider, fixtureHttp } from "../src/fakes/githubLikeProvider";
import { createJiraLikeProvider } from "../src/fakes/jiraLikeProvider";
import { fakeHttp } from "../src/fakes/fakeHttp";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function deps() {
  return { providers: [createGithubLikeProvider()], http: fixtureHttp, now: clock, scope };
}

/** 两家源站的原始形状字面量。构造器只省重复，不做任何判断。 */
function issue(number: number, title: string, state: string, updated_at: string) {
  return { number, title, state, updated_at, html_url: `https://github.com/jing-gou/triage360/issues/${number}` };
}

function ticket(id: string, key: string, summary: string, status: string, updated: string) {
  return { id, key, fields: { summary, status: { name: status }, updated } };
}

describe("seam 1 · 今日清单构建器", () => {
  it("给出 3 条任务，顺序由构建器决定而非 provider 返回的数组顺序", async () => {
    const list = await buildTodayList(deps());

    expect(list.tasks.map((task) => task.title)).toEqual([
      "修复登录回调",
      "写本周周报",
      "整理提交材料",
    ]);
  });

  it("盖上注入时钟给出的生成时间", async () => {
    const list = await buildTodayList(deps());

    expect(list.generatedAt).toBe("2026-11-17T01:00:00.000Z");
  });
});

describe("seam 1 · normalize 定稿：两家形状不同的源站归一化成同一结构", () => {
  // GitHub 的 updated_at 是 UTC 的 Z 结尾；Jira 的 fields.updated 带 +0800 偏移，
  // 且摘要、状态、链接分别藏在 fields.summary / fields.status.name / key。
  // 期望值里的顺序只有把两家时间都换算成同一 UTC 基准才成立：
  // 直接按原始字符串比大小会把 Jira 那条（09:00+0800）排在 GitHub 那条（08:20Z）之前。
  const http = fakeHttp({
    github: {
      view: [
        {
          number: 2001,
          title: "修复登录回调",
          html_url: "https://github.com/jing-gou/triage360/issues/2001",
          state: "open",
          updated_at: "2026-11-16T08:20:00Z",
        },
      ],
    },
    jira: {
      view: [
        {
          id: "10007",
          key: "TRI-7",
          self: "https://sample-jira.atlassian.net/rest/api/3/issue/10007",
          fields: {
            summary: "整理提交材料",
            status: { name: "In Progress" },
            updated: "2026-11-16T09:00:00.000+0800",
          },
        },
      ],
    },
  });

  it("同一结构：字段集合、id 命名空间与 UTC 时间基准两家一致", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider(), createJiraLikeProvider()],
      http,
      now: clock,
      scope,
    });

    expect(list.tasks).toEqual([
      {
        id: "github-fake:2001",
        providerId: "github-fake",
        title: "修复登录回调",
        url: "https://github.com/jing-gou/triage360/issues/2001",
        state: "open",
        updatedAt: "2026-11-16T08:20:00.000Z",
      },
      {
        id: "jira-sample:10007",
        providerId: "jira-sample",
        title: "整理提交材料",
        url: "https://sample-jira.atlassian.net/browse/TRI-7",
        state: "In Progress",
        updatedAt: "2026-11-16T01:00:00.000Z",
      },
    ]);
  });
});

describe("seam 1 · 已完成条目收敛", () => {
  it("doneStates 命中的条目不出现在输出清单里，两家的判法各自生效", async () => {
    const http = fakeHttp({
      github: {
        view: [
          issue(3001, "写本周周报", "open", "2026-11-16T08:00:00Z"),
          issue(3002, "整理提交材料", "closed", "2026-11-16T09:00:00Z"),
        ],
      },
      jira: {
        view: [
          // 完成态字面量与 GitHub 不同家：这里叫 Done，GitHub 叫 closed。
          ticket("10021", "TRI-21", "修复登录回调", "In Progress", "2026-11-16T17:00:00.000+0800"),
          ticket("10022", "TRI-22", "归档旧分支", "Done", "2026-11-16T18:00:00.000+0800"),
        ],
      },
    });

    const list = await buildTodayList({
      providers: [createGithubLikeProvider(), createJiraLikeProvider()],
      http,
      now: clock,
      scope,
    });

    expect(list.tasks.map((task) => task.title)).toEqual(["修复登录回调", "写本周周报"]);
  });
});

describe("seam 1 · 下一轮构建", () => {
  const jira = createJiraLikeProvider();

  it("视图里不再出现、但按 id 仍能取回的条目：Deleted 的那条消失，仍在进行的那条留下", async () => {
    const firstRound = fakeHttp({
      jira: {
        view: [
          ticket("10031", "TRI-31", "清理过期构建产物", "In Progress", "2026-11-16T10:00:00.000+0800"),
          ticket("10032", "TRI-32", "补齐回调文档", "In Progress", "2026-11-16T11:00:00.000+0800"),
        ],
      },
    });
    const round1 = await buildTodayList({ providers: [jira], http: firstRound, now: clock, scope });
    expect(round1.tasks).toHaveLength(2);

    // 第二轮：两条都离开了"派给我"的视图，按 id 批量取回时一条仍在进行、一条已是 Deleted。
    // 只保留仍在进行的那条，才同时满足"已删除的消失"和"消失不等于删除"。
    const secondRound = fakeHttp({
      jira: {
        view: [],
        byId: [
          ticket("10031", "TRI-31", "清理过期构建产物", "Deleted", "2026-11-17T09:30:00.000+0800"),
          ticket("10032", "TRI-32", "补齐回调文档", "In Progress", "2026-11-17T09:00:00.000+0800"),
        ],
      },
    });
    const round2 = await buildTodayList({
      providers: [jira],
      http: secondRound,
      now: clock,
      scope,
      previous: round1.tasks,
    });

    expect(round2.tasks.map((task) => task.title)).toEqual(["补齐回调文档"]);
  });

  it("批量取回一条都没返回时是「跳过」：条目带着上一轮的字段留在清单里", async () => {
    const firstRound = fakeHttp({
      jira: { view: [ticket("10041", "TRI-41", "排查 Gitee 403", "In Progress", "2026-11-16T14:00:00.000+0800")] },
    });
    const round1 = await buildTodayList({ providers: [jira], http: firstRound, now: clock, scope });

    // 这家平台的 deletedStates 非空，所以"没返回"若被当成删除，这条就会消失。
    const secondRound = fakeHttp({ jira: { view: [], byId: [] } });
    const round2 = await buildTodayList({
      providers: [jira],
      http: secondRound,
      now: clock,
      scope,
      previous: round1.tasks,
    });

    expect(round2.tasks).toEqual([
      {
        id: "jira-sample:10041",
        providerId: "jira-sample",
        title: "排查 Gitee 403",
        url: "https://sample-jira.atlassian.net/browse/TRI-41",
        state: "In Progress",
        updatedAt: "2026-11-16T06:00:00.000Z",
      },
    ]);
  });

  it("本轮视图里已经出现过的条目不会再按 id 取回，也不会被上一轮的旧状态复活", async () => {
    const github = createGithubLikeProvider();
    const firstRound = fakeHttp({ github: { view: [issue(3001, "写本周周报", "open", "2026-11-16T08:00:00Z")] } });
    const round1 = await buildTodayList({ providers: [github], http: firstRound, now: clock, scope });

    // 第二轮：视图里这条已是 closed，而按 id 批量取回没返回它。
    // 「没返回 = 跳过」只该管本轮见不到的条目，否则上一轮的 open 会把刚完成的这条重新请回清单。
    const secondRound = fakeHttp({
      github: { view: [issue(3001, "写本周周报", "closed", "2026-11-17T08:00:00Z")], byId: [] },
    });
    const round2 = await buildTodayList({
      providers: [github],
      http: secondRound,
      now: clock,
      scope,
      previous: round1.tasks,
    });

    expect(round2.tasks).toEqual([]);
  });
});
