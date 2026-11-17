import { describe, expect, it } from "vitest";
import { buildTodayList } from "../src/core/today-list";
import type { Scope } from "../src/core/provider";
import { createGithubLikeProvider } from "../src/fakes/githubLikeProvider";
import { createJiraLikeProvider } from "../src/fakes/jiraLikeProvider";
import { fakeHttp } from "../src/fakes/fakeHttp";

const scope: Scope = { assignee: "me" };
const clock = () => new Date("2026-11-17T01:00:00Z");

function list(http: ReturnType<typeof fakeHttp>) {
  return buildTodayList({ providers: [createGithubLikeProvider()], http, now: clock, scope });
}

/** 同一条用例里要换时钟、换数组顺序或换访客时区，所以把这些都留在参数上。 */
function at(iso: string, items: unknown[], extra: { zoneOffsetMinutes?: number } = {}) {
  return buildTodayList({
    providers: [createGithubLikeProvider()],
    http: fakeHttp({ github: { view: items } }),
    now: () => new Date(iso),
    scope,
    ...extra,
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
  // 这条用例刻意让逾期项三天没动、干扰项两小时半前才动：按 updatedAt 排必然反。
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

  // 「今日」在省略 `zoneOffsetMinutes` 时取 UTC 日历日同一天，不是「未来 24 小时内」：后一条只差 90 分钟，但已是下一个 UTC 日。
  // 按 24 小时窗口排，这两条的顺序会反过来（并列时按 id 破平，1801 在前）。
  it("省略偏移时日界是 UTC 日历日：同一天才算今日到期", async () => {
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
            issue(2404, "下周的评审", "2026-11-16T22:00:00Z", "2026-11-24T09:00:00Z"),
          ],
        },
      }),
      now: clock,
      scope,
    });

    expect(result.entries.map((entry) => [entry.task.title, entry.reason])).toEqual([
      ["补上过期审计日志", "overdue"],
      ["今天下班前交周报", "dueToday"],
      // 第三档是同一档、两个原因：一个压根没有截止，一个截止在更晚的那天。
      ["重构设置页", "noDeadline"],
      ["下周的评审", "dueLater"],
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

  // 上面那条只在同一家内部破平。T05 之后真正没人管的是跨家并列：四条来源同档同更新时间时，
  // 谁在前仍然只能由 id 决定，用的序是 `byCode`（UTF-16 码元序；同一语言环境下 localeCompare 也等于它，
  // 换个 locale 就不一定）。本条只钉「换数组顺序不改输出」：`github:` 与 `jira:` 在这段 ASCII 上
  // 两种序巧合相同，它分辨不了码位序与 ICU 之争，那件事的边界写在 byCode 注释里。
  it("跨 provider 的并列项也按 id 破平，与数组喂入顺序无关", async () => {
    const github = issue(2603, "GitHub 那条", "2026-11-16T10:00:00Z");
    const jira = {
      id: "10009",
      key: "TRI-9",
      self: "https://sample-jira.atlassian.net/rest/api/3/issue/10009",
      fields: { summary: "Jira 那条", status: { name: "To Do" }, updated: "2026-11-16T18:00:00.000+0800" },
    };
    const view = (jiraFirst: boolean) =>
      buildTodayList({
        providers: jiraFirst ? [createJiraLikeProvider(), createGithubLikeProvider()] : [createGithubLikeProvider(), createJiraLikeProvider()],
        http: fakeHttp({
          github: { view: [github] },
          jira: { view: [jira] },
        }),
        now: () => new Date("2026-11-17T01:00:00Z"),
        scope,
      });

    const expected = ["GitHub 那条", "Jira 那条"]; // `github:` 的 `g` 在 `jira:` 的 `j` 之前
    expect((await view(false)).entries.map((entry) => entry.task.title)).toEqual(expected);
    expect((await view(true)).entries.map((entry) => entry.task.title)).toEqual(expected);
  });

  // 「今日到期」也要能被时钟移进移出，否则 AC#1 只测到了逾期边界：这两次构建跨过的是 UTC 午夜。
  it("换时钟会把条目移出今日到期档", async () => {
    const tonight = issue(2503, "今晚截止", "2026-11-16T10:00:00Z", "2026-11-17T23:30:00Z");

    expect((await at("2026-11-16T12:00:00Z", [tonight])).entries.map((entry) => entry.reason)).toEqual(["dueLater"]);
    expect((await at("2026-11-17T12:00:00Z", [tonight])).entries.map((entry) => entry.reason)).toEqual(["dueToday"]);
  });

  // 注释与 ADR 都写着「时钟只取一次」，那得是可红的断言：逐项取时间的话，
  // 排在日界两侧的条目会随评估时刻漂档，而这条用例的两次构建会给出不同结果。
  it("一轮构建只读一次时钟", async () => {
    let ticks = 0;
    const result = await buildTodayList({
      providers: [createGithubLikeProvider()],
      http: fakeHttp({
        github: {
          view: [
            issue(2504, "今晚截止", "2026-11-16T10:00:00Z", "2026-11-17T23:30:00Z"),
            issue(2505, "明天早高峰", "2026-11-16T10:00:00Z", "2026-11-18T00:30:00Z"),
          ],
        },
      }),
      // 每次调用前进一小时：读第二次时钟的实现会把 2505 也算成今日到期。
      now: () => new Date(Date.parse("2026-11-17T23:00:00Z") + ticks++ * 3_600_000),
      scope,
    });

    expect(result.entries.map((entry) => entry.reason)).toEqual(["dueToday", "dueLater"]);
  });
});

