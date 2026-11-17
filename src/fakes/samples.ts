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
 * 三档理由里有两档就再也演示不出来。取的是访客本地的当天末尾——面板把本地偏移喂给了构建器，
 * 按 UTC 日造数会在本地下午打开时把「今日到期」演示成明天早上。
 */
function demoDue(daysFromToday: number): string {
  const day = new Date();
  day.setDate(day.getDate() + daysFromToday);
  day.setHours(23, 59, 59, 999);
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
