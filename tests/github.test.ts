import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Http, Scope, Task } from "../src/core/provider";
import { createGithubProvider } from "../src/providers/github";

const scope: Scope = { assignee: "jing-gou" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

/** GitHub 搜索接口返回的一条原始 issue：字段名照抄 `GET /search/issues` 的响应。 */
function searchItem(number: number, title: string, state: string, updatedAt: string, dueOn?: string) {
  return {
    number,
    title,
    html_url: `https://github.com/jing-gou/triage360/issues/${number}`,
    repository_url: "https://api.github.com/repos/jing-gou/triage360",
    state,
    updated_at: updatedAt,
    milestone: dueOn === undefined ? null : { due_on: dueOn },
  };
}

/**
 * 记录每次请求的替身。GitHub 没有跨仓库的按 id 批量端点，单条取回会落到
 * `/repos/{owner}/{repo}/issues/{number}`：替身按这条路径回吐，未登记的请求直接抛错。
 */
function recordingHttp(items: unknown[], byId: unknown[] = []) {
  const calls: string[] = [];
  const http: Http = async (url) => {
    calls.push(url);
    const target = new URL(url);
    if (target.pathname === "/search/issues") return { status: 200, headers: {}, body: { items } };
    const single = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(target.pathname);
    if (single !== null) {
      const found = byId.find(
        (one) => (one as { number: number }).number === Number(single[2]),
      );
      return found === undefined
        ? { status: 404, headers: {}, body: null }
        : { status: 200, headers: {}, body: found };
    }
    throw new Error(`没有登记的请求：${target.pathname}`);
  };
  return { calls, http };
}

function deps(http: Http) {
  return { providers: [createGithubProvider()], http, now: clock, scope };
}

describe("seam 1 · 真实 GitHub provider：请求形状", () => {
  it("搜索「指派给我」的未关闭 issue 用一条请求，查询条件的形状固定", async () => {
    const { calls, http } = recordingHttp([]);

    await buildTodayList(deps(http));

    // 身份由 token 决定，所以是 @me 而不是 scope 里那个显示名；is:open 把已关闭的挡在视图外，
    // 从视图里消失的条由上一轮的按 id 补取分辨「已关闭」与「这次没返回」。
    expect(calls).toEqual([
      "https://api.github.com/search/issues?q=assignee%3A%40me%20is%3Aissue%20is%3Aopen&per_page=100",
    ]);
  });
});

describe("seam 1 · 真实 GitHub provider：normalize 输出", () => {
  it("八键照常填齐，id 带上仓库路径，milestone 的 due_on 带时刻所以按 instant 粒度", async () => {
    const { http } = recordingHttp([
      searchItem(1041, "修复登录回调", "open", "2026-11-16T08:20:00Z", "2026-11-16T00:00:00Z"),
    ]);

    const list = await buildTodayList(deps(http));
    const [entry] = list.entries;

    expect(entry?.task).toEqual({
      id: "github:jing-gou/triage360#1041",
      providerId: "github",
      title: "修复登录回调",
      url: "https://github.com/jing-gou/triage360/issues/1041",
      state: "open",
      updatedAt: "2026-11-16T08:20:00.000Z",
      dueAt: "2026-11-16T00:00:00.000Z",
      duePrecision: "instant",
    });
    expect(entry?.reason).toBe("overdue");
  });

  it("视图里混进 closed 时由 doneStates 收敛掉，顺序仍按截止时间分档", async () => {
    const { http } = recordingHttp([
      searchItem(1043, "下周再做", "open", "2026-11-15T09:41:00Z", "2026-11-25T00:00:00Z"),
      searchItem(1042, "已经关掉的", "closed", "2026-11-16T10:00:00Z"),
      searchItem(1041, "修复登录回调", "open", "2026-11-16T08:20:00Z", "2026-11-16T00:00:00Z"),
    ]);

    const list = await buildTodayList(deps(http));

    expect(list.entries.map((entry) => entry.task.title)).toEqual(["修复登录回调", "下周再做"]);
    expect(list.entries.map((entry) => entry.reason)).toEqual(["overdue", "dueLater"]);
  });
});

describe("seam 1 · 真实 GitHub provider：上一轮条目按 id 补取", () => {
  it("从视图里消失的条走单条端点；取回是 closed 就收敛掉", async () => {
    const previousOpen: Task = {
      id: "github:jing-gou/triage360#1041",
      providerId: "github",
      title: "修复登录回调",
      url: "https://github.com/jing-gou/triage360/issues/1041",
      state: "open",
      updatedAt: "2026-11-16T08:20:00.000Z",
    };
    const { calls, http } = recordingHttp(
      [searchItem(1043, "下周再做", "open", "2026-11-15T09:41:00Z")],
      [searchItem(1041, "修复登录回调", "closed", "2026-11-16T12:00:00Z")],
    );

    const list = await buildTodayList({ ...deps(http), previous: [previousOpen] });

    expect(calls).toContain("https://api.github.com/repos/jing-gou/triage360/issues/1041");
    expect(list.entries.map((entry) => entry.task.title)).toEqual(["下周再做"]);
  });

  it("单条端点 404 时保留上一轮那条，而不是当成已删除", async () => {
    const previousOpen: Task = {
      id: "github:jing-gou/triage360#1041",
      providerId: "github",
      title: "修复登录回调",
      url: "https://github.com/jing-gou/triage360/issues/1041",
      state: "open",
      updatedAt: "2026-11-16T08:20:00.000Z",
    };
    const { http } = recordingHttp([]);

    const list = await buildTodayList({ ...deps(http), previous: [previousOpen] });

    expect(list.entries.map((entry) => entry.task.id)).toEqual(["github:jing-gou/triage360#1041"]);
  });
});
