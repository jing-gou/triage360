/**
 * 手动顺序与「说明已看过」这两个标记的落盘位置。
 *
 * 只存在这台浏览器的 localStorage：服务端没有它的副本，清空站点数据它就没了。
 * 存的是卡片标识（合并卡是表头 id）的次序而不是标题——id 跨轮次稳定（provider.ts:76-78），标题会被上游改掉。
 * 读写都要挡：localStorage 在受限上下文里访问即抛，值可能是用户手改过的任何 JSON。
 */

const ORDER_KEY = "triage360:manual-order:v1";
const NOTICE_KEY = "triage360:order-notice:v1";

export function loadManualOrder(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return [];
  }
}

export function saveManualOrder(ids: readonly string[]): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  } catch {
    // 写不进去就只是下次打开回到规则序：不该让清单本身报错。
  }
}

export function hasSeenOrderNotice(): boolean {
  try {
    return localStorage.getItem(NOTICE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOrderNoticeSeen(): void {
  try {
    localStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // 同上：标记丢了最坏是多看一次弹窗。
  }
}
