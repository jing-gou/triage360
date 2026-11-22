# ADR-0015 · Jira 3LO 只做内部自证，账本推进到 v3

**决策**：Jira 走服务端 Atlassian 3LO（`/auth/jira`、`/cb/jira`，以及已有会话经 `POST /api/auth-url` 的 `provider: "jira"` 挂接），权限只请求 `read:jira-work read:jira-user offline_access`。这条链路只用于维护者自证「授权 → 拉取 → 落库 → 轮换 → 撤销」真实可跑，面板不提供任何 Jira 连接入口，也不构建 Jira 卡片；Jira 在 UI 与对外文案里一律是样例数据。Atlassian app 保持 private，不开 sharing，不提交 Marketplace 审核。账本推进到 `version: 3`：`Tenant.jira` 保存加密的 access / refresh token、`expiresAt` / `lastRefreshAt`，以及 `cloudId` / `siteUrl` / `accountId` / `displayName`；`version: 1/2` 仍可读，加密与 `idHash` 边界沿用 ADR-0011。

`/api/items` 会把 Jira 的取数状态与原始条目一起返回给会话本人（面板忽略这两项），`connected` 增加 `jira`。租户是否该被整条删除的判据因此变成「GitHub / Gitee / Jira 三家都没有授权」；Jira 被上游 401 时只摘这一家。Jira 的懒刷新与 Gitee 共用 `decideCredentialAction`，刷新后的整对 token 走 `rotateCredential` + `putJira` 原子写回；in-flight 合并键是 `cloudId:accountId` 而不是会话或展示名。授权回调先取 `accessible-resources`，选第一个带 `read:jira-work` 的站点，再用该 token 请求 `/rest/api/3/myself` 取 `accountId` 核对账号；同一会话换 Atlassian 账号会被拒绝。服务端日志只记 `[cb/jira] session created` / `[jira] fetched N items` / `[jira] refresh committed (rotated=…)`，不记 code、token 与身份。

**原因**：Atlassian 规定 app 只能访问已安装它的站点，且用户在 consent 屏必须选站点；目标用户几乎必然没有自己的 Jira Cloud 站点。把 Jira 做成面板可连，等于对用户承诺一件多数人做不到的事。真连仍然值得保留：它是 provider 契约、轮换原子替换与账本形状在真实第三方 API 上的证据，只是这条证据留在维护者手里，不变成产品承诺。`accountId` 是 Atlassian 侧稳定身份，展示名会改、也会重名；`cloudId` 是网关路由的一部分，必须与 token 一起存。refresh token 每次轮换都会作废旧的一枚，所以两个并发请求不能各换一次，in-flight 必须按授权归属合并。

**被放弃的选项**：把 Jira 接进面板 provider 列表——会直接违反「UI 不声称用户能连 Jira」；把 Jira 放进公开演示快照——演示账号不该承载内部 Jira 数据，也会把「样例」说成真连；前端直连 3LO——Atlassian 无 implicit flow，换 token 需要 `client_secret`；不做落库、每次重新授权——无法验证轮换与撤销；为 Jira 单独做一套刷新状态机——`decideCredentialAction` 已经覆盖同一形状，另写一套只会分叉。

**已知缺口，刻意留着**：真实轮换证据要等 access token 过期（默认 60 分钟）后由懒刷新触发，测试不伪造这一步；自证时用服务端日志与 `store.json` 密文变化对照，不打印 token。多站点授权只取第一个带 `read:jira-work` 的站点，没有站点选择 UI——内部自证不需要。Jira 不进演示快照与面板，因此访客在任何页面都看不到 Jira 卡或「连接 Jira」按钮。若 #19 的真实闭环没有走通，对外文案里的「已跑通真实 3LO 接入」必须删掉，这条 ADR 不构成证据本身。