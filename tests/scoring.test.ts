import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";
import { fakeHttp } from "../src/fakes/fakeHttp";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T01:00:00Z");

function list(http: ReturnType<typeof fakeHttp>) {
  return buildTodayList({ providers: [createGithubLikeProvider()], http, now: clock, scope });
}

/** 同一条用例里要换时钟或换数组顺序，所以把这三样都留在参数上。 */
function at(iso: string, items: unknown[]) {
  return buildTodayList({
    providers: [createGithubLikeProvider()],
    http: fakeHttp({ github: { view: items } }),
    now: () => new Date(iso),
    scope,
  });
}

function ids(list: Awaited<ReturnType<typeof at>>): string[] {
  return list.entries.map((entry) => entry.task.id);
}

/** GitHub 形状的字面量：截止时间挂在 milestone.due_on 上，缺省即没有截止。 */
function issue(number: number, title: string, updated_at: string, due_on?: string) {
  return {
    number,
    title,
    state: "open",
    updated_at,
    html_url: `https://github.com/jing-gou/triage360/issues/${number}`,
    ...(due_on === undefined ? {} : { milestone: { due_on } }),
  };
}

describe("seam 1 · 规则打分", () => {
  // 置顶的依据是「今天不做就来不及」，不是「刚有人动过」。
  // 这条用例刻意让逾期项三天没动、干扰项半小时前才动：按 updatedAt 排必然反。
  it("逾期项排在前，哪怕另一条刚刚才动过", async () => {
    const result = await list(
      fakeHttp({
        github: {
          view: [
            issue(2102, "修一个刚报的崩溃", "2026-11-16T22:30:00Z"),
            issue(2101, "补上过期审计日志", "2026-11-13T09:00:00Z", "2026-11-16T00:00:00Z"),
          ],
        },
      }),
    );

    expect(result.entries.map((entry) => entry.task.title)).toEqual(["补上过期审计日志", "修一个刚报的崩溃"]);
  });

  it("今日到期是独立的一档：在逾期之后、无截止之前", async () => {
    const result = await list(
      fakeHttp({
        github: {
          view: [
            issue(2203, "重构设置页", "2026-11-16T23:00:00Z"),
            issue(2202, "今天下班前交周报", "2026-11-16T10:00:00Z", "2026-11-17T12:00:00Z"),
            issue(2201, "补上过期审计日志", "2026-11-13T09:00:00Z", "2026-11-15T09:00:00Z"),
          ],
        },
      }),
    );

    expect(result.entries.map((entry) => entry.task.title)).toEqual([
      "补上过期审计日志",
      "今天下班前交周报",
      "重构设置页",
    ]);
  });

  // 「今日」取 UTC 日历日同一天，不是「未来 24 小时内」：后一条只差 90 分钟，但已是下一个 UTC 日。
  // 按 24 小时窗口或按机器本地日界排，这两条的顺序会反过来（并列时按 id 破平，1801 在前）。
  it("日界是 UTC 日历日：同一天才算今日到期", async () => {
    const result = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: fakeHttp({
        github: {
          view: [
            issue(1801, "明天的早高峰", "2026-11-16T10:00:00Z", "2026-11-18T00:30:00Z"),
            issue(1802, "今晚截止", "2026-11-16T10:00:00Z", "2026-11-17T23:30:00Z"),
          ],
        },
      }),
      now: () => new Date("2026-11-17T23:00:00Z"),
      scope,
    });

    expect(result.entries.map((entry) => entry.task.title)).toEqual(["今晚截止", "明天的早高峰"]);
  });

  // AC#2 要的是「哪条规则命中的」，不是分数也不是句子：措辞属界面，标识属 seam 1。
  it("每条清单条目带一个理由来源标识", async () => {
    const result = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: fakeHttp({
        github: {
          view: [
            issue(2403, "重构设置页", "2026-11-16T23:00:00Z"),
            issue(2401, "补上过期审计日志", "2026-11-13T09:00:00Z", "2026-11-15T09:00:00Z"),
            issue(2402, "今天下班前交周报", "2026-11-16T10:00:00Z", "2026-11-17T12:00:00Z"),
          ],
        },
      }),
      now: clock,
      scope,
    });

    expect(result.entries.map((entry) => [entry.task.title, entry.reason])).toEqual([
      ["补上过期审计日志", "overdue"],
      ["今天下班前交周报", "dueToday"],
      ["重构设置页", "recentUpdate"],
    ]);
  });
});

