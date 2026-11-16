import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { createGithubLikeProvider, fixtureHttp } from "../src/fakes/githubLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function deps() {
  return { providers: [createGithubLikeProvider()], http: fixtureHttp, now: clock, scope };
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
