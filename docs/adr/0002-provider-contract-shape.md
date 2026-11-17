# ADR-0002 · 七法皆为方法，取数通道带响应头，按 id 批量取回一次（调用次数，不是请求数）

**决策**：`search` / `getByIds` / `normalize` / `doneStates` / `deletedStates` / `pollIntervalMs` / `scopeDescriptor` 全部是**方法**；注入的取数通道返回 `{ status, headers, body }`；`getByIds` 每轮只被**调用一次**，整批 id 一起交给它。**HTTP 请求数不在契约里**：有批量端点的平台一次取回整批，没有的平台逐条取回（Gitee、飞书与真连后的 GitHub 见 ADR-0004）。

**原因**：这是对本仓库 upstream 的显式偏离——`DECISIONS.md:48` 与 `docs/PRD.md:101` 把后四个记成属性，而 ticket #3 要求「七个方法都有可调用的形状」。后四项在 Jira / 飞书 上取决于项目状态映射与限流退避，做成静态属性会把它们钉死在 GitHub 的形状上；`scopeDescriptor` 还要吃 `scope`。`headers` 是 `X-OAuth-Scopes` 真值检测（`DECISIONS.md:177` 实测）唯一的读取通道，缺了它 T09 只能改契约。批量取回是 `DECISIONS.md:221` 推翻「按任务数估算轮询成本」之后的口径，而那条口径来自 Super Productivity 的**调用次数**语义（每轮把 id 集合交出去一次）；把它读成「一次 HTTP 请求」会在没有批量端点的平台上变成假话。Q31 决定不做节流，所以多出来的请求数直接落在 429 概率上，由各平台真连时（T09 / T15）按实测承担。

**被放弃的选项**：照 PRD 记法把后四个做成属性（更省，但 T09/T15 会逼着改回来）；`HttpResponse` 只带 `{ status, body }`（省一行，代价是把 scope 真值检测挤到第二个通道）；把「一次 HTTP 请求」钉进契约（GitHub / Jira 做得到，Gitee / 飞书 做不到，于是这两家要么撒谎要么得破契约）。
