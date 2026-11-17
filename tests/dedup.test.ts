import { describe, expect, it } from "vitest";
import { buildTodayList, type SameEvent } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { fakeHttp } from "../src/fakes/fakeHttp";
import { createGiteeLikeProvider } from "../src/fakes/giteeLikeProvider";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T09:00:00+08:00");

/** 两家源站的原始形状字面量；不带 milestone 时档位全是同一档，顺序只由更新时间决定。 */
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
 * 12 条：两家各 6 条。登记的同一件事有两对：906「登录页 500」与 315「Login 接口偶发 500」是票面 AC#3
 * 前半句点名的那一对字面（措辞相似而不同），901「修复登录回调」与 313「回调地址改名后失效」差得更远，
 * 测的是接入点不随字面距离变化。902 与 314 完全同名而判定器说不是同一件事——那是 AC#3 的后半句。
 */
const GITHUB = [
  gh(901, "修复登录回调", "2026-11-16T10:00:00Z"),
  gh(902, "写本周周报", "2026-11-16T09:00:00Z"),
  gh(903, "整理提交材料", "2026-11-16T08:00:00Z"),
  gh(904, "补监控面板", "2026-11-16T07:00:00Z"),
  gh(905, "清理过期构建产物", "2026-11-16T06:00:00Z"),
  gh(906, "登录页 500", "2026-11-16T05:00:00Z"),
];

const GITEE = [
  ge(313, "回调地址改名后失效", "2026-11-16T11:00:00Z"),
  ge(314, "写本周周报", "2026-11-16T09:30:00Z"),
  ge(315, "Login 接口偶发 500", "2026-11-16T08:30:00Z"),
  ge(316, "催一下季度评审材料", "2026-11-16T07:30:00Z"),
  ge(317, "整理值班交接清单", "2026-11-16T06:30:00Z"),
  ge(318, "对接 3LO 回调", "2026-11-16T05:30:00Z"),
];

/**
 * 「是不是同一件事」的答案表——来源侧的 worked example，测试不重新推导它。
 * 判定器本身长什么样是语义匹配的事；这张卡要定的是判定器接入的位置与合并的结果形状。
 */
const SAME_EVENT: readonly [string, string][] = [
  ["github:901", "gitee:jing-gou/legacy-importer#313"],
  ["github:906", "gitee:jing-gou/legacy-importer#315"],
];

/** 把成对登记的答案变成判定器：除了查表，不做任何自己的判断。 */
function table(peers: readonly [string, string][]): SameEvent {
  return (a, b) => peers.some(([x, y]) => (a.id === x && b.id === y) || (a.id === y && b.id === x));
}

const sameEvent = table(SAME_EVENT);

function deps() {
  return {
    providers: [createGithubLikeProvider(), createGiteeLikeProvider()],
    http: fakeHttp({ github: { view: GITHUB }, gitee: { view: GITEE } }),
    now: clock,
    scope,
    sameEvent,
  };
}