describe("seam 1 · 打分只吃元数据", () => {
  // AC#3 要挡的是「顺手从正文里读点东西」：日期写在描述里、"已逾期" 这种字样、LLM 的措辞。
  // 所以干扰项刻意写成能骗过一个「在正文里找日期」的实现；顺序与理由都不许因此改变。
  // 理由还必须是八个键之外的那一个：`body` 不许被 normalize 带进任务里。
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

    // 期望值写成字面量：两组输入只差正文，所以它们必须落在同一份字面量上。
    // 只断言「两者相等」的话，实现整体错也照样绿——它挡不住「顺序由实现自己定义」。
    const expected = [
      ["中午交周报", "dueToday"],
      ["傍晚交发票", "noDeadline"],
    ];
    expect(plain.entries.map((entry) => [entry.task.title, entry.reason])).toEqual(expected);
    expect(withBodies.entries.map((entry) => [entry.task.title, entry.reason])).toEqual(expected);
    // 八键之外没有 `body`：正文不进任务，也就无处被打分读走。
    expect(withBodies.entries.map((entry) => Object.keys(entry.task).sort().join(","))).toEqual([
      "dueAt,duePrecision,id,providerId,state,title,updatedAt,url",
      "dueAt,duePrecision,id,providerId,state,title,updatedAt,url",
    ]);
  });
});

