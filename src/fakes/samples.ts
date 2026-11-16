import type { Http, Provider } from "../core/provider";
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
 * 三档理由里有两档就再也演示不出来。取当天 UTC 23:59，和 `ruleOf` 的 UTC 日界同一个口径。
 */
function demoDue(utcDaysFromToday: number): string {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + utcDaysFromToday);
  day.setUTCHours(23, 59, 59, 999);
  return day.toISOString();
}

/** GitHub 样例里各条的相对截止日；没登记的条目没有截止时间。 */
const DEMO_DUE_OFFSET: Record<number, number> = {
  1039: -1, // 整理提交材料 → 逾期
  1040: 0, // 写本周周报 → 今日到期
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
