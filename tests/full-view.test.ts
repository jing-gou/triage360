import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Http, Scope } from "../src/core/provider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function issue(number: number, title: string, state: string, updated_at: string, due_on?: string) {
  return {
    number,
    title,
    state,
    updated_at,
    html_url: `https://github.com/jing-gou/triage360/issues/${number}`,
    ...(due_on === undefined ? {} : { milestone: { due_on } }),
  };
}

/** 12 条未完成：1 逾期 + 1 今日到期 + 10 无截止。 */
const OPEN = [
  issue(3001, "逾期的一条", "open", "2026-11-16T08:00:00Z", "2026-11-10T00:00:00Z"),
  issue(3002, "今天到期的一条", "open", "2026-11-16T09:00:00Z", "2026-11-17T02:00:00Z"),
  ...Array.from({ length: 10 }, (_, index) => issue(3010 + index, `普通的一条 ${index + 1}`, "open", "2026-11-15T10:00:00Z")),
];

/** 71 条已完成：只该出现在完整视图里。 */
const DONE = Array.from({ length: 71 }, (_, index) =>
  issue(4001 + index, `已完成 ${index + 1}`, "closed", "2026-11-14T10:00:00Z"),
);

const ALL = [...OPEN, ...DONE];

function countingHttp(view: unknown[]): { http: Http; calls: () => number } {
  const base = fakeHttp({ github: { view } });
  let calls = 0;
  return {
    http: (url, init) => {
      calls += 1;
      return base(url, init);
    },
    calls: () => calls,
  };
}

describe("seam 1 · 完整视图（对照 83 条）", () => {
  it("83 条源站条目里，今日清单仍只留 12 条未完成，完整视图把 71 条已完成也列出来", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: countingHttp(ALL).http,
      now: clock,
      scope,
    });

    expect(list.entries).toHaveLength(12);
    expect(list.full).toHaveLength(83);
    expect(list.full.filter((entry) => entry.done)).toHaveLength(71);
    // 今日清单里的每一条在完整视图里都标记为未完成。
    expect(
      list.entries.every((entry) => list.full.find((one) => one.task.id === entry.task.id)?.done === false),
    ).toBe(true);
    // 长度受控了，理由不能跟着失真：逾期与今日到期仍在最前面。
    expect(list.entries[0]?.reason).toBe("overdue");
    expect(list.entries[1]?.reason).toBe("dueToday");
  });

  it("83 条完整视图仍然只有一轮取数：一次批量，不是逐条", async () => {
    const counted = countingHttp(ALL);

    await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: counted.http,
      now: clock,
      scope,
    });

    expect(counted.calls()).toBe(1);
  });

  it("完整视图把未完成排在已完成前面，两组内部沿用同一套档位与更新时间序", async () => {
    const shuffled = [
      issue(5001, "已完成较早", "closed", "2026-11-10T00:00:00Z"),
      issue(5002, "未完成较旧", "open", "2026-11-12T00:00:00Z"),
      issue(5003, "逾期的一条", "open", "2026-11-11T00:00:00Z", "2026-11-10T00:00:00Z"),
      issue(5004, "已完成较晚", "closed", "2026-11-16T00:00:00Z"),
      issue(5005, "未完成较新", "open", "2026-11-16T00:00:00Z"),
    ];

    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: countingHttp(shuffled).http,
      now: clock,
      scope,
    });

    expect(list.full.map((entry) => entry.task.title)).toEqual([
      "逾期的一条",
      "未完成较新",
      "未完成较旧",
      "已完成较晚",
      "已完成较早",
    ]);
  });
});
