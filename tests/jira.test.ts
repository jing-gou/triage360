import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Http, Scope, Task } from "../src/core/provider";
import { createJiraProvider } from "../src/providers/jira";

const cloudId = "1324a887-45db-1bf4-1e99-ef0ff456d421";
const siteUrl = "https://acme.atlassian.net";
const scope: Scope = { assignee: "currentUser()" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

function issue(id: string, key: string, category: string, updated: string, duedate: string | null = null) {
  return {
    id,
    key,
    fields: {
      summary: `任务 ${key}`,
      status: { statusCategory: { key: category } },
      updated,
      duedate,
    },
  };
}

function recordingHttp(issues: unknown[], byId: unknown[] = []) {
  const calls: string[] = [];
  const http: Http = async (url) => {
    calls.push(url);
    const target = new URL(url);
    if (target.pathname === `/ex/jira/${cloudId}/rest/api/3/search/jql`) {
      return { status: 200, headers: {}, body: { issues, isLast: true } };
    }
    const single = new RegExp(`^/ex/jira/${cloudId}/rest/api/3/issue/([^/]+)$`).exec(target.pathname);
    if (single !== null) {
      const found = byId.find((one) => (one as { id: string }).id === decodeURIComponent(single[1] ?? ""));
      return found === undefined
        ? { status: 404, headers: {}, body: null }
        : { status: 200, headers: {}, body: found };
    }
    throw new Error(`没有登记的请求：${target.pathname}`);
  };
  return { calls, http };
}

function deps(http: Http) {
  const provider = createJiraProvider({ cloudId, siteUrl });
  return { providers: [provider], http, now: clock, scope };
}

describe("seam 1 · 真实 Jira provider：请求形状", () => {
  it("走 3LO 的 cloudId 网关，只取当前用户未完成的事项", async () => {
    const { calls, http } = recordingHttp([]);

    await buildTodayList(deps(http));

    expect(calls).toHaveLength(1);
    const target = new URL(calls[0] ?? "");
    expect(target.origin + target.pathname).toBe(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/search/jql`,
    );
    expect(target.searchParams.get("jql")).toBe(
      "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    );
    expect(target.searchParams.get("fields")).toBe("summary,status,updated,duedate,labels");
    expect(target.searchParams.get("maxResults")).toBe("50");
  });

  it("includeDone 时不再排除 Done，交给 doneStates 收敛", async () => {
    const { calls, http } = recordingHttp([]);

    await buildTodayList({ ...deps(http), scope: { ...scope, includeDone: true } });

    const target = new URL(calls[0] ?? "");
    expect(target.searchParams.get("jql")).toBe("assignee = currentUser() ORDER BY updated DESC");
  });
});

describe("seam 1 · 真实 Jira provider：normalize 输出", () => {
  it("全局 issue id 进任务 id，状态取 statusCategory，日期截止按天", async () => {
    const { http } = recordingHttp([
      issue("10042", "ABC-1", "indeterminate", "2026-11-16T08:20:00.000+0800", "2026-11-16"),
    ]);

    const list = await buildTodayList(deps(http));
    const [entry] = list.entries;

    expect(entry?.task).toEqual({
      id: "jira:10042",
      providerId: "jira",
      title: "任务 ABC-1",
      url: "https://acme.atlassian.net/browse/ABC-1",
      state: "indeterminate",
      labels: [],
      updatedAt: "2026-11-16T00:20:00.000Z",
      dueAt: "2026-11-16T00:00:00.000Z",
      duePrecision: "day",
    });
    expect(entry?.reason).toBe("overdue");
  });

  it("Done 被 doneStates 收敛；没有截止时九键仍齐全", async () => {
    const { http } = recordingHttp([
      issue("10042", "ABC-1", "new", "2026-11-16T09:00:00.000+0800"),
      issue("10043", "ABC-2", "done", "2026-11-16T10:00:00.000+0800"),
    ]);

    const list = await buildTodayList(deps(http));

    expect(list.entries.map((entry) => entry.task.id)).toEqual(["jira:10042"]);
    expect(list.entries[0]?.task.dueAt).toBeUndefined();
    expect(list.entries[0]?.task.duePrecision).toBeUndefined();
  });
});

describe("seam 1 · 真实 Jira provider：上一轮条目按 id 补取", () => {
  const previousOpen: Task = {
    id: "jira:10042",
    providerId: "jira",
    title: "任务 ABC-1",
    url: "https://acme.atlassian.net/browse/ABC-1",
    state: "new",
    labels: [],
    updatedAt: "2026-11-16T00:20:00.000Z",
    dueAt: undefined,
    duePrecision: undefined,
  };

  it("从视图里消失的条走单条 issue 端点；取回是 Done 就收敛掉", async () => {
    const { calls, http } = recordingHttp(
      [],
      [issue("10042", "ABC-1", "done", "2026-11-16T12:00:00.000+0800")],
    );

    const list = await buildTodayList({ ...deps(http), previous: [previousOpen] });

    const lookup = new URL(calls.find((one) => one.includes("/issue/")) ?? "");
    expect(lookup.origin + lookup.pathname).toBe(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/10042`,
    );
    expect(lookup.searchParams.get("fields")).toBe("summary,status,updated,duedate,labels");
    expect(list.entries).toEqual([]);
  });

  it("单条端点 404 时保留上一轮那条", async () => {
    const { http } = recordingHttp([]);

    const list = await buildTodayList({ ...deps(http), previous: [previousOpen] });

    expect(list.entries.map((entry) => entry.task.id)).toEqual(["jira:10042"]);
  });
});