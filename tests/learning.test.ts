import { describe, expect, it } from "vitest";
import { buildTodayList, type LearnedBoost, type PlacementRecord, type TodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGiteeLikeProvider } from "../src/fakes/giteeLikeProvider";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";
import { createJiraLikeProvider } from "../src/fakes/jiraLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00"); // = 2026-11-17T01:00:00Z

function gh(number: number, title: string, updated_at: string) {
  return { number, title, state: "open", updated_at, html_url: `https://github.com/jing-gou/triage360/issues/${number}` };
}

function ge(number: number, title: string, updated_at: string) {
  return { number, title, state: "new", updated_at, html_url: `https://gitee.com/jing-gou/legacy-importer/issues/${number}` };
}

/**
 * 两条都没有截止时间，所以规则序只由更新时间决定：331（16 日）在 941（14 日）之前。
 * 这一票的断言全在这一对上——加权要做的正是把「访客反复置顶的那个来源」提到这条序前面。
 */
const VIEW = {
  github: { view: [gh(941, "老仓库的一条", "2026-11-14T10:00:00Z")] },
  gitee: { view: [ge(331, "另一家更新的一条", "2026-11-16T10:00:00Z")] },
};

const TRIAGE = "jing-gou/triage360";

function record(taskId: string, at: string, position: number, group = TRIAGE, labels?: string[]): PlacementRecord {
  return { providerId: "github", taskId, group, at, position, ...(labels === undefined ? {} : { labels }) };
}

function labelled(number: number, title: string, updated_at: string, labels: string[]) {
  return {
    number,
    title,
    state: "open",
    updated_at,
    html_url: `https://github.com/jing-gou/triage360/issues/${number}`,
    labels: labels.map((name) => ({ name })),
  };
}

function deps(placements: readonly PlacementRecord[]) {
  return {
    providers: [createGithubLikeProvider(), createGiteeLikeProvider()],
    http: fakeHttp(VIEW),
    now: clock,
    scope,
    placements,
  };
}

describe("seam 1 · 学习闭环按来源分组加权", () => {
  it("同一来源被连续放到前三位之后，它的新条目在同档里排到更新的那条之前", async () => {
    const list = await buildTodayList(
      deps([record("github:901", "2026-11-16T10:00:00.000Z", 0), record("github:902", "2026-11-15T10:00:00.000Z", 1)]),
    );

    // 期望值按口径手推：两条记录都在 7 天窗口内、都落在前三位 ⇒ `jing-gou/triage360` 命中 2 次；
    // 941 属于这个来源，所以它压过更新时间更晚的 331——331 的来源一次都没被置顶。
    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      ["github:941", "noDeadline"],
      ["gitee:jing-gou/legacy-importer#331", "noDeadline"],
    ]);
  });

  it("加权不改档位：命中的那条仍然写着它自己的规则理由", async () => {
    const list = await buildTodayList(
      deps([record("github:901", "2026-11-16T10:00:00.000Z", 0), record("github:902", "2026-11-15T10:00:00.000Z", 1)]),
    );

    expect(list.entries[0]?.reason).toBe("noDeadline");
  });

  it("条目带上它被哪个来源的几次置顶抬上来，理由文案才有东西可引用", async () => {
    const list = await buildTodayList(
      deps([record("github:901", "2026-11-16T10:00:00.000Z", 0), record("github:902", "2026-11-15T10:00:00.000Z", 1)]),
    );

    expect(list.entries[0]?.learned).toEqual({ group: { name: TRIAGE, hits: 2 }, hits: 2 });
    expect(list.entries[1]?.learned).toBeUndefined();
  });

  it("手动区里的卡不带命中：那张卡站在那儿是因为访客拖过它", async () => {
    const list = await buildTodayList({
      ...deps([record("github:901", "2026-11-16T10:00:00.000Z", 0), record("github:902", "2026-11-15T10:00:00.000Z", 1)]),
      // 访客把更新更晚的 331 拖到第 1、941 拖到第 2：两张卡的位置都是他自己给的。
      manualOrder: ["gitee:jing-gou/legacy-importer#331", "github:941"],
    });

    expect(list.entries.map((entry) => entry.task.id)).toEqual([
      "gitee:jing-gou/legacy-importer#331",
      "github:941",
    ]);
    // 941 那一组确实被连续置顶过两次，但它这一轮不在加权的那一侧：卡片文案若说「因为你连着把它排前面」
    // 就是把访客那一票记在了规则头上（ADR-0007）。
    expect(list.entries.map((entry) => entry.learned)).toEqual([undefined, undefined]);
  });
});

/**
 * 门槛与射程：owner 批准的口径是「7 天窗口内、前三位、两次起」。
 * 这四条钉的是口径的边界，跨过任一条就不许有加权；顺序回规则序、`learned` 一起消失。
 */
