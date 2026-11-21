import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Http, Scope, Task } from "../src/core/provider";
import { createGiteeProvider, GiteeUpstreamError } from "../src/providers/gitee";

const scope: Scope = { assignee: "triage360-demo" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

/** Gitee 的 issue 编号是字符串（新仓库常见 `IDLSUI` 这种），不是数字。 */
function issue(number: string, state: string, updatedAt: string, deadline: string | null = null) {
  return {
    number,
    title: `任务 ${number}`,
    html_url: `https://gitee.com/jing-gou/triage360/issues/${number}`,
    state,
    updated_at: updatedAt,
    deadline,
    repository: { full_name: "jing-gou/triage360" },
  };
}

function recordingHttp(views: Record<string, unknown[]>, byId: unknown[] = []) {
  const calls: string[] = [];
  const http: Http = async (url) => {
    calls.push(url);
    const target = new URL(url);
    if (target.pathname === "/api/v5/user/issues") {
      const state = target.searchParams.get("state") ?? "";
      return { status: 200, headers: {}, body: views[state] ?? [] };
    }
    const single = /^\/api\/v5\/repos\/([^/]+\/[^/]+)\/issues\/([^/]+)$/.exec(target.pathname);
    if (single !== null) {
      const found = byId.find(
        (one) => (one as { number: string }).number === decodeURIComponent(single[2] ?? ""),
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
  return { providers: [createGiteeProvider()], http, now: clock, scope };
}

describe("seam 1 · 真实 Gitee provider：请求形状", () => {
  it("用跨仓库的「授权用户的 Issues」端点，按活跃状态各一次", async () => {
    const { calls, http } = recordingHttp({ open: [], progressing: [] });

    await buildTodayList(deps(http));

    expect(calls).toEqual([
      "https://gitee.com/api/v5/user/issues?filter=assigned&state=open&sort=updated&direction=desc&per_page=100",
      "https://gitee.com/api/v5/user/issues?filter=assigned&state=progressing&sort=updated&direction=desc&per_page=100",
    ]);
  });

  it("403 带明确的错误信息：User-Agent 是官方点名的坑", async () => {
    const http: Http = async () => ({ status: 403, headers: {}, body: null });

    await expect(buildTodayList(deps(http))).rejects.toBeInstanceOf(GiteeUpstreamError);
    await expect(buildTodayList(deps(http))).rejects.toThrow(/403.*User-Agent/);
  });
});

describe("seam 1 · 真实 Gitee provider：normalize 输出", () => {
  it("字符串编号与仓库一起进 id，deadline 折算成 instant 粒度", async () => {
    const { http } = recordingHttp({
      open: [issue("IDLSUI", "open", "2026-11-16T08:20:00+08:00", "2026-11-16T23:59:59+08:00")],
      progressing: [],
    });

    const list = await buildTodayList(deps(http));
    const [entry] = list.entries;

    expect(entry?.task).toEqual({
      id: "gitee:jing-gou/triage360#IDLSUI",
      providerId: "gitee",
      title: "任务 IDLSUI",
      url: "https://gitee.com/jing-gou/triage360/issues/IDLSUI",
      state: "open",
      updatedAt: "2026-11-16T00:20:00.000Z",
      dueAt: "2026-11-16T15:59:59.000Z",
      duePrecision: "instant",
    });
    expect(entry?.reason).toBe("overdue");
  });

  it("没有 deadline 时八键仍齐全；closed / rejected 由 doneStates 收敛", async () => {
    const { http } = recordingHttp({
      open: [
        issue("A1", "open", "2026-11-16T09:00:00+08:00"),
        issue("A2", "closed", "2026-11-16T10:00:00+08:00"),
      ],
      progressing: [issue("A3", "rejected", "2026-11-16T11:00:00+08:00")],
    });

    const list = await buildTodayList(deps(http));

    expect(list.entries.map((entry) => entry.task.id)).toEqual(["gitee:jing-gou/triage360#A1"]);
    expect(list.entries[0]?.task.dueAt).toBeUndefined();
    expect(list.entries[0]?.task.duePrecision).toBeUndefined();
  });
});

describe("seam 1 · 真实 Gitee provider：上一轮条目按 id 补取", () => {
  const previousOpen: Task = {
    id: "gitee:jing-gou/triage360#IDLSUI",
    providerId: "gitee",
    title: "任务 IDLSUI",
    url: "https://gitee.com/jing-gou/triage360/issues/IDLSUI",
    state: "open",
    updatedAt: "2026-11-16T00:20:00.000Z",
    dueAt: undefined,
    duePrecision: undefined,
  };

  it("从视图里消失的条走单仓库端点；取回是 closed 就收敛掉", async () => {
    const { calls, http } = recordingHttp(
      { open: [], progressing: [] },
      [issue("IDLSUI", "closed", "2026-11-16T12:00:00+08:00")],
    );

    const list = await buildTodayList({ ...deps(http), previous: [previousOpen] });

    expect(calls).toContain("https://gitee.com/api/v5/repos/jing-gou/triage360/issues/IDLSUI");
    expect(list.entries).toEqual([]);
  });

  it("单条端点 404 时保留上一轮那条，而不是当成已删除", async () => {
    const { http } = recordingHttp({ open: [], progressing: [] });

    const list = await buildTodayList({ ...deps(http), previous: [previousOpen] });

    expect(list.entries.map((entry) => entry.task.id)).toEqual(["gitee:jing-gou/triage360#IDLSUI"]);
  });
});