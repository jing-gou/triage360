import type { Http, Provider } from "../core/provider";
import type { SameEvent } from "../core/today-list";
import { createFeishuSampleProvider, SAMPLE_FEISHU_TASKS } from "./feishuLikeProvider";
import { fakeHttp } from "./fakeHttp";
import { createGiteeLikeProvider, SAMPLE_GITEE_ISSUES } from "./giteeLikeProvider";
import { createGithubLikeProvider, FIXTURE_ISSUES } from "./githubLikeProvider";
import { createJiraLikeProvider, SAMPLE_JIRA_ISSUES } from "./jiraLikeProvider";

/**
 * 四个来源的默认演示接线：界面与 seam 1 之外的代码只从这里取 provider 和取数通道。
 * 四条都还是替身——真连分别在 T09（GitHub）、T15（Gitee）顶替，Jira 与飞书永远是样例。
 */
export function createSampleProviders(): Provider[] {
  return [
    createGithubLikeProvider(),
    createGiteeLikeProvider(),
    createJiraLikeProvider(),
    createFeishuSampleProvider(),
  ];
}

/**
 * 样例卡的截止日按「打开面板这一天」算：写死日期会在展示那天全部变成逾期，
 * 三档理由里有两档就再也演示不出来。取的是访客本地的当天末尾——面板把本地偏移喂给了构建器，
 * 按 UTC 日造数会在本地下午打开时把「今日到期」演示成明天早上。
 */
function demoDue(daysFromToday: number): string {
  const day = new Date();
  day.setDate(day.getDate() + daysFromToday);
  day.setHours(23, 59, 59, 999);
  return day.toISOString();
}

/**
 * 演示用判定表：登记「这两条是同一件事」，供界面在 #18 之前就把合并后的画面演一遍。
 * 这张表的存在不等于「会不会判断同一件事」已经有了答案——真实判据（标题相似度、链接引用、
 * 最近打开时间）是 #18 要买的东西，届时替换的只是这里登记的判据，接入点与结果形状都不动。
 * 登记的是 GitHub 的 1041「修复登录回调」与 Gitee 的 313「回调地址改名后失效」：一个事件在两家的两条记录，
 * 不是同一串字面——`DECISIONS.md:83` 要的就是「措辞相似而不同，完全同名反而像 bug」。
 * 它举的那一对（「登录页 500」vs「Login 接口偶发 500」）在演示数据里只有 Gitee 半边
 * （`giteeLikeProvider.ts` 的 140），GitHub 侧没有对应条目，所以画面演的是上面这一对；
 * 票面那一对的字面在 seam 测试里跑过（`tests/dedup.test.ts`）。
 */
const DEMO_SAME_EVENT: readonly [string, string][] = [["github:1041", "gitee:jing-gou/triage360#313"]];

export const demoSameEvent: SameEvent = (a, b) =>
  DEMO_SAME_EVENT.some(([x, y]) => (a.id === x && b.id === y) || (a.id === y && b.id === x));

/**
 * GitHub 样例里各条的相对截止日；没登记的条目没有截止时间。
 * 1041 也给今天：它是合并卡的 GitHub 那一侧，另一侧（Gitee 313）压根没写截止，
 * 合并后这张卡仍站在「今日到期」——第三档的卡片排在八张之后，评审时正好看不到合并的价值。
 * 加上 1040，样例里就是 `DECISIONS.md:81` 写的那「1 逾期 + 2 今日到期」。
 */
const DEMO_DUE_OFFSET: Record<number, number> = {
  1039: -1, // 整理提交材料 → 逾期
  1040: 0, // 写本周周报 → 今日到期
  1041: 0, // 修复登录回调 → 今日到期（与 Gitee 313 合成一张卡）
};

export const sampleHttp: Http = fakeHttp({
  github: {
    view: FIXTURE_ISSUES.map((issue) => {
      const offset = DEMO_DUE_OFFSET[issue.number];
      return offset === undefined ? issue : { ...issue, milestone: { due_on: demoDue(offset) } };
    }),
  },
  gitee: { view: SAMPLE_GITEE_ISSUES },
  jira: { view: SAMPLE_JIRA_ISSUES },
  feishu: { view: SAMPLE_FEISHU_TASKS },
});
