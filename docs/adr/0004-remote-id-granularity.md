# ADR-0004 · 远端 id 的唯一性粒度由各 provider 自己决定

**决策**：任务 id 仍是 `providerId:remoteId`（`makeTaskId` / `remoteIdOf` 是唯一的编解码处），但 `remoteId` 的粒度由平台决定：GitHub 用 issue number，Jira 用全局 issue id，飞书用 task_guid，**Gitee 用 `owner/repo#number`**。

**原因**：Gitee 的 issue number 只在仓库内唯一，而「指派给我」要遍历仓库（官方没有跨仓库端点，见 `research/platform-limits-and-landing-form.md` 的 Gitee 节）。两个仓库的 313 号如果不带仓库名，会被 `search` 与 `getByIds` 认成同一条——跨平台合并（T05）会把它们合成一张卡，而按 id 刷新会取回错误的条目。仓库名从 issue 自己的 `html_url` 里取，因为列表响应不带仓库字段。

**被放弃的选项**：给 `Task` 加第七个字段 `repo`（把一家平台的粒度问题写进全局形状，`docs/PRD.md:101` 的界面与规划层只认归一化形状这条就破了）；用 Gitee 的全局 issue `id` 字段（该字段是否存在未实测，T15 真连时若实测可用可以换，代价是已落库的 id 全部对不上——所以 `previous` 里的 id 一旦写进存储就不该再造）。
