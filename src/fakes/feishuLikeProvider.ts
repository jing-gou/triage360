import { makeTaskId, remoteIdOf, uniformAuth, labelNames, type Provider, type RawItem, type Task } from "../core/provider";

/**
 * 样例 provider：飞书在 v1 只做第四张样例卡，零真连代码（`docs/PRD.md` 的真实程度表）。
 * 下面的形状是**示意**、未实测——它要证明的只有一件事：七法契约容得下一个平台完成态是布尔值、
 * 且没有按 id 批量端点。真连接入需要企业自建应用，所以界面上这张卡必须写明样例数据。
 */

const API = "https://open.feishu.cn";
const PROVIDER_ID = "feishu";

interface FeishuTask {
  task_id: string;
  summary: string;
  done: boolean;
  updated_at: string;
}

/** 布尔完成态折成状态字面量：契约里只有 `state: string`，不为某一家开特例。 */
function stateOf(task: FeishuTask): string {
  return task.done ? "done" : "open";
}

export function createFeishuSampleProvider(): Provider {
  return {
    id: PROVIDER_ID,

    async search(_scope, http) {
      const res = await http(`${API}/open-apis/task/v2/tasks?page_size=50`);
      return (res.body as { data: { items: RawItem[] } }).data.items;
    },

    // 同样没有批量端点：一个 id 一次请求，404 表示这条源站已经没有了。
    async getByIds(ids, http) {
      const raws = await Promise.all(
        ids.map(async (id) => {
          const res = await http(`${API}/open-apis/task/v2/tasks/${remoteIdOf(id)}`);
          if (res.status === 404) return [] as RawItem[];
          return [res.body as RawItem] as RawItem[];
        }),
      );
      return raws.flat();
    },

    normalize(raw): Task {
      const task = raw as unknown as FeishuTask;
      return {
        id: makeTaskId(PROVIDER_ID, task.task_id),
        providerId: PROVIDER_ID,
        title: task.summary,
        url: `https://applink.feishu.cn/client/todo/detail?guid=${task.task_id}`,
        state: stateOf(task),
        updatedAt: new Date(task.updated_at).toISOString(),
        // 飞书 v1 零真连代码，截止时间没有一手依据；键照样写出来，与另外三家同一形状。
        dueAt: undefined,
        duePrecision: undefined,
      };
    },

    labels(raw) {
      return labelNames((raw as { labels?: unknown }).labels);
    },

    doneStates() {
      return ["done"];
    },

    deletedStates() {
      return [];
    },

    // 占位数字：Q6 只定了「可见标签页轮询 + 手动 refresh」，间隔本身还没决策。
    pollIntervalMs() {
      return 60_000;
    },

    scopeDescriptor(scope) {
      return uniformAuth(`样例数据 · 指派给 ${scope.assignee}`);
    },
  };
}

export const SAMPLE_FEISHU_TASKS: FeishuTask[] = [
  {
    task_id: "feishu-task-9",
    summary: "催一下季度评审材料",
    done: false,
    updated_at: "2026-11-16T13:10:00+08:00",
  },
  {
    task_id: "feishu-task-12",
    summary: "整理值班交接清单",
    done: true,
    updated_at: "2026-11-16T10:05:00+08:00",
  },
];