describe("seam 1 · 加权的门槛", () => {
  /** 门槛没过时应当看到的：331 更新更晚排在前面，两条都不带命中。 */
  const RULE_ORDER: [string, LearnedBoost | undefined][] = [
    ["gitee:jing-gou/legacy-importer#331", undefined],
    ["github:941", undefined],
  ];
  const seen = (list: TodayList) => list.entries.map((entry) => [entry.task.id, entry.learned] as const);

  it("只置顶过一次不算习惯", async () => {
    const list = await buildTodayList(deps([record("github:901", "2026-11-16T10:00:00.000Z", 0)]));

    expect(seen(list)).toEqual(RULE_ORDER);
  });

  it("八天前的两次置顶已经在窗口外", async () => {
    const list = await buildTodayList(
      deps([record("github:901", "2026-11-08T10:00:00.000Z", 0), record("github:902", "2026-11-09T10:00:00.000Z", 1)]),
    );

    expect(seen(list)).toEqual(RULE_ORDER);
  });

  it("放在第四位及以后不算置顶", async () => {
    const list = await buildTodayList(
      deps([record("github:901", "2026-11-16T10:00:00.000Z", 3), record("github:902", "2026-11-15T10:00:00.000Z", 4)]),
    );

    expect(seen(list)).toEqual(RULE_ORDER);
  });

  it("清除数据后加权消失：空记录就是没有学习这回事", async () => {
    // AC#5 在 seam 1 上的形状。「清除数据」这个动作归 #13 的自陈屏，这里断言的是它清完之后构建器该输出什么。
    const list = await buildTodayList(deps([]));

    expect(seen(list)).toEqual(RULE_ORDER);
  });
});

describe("seam 1 · 加权不跨档，分组认的是来源而不是平台", () => {
  /** 900 与 941 同在 github 这一家，但分属两个仓库：分组键取的是 URL 里的 `owner/repo`。 */
  function crossTierDeps(placements: readonly PlacementRecord[]) {
    return {
      providers: [createGithubLikeProvider(), createGiteeLikeProvider()],
      http: fakeHttp({
        github: {
          view: [
            { ...gh(900, "别家的逾期项", "2026-11-16T10:00:00Z"), html_url: "https://github.com/jing-gou/legacy-importer/issues/900", milestone: { due_on: "2026-11-16T18:00:00Z" } },
            gh(941, "老仓库的一条", "2026-11-14T10:00:00Z"),
          ],
        },
        gitee: { view: [ge(331, "另一家更新的一条", "2026-11-16T10:00:00Z")] },
      }),
      now: clock,
      scope,
      placements,
    };
  }

  const TWICE = [record("github:901", "2026-11-16T10:00:00.000Z", 0), record("github:902", "2026-11-15T10:00:00.000Z", 1)];

  it("连续置顶抬不动档位：命中的无截止项仍然排在逾期项之后", async () => {
    const list = await buildTodayList(crossTierDeps(TWICE));

    // 期望值手推：900 逾期独占第 0 档，加权只在档内说话，所以它仍在第 1。
    // 941 与 331 同档，且命中两次，于是压过更新时间更晚的 331——而 331 的来源一次都没被置顶。
    expect(list.entries.map((entry) => [entry.task.id, entry.reason, entry.learned])).toEqual([
      ["github:900", "overdue", undefined],
      ["github:941", "noDeadline", { group: { name: TRIAGE, hits: 2 }, hits: 2 }],
      ["gitee:jing-gou/legacy-importer#331", "noDeadline", undefined],
    ]);
  });

  it("同一家平台的另一个仓库不跟着沾光：分组键不是 providerId", async () => {
    // 两条记录记的是 legacy-importer 那个仓库（置顶过的别家），清单上被抬的却是 triage360 的 941 的话就错了。
    const list = await buildTodayList(crossTierDeps([
      record("github:901", "2026-11-16T10:00:00.000Z", 0, "jing-gou/legacy-importer"),
      record("github:902", "2026-11-15T10:00:00.000Z", 1, "jing-gou/legacy-importer"),
    ]));

    expect(list.entries.map((entry) => [entry.task.id, entry.learned])).toEqual([
      ["github:900", { group: { name: "jing-gou/legacy-importer", hits: 2 }, hits: 2 }],
      ["gitee:jing-gou/legacy-importer#331", { group: { name: "jing-gou/legacy-importer", hits: 2 }, hits: 2 }],
      ["github:941", undefined],
    ]);
  });
});

/**
 * 分组键的两种回落，都在 seam 1 上验：`sourceGroupOf` 是构建器内部的一步，
 * 但「同站另一条跟着沾光」「读不出主机时叫什么」是访客会看见的口径（AC#3 那句文案直接读它）。
 */
