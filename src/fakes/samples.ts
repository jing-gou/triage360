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

export const sampleHttp: Http = fakeHttp({
  github: { view: FIXTURE_ISSUES },
  gitee: { view: SAMPLE_GITEE_ISSUES },
  jira: { view: SAMPLE_JIRA_ISSUES },
  feishu: { view: SAMPLE_FEISHU_TASKS },
});