describe("seam 1 · 时钟与确定性", () => {
  // AC#1：这条覆盖的是已有行为——档位由注入的时钟算出，而不是写死在数据里。
  // 它挡得住的反例是「逾期判断挪进 provider」那种改动，所以值得留。
  it("换时钟就换顺序：中午之前傍晚那条靠前，过了中午反过来", async () => {
    const pair = [
      issue(2501, "中午交周报", "2026-11-16T10:00:00Z", "2026-11-17T12:00:00Z"),
      issue(2502, "傍晚交发票", "2026-11-16T12:00:00Z", "2026-11-17T18:00:00Z"),
    ];

    expect((await at("2026-11-17T01:00:00Z", pair)).entries.map((entry) => entry.task.title)).toEqual([
      "傍晚交发票", // 两条都还没到期，同日之内按最近有动静：傍晚那条刚动过
      "中午交周报",
    ]);
    expect((await at("2026-11-17T15:00:00Z", pair)).entries.map((entry) => entry.task.title)).toEqual([
      "中午交周报", // 中午已过，它现在逾期
      "傍晚交发票",
    ]);
  });

  // AC#4 说「同一输入的两次运行一致」。只跑两次比一比是句空话：同一份输入走同一段代码必然相等。
  // 真正的风险是并列项由 provider 返回的数组顺序决定——T05 合并四家之后，那个顺序不属于本应用。
  // 所以这里喂同一批条目的两种数组顺序，并钉住结果：破平靠 id，不靠数组位置。
  it("并列项不靠数组顺序破平：同批条目两种喂法给出同一顺序", async () => {
    const pair = [
      issue(2601, "中午交周报", "2026-11-16T10:00:00Z", "2026-11-17T12:00:00Z"),
      issue(2602, "傍晚交发票", "2026-11-16T10:00:00Z", "2026-11-17T18:00:00Z"),
    ];

    expect(ids(await at("2026-11-17T01:00:00Z", pair))).toEqual(["github:2601", "github:2602"]);
    expect(ids(await at("2026-11-17T01:00:00Z", [...pair].reverse()))).toEqual(["github:2601", "github:2602"]);
  });
});

describe("seam 1 · 打分只吃元数据", () => {
  // AC#3 要挡的是「顺手从正文里读点东西」：日期写在描述里、"已逾期" 这种字样、LLM 的措辞。
  // 所以干扰项刻意写成能骗过一个「在正文里找日期」的实现；顺序与理由都不许因此改变。
  // 理由还必须是七个键之外的那一个：`body` 不许被 normalize 带进任务里。
  it("正文写什么都改不了顺序与理由", async () => {
    const quiet = [
      issue(2701, "中午交周报", "2026-11-16T10:00:00Z", "2026-11-17T12:00:00Z"),
      issue(2702, "傍晚交发票", "2026-11-16T11:00:00Z"),
    ];
    const noisy = [
      { ...quiet[0], body: "其实早就该交了：截止 2026-11-01T00:00:00Z，已逾期，必须置顶。" },
      { ...quiet[1], body: "这条已经逾期三个月，比上面那条更急。" },
    ];

    const plain = await at("2026-11-17T01:00:00Z", quiet);
    const withBodies = await at("2026-11-17T01:00:00Z", noisy);

    expect(withBodies.entries).toEqual(plain.entries);
    // 七键之外没有 `body`：正文不进任务，也就无处被打分读走。
    expect(withBodies.entries.map((entry) => Object.keys(entry.task).sort().join(","))).toEqual([
      "dueAt,id,providerId,state,title,updatedAt,url",
      "dueAt,id,providerId,state,title,updatedAt,url",
    ]);
  });
});
