import { describe, expect, it } from "vitest";
import { buildTodayList, type SameEvent } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGiteeLikeProvider } from "../src/fakes/giteeLikeProvider";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function gh(number: number, title: string, updated_at: string, due_on?: string) {
  return {
    number,
    title,
    state: "open",
    updated_at,
    ...(due_on === undefined ? {} : { milestone: { due_on } }),
    html_url: `https://github.com/jing-gou/triage360/issues/${number}`,
  };
}

function ge(number: number, title: string, updated_at: string) {
  return {
    number,
    title,
    state: "new",
    updated_at,
    html_url: `https://gitee.com/jing-gou/legacy-importer/issues/${number}`,
  };
}

/**
 * 五条基础夹具，档位各不相同：921 逾期、922 今日到期（只写日期）、923 / 321 / 322 无截止。
 * 不带 `manualOrder` 时规则的序是 921 → 922 → 322 → 923 → 321（第三档内按更新时间倒序）。
 */
const VIEW = {
  github: {
    view: [
      gh(921, "修复登录回调", "2026-11-16T10:00:00Z", "2026-11-16T18:00:00Z"),
      gh(922, "写本周周报", "2026-11-16T11:00:00Z", "2026-11-17"),
      gh(923, "整理提交材料", "2026-11-16T12:00:00Z"),
    ],
  },
  gitee: {
    view: [ge(321, "催一下季度评审材料", "2026-11-16T09:00:00Z"), ge(322, "对接 3LO 回调", "2026-11-16T13:00:00Z")],
  },
};

function deps(manualOrder: readonly string[]) {
  return {
    providers: [createGithubLikeProvider(), createGiteeLikeProvider()],
    http: fakeHttp(VIEW),
    now: clock,
    scope,
    manualOrder,
  };
}

const GITEE_321 = "gitee:jing-gou/legacy-importer#321";
const GITEE_322 = "gitee:jing-gou/legacy-importer#322";

describe("seam 1 · 手动顺序优先于规则打分", () => {
  it("排过的三条按访客留下的次序在前，没排过的仍按规则跟在后面", async () => {
    const list = await buildTodayList(deps([GITEE_321, "github:921", "github:923"]));

    // 期望值按口径手推，不由实现反算：手动区 = manualOrder 里出现的卡按 manualOrder 的次序；
    // 未排区 = 剩下的按档位→更新时间→id 排，所以 922（今日到期）落在第 4 而不是第 1。
    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      [GITEE_321, "noDeadline"],
      ["github:921", "overdue"],
      ["github:923", "noDeadline"],
      ["github:922", "dueToday"],
      [GITEE_322, "noDeadline"],
    ]);
  });

  it("手动区不因为上游有新动静就重排：变逾期的一条也排在手动区之后", async () => {
    // 与基础夹具只差 922 这一条：截止改到已经过去的时刻，更新时间改成全场最新。
    const view = {
      github: {
        view: [
          gh(921, "修复登录回调", "2026-11-16T10:00:00Z", "2026-11-16T18:00:00Z"),
          gh(922, "写本周周报", "2026-11-16T23:00:00Z", "2026-11-16T20:00:00Z"),
          gh(923, "整理提交材料", "2026-11-16T12:00:00Z"),
        ],
      },
      gitee: VIEW.gitee,
    };

    const list = await buildTodayList({ ...deps([GITEE_321, "github:921", "github:923"]), http: fakeHttp(view) });

    // 922 这一轮变成逾期、更新时间也是全场最新，规则会把顶到第 1；它不在手动区里，所以第 4 是它该待的位置。
    // 这条断言同时是这个选择的价格：界面一次落盘写的是整份可见顺序，所以真实界面上拖过一次之后，
    // 所有已有卡都不再被规则挪动，只有新条目走规则序（ADR-0007）。
    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      [GITEE_321, "noDeadline"],
      ["github:921", "overdue"],
      ["github:923", "noDeadline"],
      ["github:922", "overdue"],
      [GITEE_322, "noDeadline"],
    ]);
  });

  it("手动顺序里的 id 这一轮不在了：忽略它，别人的位置不受影响", async () => {
    const list = await buildTodayList(deps(["github:999", GITEE_321, "github:921"]));

    expect(list.entries.map((entry) => entry.task.id)).toEqual([
      GITEE_321,
      "github:921",
      "github:922",
      GITEE_322,
      "github:923",
    ]);
  });
});

describe("seam 1 · 手动顺序与合并卡", () => {
  /** 911（逾期）与 313（无截止）是同一件事，912 无截止且比两者都新。 */
  function mergedDeps(manualOrder: readonly string[]) {
    const sameEvent: SameEvent = (a, b) =>
      [a.id, b.id].includes("github:911") && [a.id, b.id].includes("gitee:jing-gou/legacy-importer#313");
    return {
      providers: [createGithubLikeProvider(), createGiteeLikeProvider()],
      http: fakeHttp({
        github: {
          view: [
            gh(911, "修复登录回调", "2026-11-16T10:00:00Z", "2026-11-16T18:00:00Z"),
            gh(912, "写本周周报", "2026-11-16T13:00:00Z"),
          ],
        },
        gitee: { view: [ge(313, "回调地址改名后失效", "2026-11-16T12:00:00Z")] },
      }),
      now: clock,
      scope,
      sameEvent,
      manualOrder,
    };
  }

  it("手动把合并卡挪到别的一条后面：表头、档位、来源集合都不动", async () => {
    const list = await buildTodayList(mergedDeps(["github:912", "github:911"]));

    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      ["github:912", "noDeadline"],
      ["github:911", "overdue"],
    ]);
    expect(list.entries[1]?.mergedFrom?.map((task) => task.id)).toEqual([
      "github:911",
      "gitee:jing-gou/legacy-importer#313",
    ]);
  });

  it("手动顺序认的是卡而不是来源：被并掉的那条排到最前也不当表头", async () => {
    const list = await buildTodayList(mergedDeps(["gitee:jing-gou/legacy-importer#313", "github:912"]));

    // 313 已经并进 911，界面上没有它这张卡，所以它那一格是空的；912 照旧被提到第一位。
    // 若手动顺序在合并之前生效，313 会抢到这一组的第一位并当上表头，整张卡从 overdue 掉成 noDeadline
    // ——ADR-0006「表头站在最紧急那一档」就是这条断言要守的东西。
    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      ["github:912", "noDeadline"],
      ["github:911", "overdue"],
    ]);
    expect(list.entries[1]?.mergedFrom?.map((task) => task.id)).toEqual([
      "github:911",
      "gitee:jing-gou/legacy-importer#313",
    ]);
  });
});
