/**
 * 手动顺序与「说明已看过」这两个标记的落盘位置。
 *
 * 只存在这台浏览器的 localStorage：服务端没有它的副本，清空站点数据它就没了。
 * 存的是卡片标识（合并卡是表头 id）的次序而不是标题——id 跨轮次稳定，标题会被上游改掉（ADR-0004）。
 * 键名带版本：localStorage 活得比一次部署久，改形状时旧键要能认出来（Super Productivity 公开写明
 * 「重命名 id 会孤立所有用户已存的数据」，它的答案是别改；见 research/super-productivity-implementation.md
 * 第 8 条结论与「可借鉴点」表里「持久化 key 当不可变 API 对待」那一行）。
 */

const ORDER_KEY = "triage360:manual-order:v1";
const NOTICE_KEY = "triage360:order-notice:v1";

/** localStorage 在受限上下文里访问即抛，值还可能是用户手改过的任何东西：读的两端都在这一个 try 里。 */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写不进去最坏是下次打开回到规则序，不该让清单本身报错。 */
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 有意吞掉：这里没有比「保持原样」更好的动作。
  }
}

export function loadManualOrder(): string[] {
  try {
    const raw: unknown = JSON.parse(read(ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((one): one is string => typeof one === "string") : [];
  } catch {
    return [];
  }
}

export function saveManualOrder(ids: readonly string[]): void {
  write(ORDER_KEY, JSON.stringify(ids));
}

export function hasSeenOrderNotice(): boolean {
  return read(NOTICE_KEY) === "1";
}

export function markOrderNoticeSeen(): void {
  write(NOTICE_KEY, "1");
}