describe("seam 1 · 只写日期的截止", () => {
  // T03 把「日期形式（不含时刻）的 duedate 怎么折算成『几点算到期』」指名交给本票
  // （`tests/today-list.test.ts:123`）。它问的不是「几点」而是「哪一天」：源站写 `2026-11-17`
  // 说的是这天做完都算及时，所以比的是两个日历日，时间部分从头到尾不参与判断。
  it("那一天还没过完就算今日到期，不看时间部分", async () => {
    const result = await at("2026-11-17T12:00:00Z", [
      issue(2801, "周报只写了日期", "2026-11-16T09:00:00Z", "2026-11-17"),
    ]);

    expect(result.entries.map((entry) => [entry.task.title, entry.reason])).toEqual([
      ["周报只写了日期", "dueToday"],
    ]);

    // 折算出的 `dueAt` 是**那一天的起点**。日粒度自己用不到时间部分（只取前十个字符），
    // 但它是定稿八键之一，下一个消费者（#8 的措辞、界面打印日期）会照字面读它，
    // 所以锚点得钉在断言里，而不是只活在 `dueFrom` 的注释上。
    expect([result.entries[0]?.task.dueAt, result.entries[0]?.task.duePrecision]).toEqual([
      "2026-11-17T00:00:00.000Z",
      "day",
    ]);
  });

  it("那一天过完才逾期：日粒度不等某个时刻", async () => {
    const result = await at("2026-11-18T00:30:00Z", [
      issue(2802, "周报只写了日期", "2026-11-16T09:00:00Z", "2026-11-17"),
    ]);

    expect(result.entries.map((entry) => entry.reason)).toEqual(["overdue"]);
  });

  // 「是哪一天」得由**访客**的日历说了算：源站写 `2026-11-17` 说的是「11-17 这天做完」，
  // 而 11-17 对 +08 的访客是本地 00:00 → 23:59 那一段，不是 UTC 的那 24 小时。
  // 上一版的口径（折成 UTC 那一天的末尾再按访客日分档）会让这条在整个 +8 白天都是
  // dueLater、本地次日 08:00 一过直接跳 overdue——今日到期档对它永远不出现。
  // 面板每次都传偏移（`App.tsx`），所以钉的是面板真正走的那条口径。
  it("只写日期的截止落在访客写下的那一天：东八区本地中午算今日到期", async () => {
    const result = await at("2026-11-17T04:00:00Z", [issue(2803, "周报只写了日期", "2026-11-16T09:00:00Z", "2026-11-17")], {
      zoneOffsetMinutes: 480,
    });

    expect(result.entries.map((entry) => entry.reason)).toEqual(["dueToday"]);
  });

  it("按日粒度判逾期：访客过完那天就是逾期，不等 UTC 的 23:59", async () => {
    // 本地 11-18 00:30——访客的 11-17 已经过完。
    const east = await at("2026-11-17T16:30:00Z", [issue(2804, "周报只写了日期", "2026-11-16T09:00:00Z", "2026-11-17")], {
      zoneOffsetMinutes: 480,
    });
    expect(east.entries.map((entry) => entry.reason)).toEqual(["overdue"]);
  });

  it("西偏移同一条规则：本地那天没过完就还算今日到期", async () => {
    // 本地 −05:00 的 11-17 19:30——UTC 已是 11-18，但访客的 11-17 还没过完。
    const west = await at("2026-11-18T00:30:00Z", [issue(2805, "周报只写了日期", "2026-11-16T09:00:00Z", "2026-11-17")], {
      zoneOffsetMinutes: -300,
    });

    expect(west.entries.map((entry) => entry.reason)).toEqual(["dueToday"]);
  });

  it("非整小时偏移同一条规则：+05:45 的访客在那天 23:55 仍算今日到期", async () => {
    // 标量是分钟数，本来就没有「必须整小时」这一层；钉一条防止以后有人拿小时去除它。
    // `now` 必须落在 18:00Z–18:15Z：那是 +06:00 已过午夜、+05:45 还没有的 15 分钟。
    // 早先用 06:00Z 时两个偏移都还在 11-17，把 345 取整成 360 的变异全绿通过，等于没钉。
    const result = await at("2026-11-17T18:10:00Z", [issue(2807, "周报只写了日期", "2026-11-16T09:00:00Z", "2026-11-17")], {
      zoneOffsetMinutes: 345,
    });

    expect(result.entries.map((entry) => entry.reason)).toEqual(["dueToday"]);
  });

  // 带时刻的原值走的是另一条比较：先比瞬间、再比访客日历日，所以 `2026-11-17T23:59:59Z`
  // 在 +8 访客眼里是**本地 11-18 早上 07:59:59**，落到 dueLater 而不是 dueToday。
  // 日粒度只给「原值只有那 10 个字符」的截止，这条钉的是它不越界去接管带时刻的原值。
  it("带时刻的截止仍按瞬间比：午夜末尾的 `due_on` 在 +8 访客眼里是次日早上", async () => {
    const result = await at("2026-11-17T04:00:00Z", [
      issue(2806, "带时刻的评审", "2026-11-16T09:00:00Z", "2026-11-17T23:59:59.000Z"),
    ], { zoneOffsetMinutes: 480 });

    expect(result.entries.map((entry) => entry.reason)).toEqual(["dueLater"]);
  });
});

describe("seam 1 · 今日按访客的日历日", () => {
  // 面板是「早上打开看一眼」的东西：UTC+8 的访客在本地 11-17 凌晨两点看，
  // 当天中午截止的那条属于他的今天，却属于下一个 UTC 日。不喂时区，今日到期这一档在早上是空的。
  const localMorning = "2026-11-16T18:00:00Z"; // 本地 +08:00 = 11-17 02:00
  const dueLocalNoon = issue(2901, "本地明天中午的周报", "2026-11-16T09:00:00Z", "2026-11-17T04:00:00Z"); // 本地 11-17 12:00

  it("不注入偏移就还是 UTC 日界：那条属于下一个 UTC 日", async () => {
    expect((await at(localMorning, [dueLocalNoon])).entries.map((entry) => entry.reason)).toEqual(["dueLater"]);
  });

  it("注入 +08:00 后，访客本地的当天中午截止算今日到期", async () => {
    const result = await at(localMorning, [dueLocalNoon], { zoneOffsetMinutes: 480 });

    expect(result.entries.map((entry) => entry.reason)).toEqual(["dueToday"]);
  });

  it("逾期不看时区：截止瞬间过了就是过了", async () => {
    const late = issue(2902, "已经过点的评审", "2026-11-16T09:00:00Z", "2026-11-16T17:30:00Z");

    expect((await at(localMorning, [late], { zoneOffsetMinutes: 480 })).entries.map((e) => e.reason)).toEqual([
      "overdue",
    ]);
  });
});
