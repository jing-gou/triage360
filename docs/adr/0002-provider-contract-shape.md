# ADR-0002 · 七法皆为方法，取数通道带响应头，按 id 一次批量取回

**决策**：`search` / `getByIds` / `normalize` / `doneStates` / `deletedStates` / `pollIntervalMs` / `scopeDescriptor` 全部是**方法**；注入的取数通道返回 `{ status, headers, body }`；`getByIds` 用**一次**请求取回整批 id。

**原因**：这是对本仓库 upstream 的显式偏离——`DECISIONS.md:48` 与 `docs/PRD.md:101` 把后四个记成属性，而 ticket #3 要求「七个方法都有可调用的形状」。后四项在 Jira / 飞书 上取决于项目状态映射与限流退避，做成静态属性会把它们钉死在 GitHub 的形状上；`scopeDescriptor` 还要吃 `scope`。`headers` 是 `X-OAuth-Scopes` 真值检测（`DECISIONS.md:177` 实测）唯一的读取通道，缺了它 T09 只能改契约。批量取回是 `DECISIONS.md:221` 推翻「按任务数估算轮询成本」之后的口径。

**被放弃的选项**：照 PRD 记法把后四个做成属性（更省，但 T09/T15 会逼着改回来）；`HttpResponse` 只带 `{ status, body }`（省一行，代价是把 scope 真值检测挤到第二个通道）。