describe("seam 1 · 跨平台重复项合并", () => {
  it("注入的判定器说两对是同一件事：12 条输入产出 10 张卡", async () => {
    const list = await buildTodayList(deps());

    expect(list.entries).toHaveLength(10);
  });

  it("措辞相似而不同的两条并成一张：卡片用表头的标题，来源仍是两条", async () => {
    const list = await buildTodayList(deps());

    // 票面 AC#3 前半句点名的字面对：GitHub 的「登录页 500」与 Gitee 的「Login 接口偶发 500」。
    // 标题一个字都不相同，构建器照并——判据来自注入，不来自字面比较（换成真判据时这里不动）。
    const card = list.entries.find((entry) => entry.task.id === "gitee:jing-gou/legacy-importer#315");

    expect(card?.task.title).toBe("Login 接口偶发 500");
    expect(card?.mergedFrom?.map((task) => task.id)).toEqual([
      "gitee:jing-gou/legacy-importer#315", // 表头：两条里最近更新的那条
      "github:906",
    ]);
  });

  it("合并卡带着全部来源，每个来源保留自己的链接", async () => {
    const list = await buildTodayList(deps());

    // 两张合并卡一起看：表头取这一组里最近更新的那条，所以 313（11:00）在 901（10:00）之前，
    // 315（08:30）在 906（05:00）之前；两条 url 都还在 mergedFrom 里，谁都没被丢掉。
    const merged = list.entries.filter((entry) => entry.mergedFrom !== undefined);
    expect(merged.map((entry) => entry.task.id)).toEqual([
      "gitee:jing-gou/legacy-importer#313",
      "gitee:jing-gou/legacy-importer#315",
    ]);
    expect(merged[0]?.mergedFrom?.map((task) => task.url)).toEqual([
      "https://gitee.com/jing-gou/legacy-importer/issues/313",
      "https://github.com/jing-gou/triage360/issues/901",
    ]);
    expect(merged[1]?.mergedFrom?.map((task) => task.url)).toEqual([
      "https://gitee.com/jing-gou/legacy-importer/issues/315",
      "https://github.com/jing-gou/triage360/issues/906",
    ]);
  });

  it("完全同名而判定器说不是同一件事：两张卡都在，谁都没被折掉", async () => {
    const list = await buildTodayList(deps());

    const weekly = list.entries.filter((entry) => entry.task.title === "写本周周报");
    expect(weekly.map((entry) => entry.task.id)).toEqual([
      "gitee:jing-gou/legacy-importer#314",
      "github:902",
    ]);
    // 构建器自己不拿标题当判据：注入的判据说不是同一件事，同名的两条就各自成卡。
    expect(weekly.every((entry) => entry.mergedFrom === undefined)).toBe(true);
  });

  it("没注入判定器时一家都不并：十二条输入还是十二张卡", async () => {
    const { sameEvent, ...withoutPredicate } = deps();

    const list = await buildTodayList(withoutPredicate);

    expect(list.entries).toHaveLength(12);
    expect(list.entries.every((entry) => entry.mergedFrom === undefined)).toBe(true);
  });

  it("providers 顺序与各家视图顺序都不参与决定：换先后，卡片与来源集合逐字相同", async () => {
    const flipped = {
      ...deps(),
      providers: [createGiteeLikeProvider(), createGithubLikeProvider()],
      http: fakeHttp({ github: { view: [...GITHUB].reverse() }, gitee: { view: [...GITEE].reverse() } }),
    };

    const both = [await buildTodayList(flipped), await buildTodayList(deps())];
    expect(both[0]?.entries).toEqual(both[1]?.entries);
    // 字面锚点：只把两次实跑互比，「两边一起坏」（比如表头选取换成了数组位置）照样绿。
    // 期望值按口径手推：同档内 updatedAt 新者在前，表头即该组最先出现的那条，组按出现顺序排。
    expect(both[1]?.entries.map((entry) => [entry.task.id, entry.mergedFrom?.length ?? 1])).toEqual([
      ["gitee:jing-gou/legacy-importer#313", 2], // 11:00，带着 github:901
      ["gitee:jing-gou/legacy-importer#314", 1],
      ["github:902", 1], // 与 314 同名而不同事，各自成卡
      ["gitee:jing-gou/legacy-importer#315", 2], // 08:30，带着 github:906
      ["github:903", 1],
      ["gitee:jing-gou/legacy-importer#316", 1],
      ["github:904", 1],
      ["gitee:jing-gou/legacy-importer#317", 1],
      ["github:905", 1],
      ["gitee:jing-gou/legacy-importer#318", 1],
    ]);
  });
});

describe("seam 1 · 合并后的档位", () => {
  // 同一件事的两条各站一档：GitHub 那条的截止时刻已经过去，Gitee 那条压根没写截止。
  function pairDeps() {
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
      sameEvent: table([["github:911", "gitee:jing-gou/legacy-importer#313"]]),
    };
  }

  it("并卡不把逾期折掉：表头站在这一组最紧急的那一档", async () => {
    const list = await buildTodayList(pairDeps());

    // 若先合并再打分、表头按「最近更新」取，这条会带着 313 的 noDeadline 顶掉 911 的逾期；
    // 而 313 恰好比 911 更有动静，那种写法在这份数据上是绿的假象。
    expect(list.entries.map((entry) => [entry.task.id, entry.reason])).toEqual([
      ["github:911", "overdue"],
      ["github:912", "noDeadline"],
    ]);
    expect(list.entries[0]?.mergedFrom?.map((task) => task.id)).toEqual([
      "github:911",
      "gitee:jing-gou/legacy-importer#313",
    ]);
  });
});
