import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { createFeishuSampleProvider } from "../src/fakes/feishuLikeProvider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGiteeLikeProvider } from "../src/fakes/giteeLikeProvider";
import { createGithubLikeProvider, FIXTURE_ISSUES } from "../src/fakes/githubLikeProvider";
import { createJiraLikeProvider } from "../src/fakes/jiraLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function deps() {
  return {
    providers: [createGithubLikeProvider()],
    http: fakeHttp({ github: { view: FIXTURE_ISSUES } }),
    now: clock,
    scope,
  };
}

/** 两家源站的原始形状字面量。构造器只省重复，不做任何判断。 */
function issue(number: number, title: string, state: string, updated_at: string) {
  return { number, title, state, updated_at, html_url: `https://github.com/jing-gou/triage360/issues/${number}` };
}

function ticket(id: string, key: string, summary: string, status: string, updated: string) {
  return { id, key, fields: { summary, status: { name: status }, updated } };
}

function giteeIssue(repo: string, number: number, title: string, state: string, updated_at: string) {
  return { number, title, state, updated_at, html_url: `https://gitee.com/${repo}/issues/${number}` };
}

function feishuTask(task_id: string, summary: string, done: boolean, updated_at: string) {
  return { task_id, summary, done, updated_at };
}

describe("seam 1 · 今日清单构建器", () => {
  it("给出 3 条任务，顺序由构建器决定而非 provider 返回的数组顺序", async () => {
    const list = await buildTodayList(deps());

    expect(list.entries.map((entry) => entry.task.title)).toEqual([
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

    expect(list.entries.map((entry) => entry.task)).toEqual([
      {
        id: "github:2001",
        providerId: "github",
        title: "修复登录回调",
        url: "https://github.com/jing-gou/triage360/issues/2001",
        state: "open",
        updatedAt: "2026-11-16T08:20:00.000Z",
      },
      {
        id: "jira:10007",
        providerId: "jira",
        title: "整理提交材料",
        url: "https://sample-jira.atlassian.net/browse/TRI-7",
        state: "In Progress",
        updatedAt: "2026-11-16T01:00:00.000Z",
      },
    ]);
  });
});

describe("seam 1 · 定稿的截止时间：dueAt 与 updatedAt 同一个 UTC 基准", () => {
  // 为什么现在就把 dueAt 收进定稿：#6 要「逾期 / 今日到期置顶」，而核心层不许碰原始字段
  // （`docs/PRD.md:101`）。不在这里收，T04 只剩两条路——加第 8 个契约方法，或伸手进 raw。
  // GitHub 的 issue 自己没有截止时间，`due_on` 挂在 milestone 上且可为 null；
  // Jira 的 `fields.duedate` 带 +0800。日期形式（不含时刻）的折算已由 #6 定在
  // `dueFrom`（按日比，见 #6 的 ADR-0005），这里只做时间基准。
  const http = fakeHttp({
    github: {
      view: [
        {
          number: 2002,
          title: "补全导入模板",
          html_url: "https://github.com/jing-gou/triage360/issues/2002",
          state: "open",
          updated_at: "2026-11-16T06:00:00Z",
          milestone: { due_on: "2026-11-17T23:00:00Z" },
        },
      ],
    },
    jira: {
      view: [
        {
          id: "10008",
          key: "TRI-8",
          self: "https://sample-jira.atlassian.net/rest/api/3/issue/10008",
          fields: {
            summary: "核对工时表",
            status: { name: "To Do" },
            updated: "2026-11-16T12:00:00.000+0800",
            duedate: "2026-11-18T09:00:00.000+0800",
          },
        },
      ],
    },
  });

  it("两家的原始格式换算成同一个 UTC 基准，可比较大小", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider(), createJiraLikeProvider()],
      http,
      now: clock,
      scope,
    });

    expect(list.entries.map((entry) => entry.task)).toEqual([
      {
        id: "github:2002",
        providerId: "github",
        title: "补全导入模板",
        url: "https://github.com/jing-gou/triage360/issues/2002",
        state: "open",
        updatedAt: "2026-11-16T06:00:00.000Z",
        dueAt: "2026-11-17T23:00:00.000Z",
        duePrecision: "instant",
      },
      {
        id: "jira:10008",
        providerId: "jira",
        title: "核对工时表",
        url: "https://sample-jira.atlassian.net/browse/TRI-8",
        state: "To Do",
        updatedAt: "2026-11-16T04:00:00.000Z",
        dueAt: "2026-11-18T01:00:00.000Z",
        duePrecision: "instant",
      },
    ]);
  });
});