describe("seam 1 · 来源分组键的两种回落", () => {
  const JIRA_SITE = "sample-jira.atlassian.net";

  function jo(key: string, summary: string, updated: string) {
    return { id: `100${key}`, key, fields: { summary, status: { name: "Open" }, updated } };
  }

  it("没有仓库概念的平台按站点分组：置顶过一条，同站另一条也抬起来", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider(), createJiraLikeProvider()],
      http: fakeHttp({
        github: { view: [gh(941, "老仓库的一条", "2026-11-14T10:00:00Z")] },
        jira: { view: [jo("BR-1", "看板同步偶发漏项", "2026-11-13T10:00:00Z"), jo("BR-2", "导出缺时区", "2026-11-15T10:00:00Z")] },
      }),
      now: clock,
      scope,
      // 记录里那两个 id 这一轮都不在清单上：分组存下来了，所以照旧数得着。
      placements: [record("jira:100BR-9", "2026-11-16T10:00:00.000Z", 0, JIRA_SITE), record("jira:100BR-8", "2026-11-15T10:00:00.000Z", 1, JIRA_SITE)],
    });

    expect(list.entries.map((entry) => [entry.task.id, entry.learned])).toEqual([
      ["jira:100BR-2", { group: { name: JIRA_SITE, hits: 2 }, hits: 2 }],
      ["jira:100BR-1", { group: { name: JIRA_SITE, hits: 2 }, hits: 2 }],
      ["github:941", undefined],
    ]);
  });

  it("URL 读不出主机时分组叫平台标识", async () => {
    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: fakeHttp({ github: { view: [{ ...gh(943, "源站给了相对地址", "2026-11-16T10:00:00Z"), html_url: "/issues/943" }] } }),
      now: clock,
      scope,
      placements: [record("github:901", "2026-11-16T10:00:00.000Z", 0, "github"), record("github:902", "2026-11-15T10:00:00.000Z", 1, "github")],
    });

    expect(list.entries.map((entry) => [entry.task.id, entry.learned])).toEqual([
      ["github:943", { group: { name: "github", hits: 2 }, hits: 2 }],
    ]);
  });
});

describe("seam 1 · 学习闭环按标签加权（#36）", () => {
  it("同一标签被连续置顶后，带这个标签的条目在同档里排到更新的那条之前", async () => {
    const http = fakeHttp({
      github: {
        view: [
          labelled(951, "带 bug 的老条目", "2026-11-14T10:00:00Z", ["bug"]),
          labelled(952, "更新的普通条目", "2026-11-16T10:00:00Z", []),
        ],
      },
    });
    const placements = [
      record("github:901", "2026-11-16T10:00:00.000Z", 0, "other/repo", ["bug"]),
      record("github:902", "2026-11-15T10:00:00.000Z", 1, "other/repo", ["bug"]),
    ];

    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http,
      now: clock,
      scope,
      placements,
    });

    expect(list.entries.map((entry) => entry.task.id)).toEqual(["github:951", "github:952"]);
    expect(list.entries[0]?.learned).toEqual({ label: { name: "bug", hits: 2 }, hits: 2 });
    expect(list.entries[1]?.learned).toBeUndefined();
  });

  it("标签加权越不过档位：逾期条目仍然排在带标签的无截止条目之前", async () => {
    const http = fakeHttp({
      github: {
        view: [
          { ...labelled(961, "逾期的", "2026-11-15T10:00:00Z", []), milestone: { due_on: "2026-11-10T00:00:00Z" } },
          labelled(962, "带标签但没截止", "2026-11-16T10:00:00Z", ["bug"]),
        ],
      },
    });
    const placements = [
      record("github:901", "2026-11-16T10:00:00.000Z", 0, "other/repo", ["bug"]),
      record("github:902", "2026-11-15T10:00:00.000Z", 1, "other/repo", ["bug"]),
    ];

    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http,
      now: clock,
      scope,
      placements,
    });

    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      ["github:961", "overdue"],
      ["github:962", "noDeadline"],
    ]);
  });

  it("分组与标签同时命中时，一条 learned 里两个信号都在，强度取较大的那个", async () => {
    const http = fakeHttp({
      github: { view: [labelled(971, "同组同标签", "2026-11-14T10:00:00Z", ["bug"])] },
    });
    const placements = [
      record("github:901", "2026-11-16T10:00:00.000Z", 0, TRIAGE, ["bug"]),
      record("github:902", "2026-11-15T10:00:00.000Z", 1, TRIAGE, ["bug"]),
      record("github:903", "2026-11-15T09:00:00.000Z", 2, TRIAGE, ["bug"]),
    ];

    const list = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http,
      now: clock,
      scope,
      placements,
    });

    // 三次组命中与三次标签命中：两个维度都在，强度取 3。
    expect(list.entries[0]?.learned).toEqual({
      group: { name: TRIAGE, hits: 3 },
      label: { name: "bug", hits: 3 },
      hits: 3,
    });
  });
});