describe("seam 1 · 定稿的门：输出形状就是那八个键", () => {
  // toEqual 不会因为多一个 `dueAt: undefined` 而红，所以形状要单独钉住：
  // 「定稿」这句话得有一道能挡反例的门。键集合也不能按平台分叉——
  // 没有截止时间的条目照样写出 dueAt，否则 #6 的打分要先判「这家有没有这个键」。
  const http = fakeHttp({
    github: { view: [issue(2001, "修复登录回调", "open", "2026-11-16T08:20:00Z")] },
    gitee: { view: [giteeIssue("jing-gou/triage360", 313, "回调地址改名后失效", "progress", "2026-11-16T17:05:00+08:00")] },
    jira: { view: [ticket("10007", "TRI-7", "整理提交材料", "In Progress", "2026-11-16T09:00:00.000+0800")] },
    feishu: { view: [feishuTask("task-9", "催一下季度评审材料", false, "2026-11-16T13:10:00+08:00")] },
  });

  it("四家归一化之后的键集合完全一致，且恒为八个", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider(), createGiteeLikeProvider(), createJiraLikeProvider(), createFeishuSampleProvider()],
      http,
      now: clock,
      scope,
    });

    const shapes = list.entries.map((entry) => Object.keys(entry.task).sort().join(","));

    expect(list.entries).toHaveLength(4);
    expect([...new Set(shapes)]).toEqual(["dueAt,duePrecision,id,providerId,state,title,updatedAt,url"]);
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

    expect(list.entries.map((entry) => entry.task.title)).toEqual(["修复登录回调", "写本周周报"]);
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
    expect(round1.entries).toHaveLength(2);

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
      previous: round1.entries.map((entry) => entry.task),
    });

    expect(round2.entries.map((entry) => entry.task.title)).toEqual(["补齐回调文档"]);
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
      previous: round1.entries.map((entry) => entry.task),
    });

    expect(round2.entries.map((entry) => entry.task)).toEqual([
      {
        id: "jira:10041",
        providerId: "jira",
        title: "排查 Gitee 403",
        url: "https://sample-jira.atlassian.net/browse/TRI-41",
        state: "In Progress",
        updatedAt: "2026-11-16T06:00:00.000Z",
      },
    ]);
  });

  it("刚完成的条目不会被上一轮的旧状态复活", async () => {
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
      previous: round1.entries.map((entry) => entry.task),
    });

    expect(round2.entries.map((entry) => entry.task)).toEqual([]);
  });

  it("没有批量端点的平台用 404 表达「这条没有了」：按跳过保留，而不是让整轮失败", async () => {
    const gitee = createGiteeLikeProvider();
    const firstRound = fakeHttp({
      gitee: {
        view: [giteeIssue("jing-gou/triage360", 313, "回调地址改名后失效", "progress", "2026-11-16T17:05:00+08:00")],
      },
    });
    const round1 = await buildTodayList({ providers: [gitee], http: firstRound, now: clock, scope });

    // 本轮视图不返回这条，单条端点给 404。既不是完成也不是删除，所以条目该带着上一轮字段留下。
    const secondRound = fakeHttp({ gitee: { view: [], byId: [] } });
    const round2 = await buildTodayList({
      providers: [gitee],
      http: secondRound,
      now: clock,
      scope,
      previous: round1.entries.map((entry) => entry.task),
    });

    expect(round2.entries.map((entry) => entry.task)).toEqual([
      {
        id: "gitee:jing-gou/triage360#313",
        providerId: "gitee",
        title: "回调地址改名后失效",
        url: "https://gitee.com/jing-gou/triage360/issues/313",
        state: "progress",
        updatedAt: "2026-11-16T09:05:00.000Z",
      },
    ]);
  });
});

describe("seam 1 · Gitee 与飞书 的形状差异", () => {
  it("同一数字在两个仓库里是两张卡：远端 id 带仓库段", async () => {
    const gitee = createGiteeLikeProvider();
    const http = fakeHttp({
      gitee: {
        view: [
          giteeIssue("jing-gou/legacy-importer", 313, "导入的历史工时少一天", "ongoing", "2026-11-16T15:30:00+08:00"),
          giteeIssue("jing-gou/triage360", 313, "回调地址改名后失效", "progress", "2026-11-16T17:05:00+08:00"),
        ],
      },
    });

    const list = await buildTodayList({ providers: [gitee], http, now: clock, scope });

    expect(list.entries.map((entry) => entry.task)).toEqual([
      {
        id: "gitee:jing-gou/triage360#313",
        providerId: "gitee",
        title: "回调地址改名后失效",
        url: "https://gitee.com/jing-gou/triage360/issues/313",
        state: "progress",
        updatedAt: "2026-11-16T09:05:00.000Z",
      },
      {
        id: "gitee:jing-gou/legacy-importer#313",
        providerId: "gitee",
        title: "导入的历史工时少一天",
        url: "https://gitee.com/jing-gou/legacy-importer/issues/313",
        state: "ongoing",
        updatedAt: "2026-11-16T07:30:00.000Z",
      },
    ]);
  });

  it("完成态是布尔值的平台：布尔折成状态字面量后照样收敛", async () => {
    const feishu = createFeishuSampleProvider();
    const http = fakeHttp({
      feishu: {
        view: [
          feishuTask("task-9", "催一下季度评审材料", false, "2026-11-16T13:10:00+08:00"),
          feishuTask("task-12", "整理值班交接清单", true, "2026-11-16T10:05:00+08:00"),
        ],
      },
    });

    const list = await buildTodayList({ providers: [feishu], http, now: clock, scope });

    expect(list.entries.map((entry) => entry.task)).toEqual([
      {
        id: "feishu:task-9",
        providerId: "feishu",
        title: "催一下季度评审材料",
        url: "https://applink.feishu.cn/client/todo/detail?guid=task-9",
        state: "open",
        updatedAt: "2026-11-16T05:10:00.000Z",
      },
    ]);
  });
});
