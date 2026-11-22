---
question: 个人跨平台任务聚合面板（gitee / github / 飞书 / jira）初步落地为 Web，用 Qoder Sites 部署 —— 各平台接入限制与落地形态限制
date: 2026-11-16
method: 仅采用一手来源（各平台官方开发者文档、官方仓库 README/源码、官方帮助中心、Qoder 官方文档与产品接口契约）；搜索引擎仅用于定位官方页面，二手内容不作为结论依据
status: 主结论已核实。仍未取到一手：Gitee 量化 API 配额与 notifications 返回字段、Qoder Sites 函数运行时/出网/定时能力、GitLab.com 默认配额数值、Jira points 单价目录 —— 均列入「待核实」并给出实测配方
related: [personal-cross-platform-issue-dashboard.md, super-productivity-implementation.md]
---

# 平台接入限制 & Qoder Sites 落地形态限制

## 结论摘要（TL;DR）

1. **四个平台都能走「每个用户自己授权、服务端保管 refresh token」的 OAuth 模型**，但不存在「一个集中式应用凭据读所有人数据」的合规路径。产品形态必须是 per-user 3LO（three-legged OAuth），这决定了站点必须有服务端（token 交换与存储）而不是纯静态。
2. **三个可能在早期就卡住立项的硬限制**：
   - 飞书：**企业自建应用只允许本租户内部使用**，面向公众提供服务必须开发商店应用并「联系平台工作人员提交审核」，之后还要按 `app_id + tenant_key` 换取 `tenant_access_token`（自建应用没有 `tenant_key`，`app_ticket` 每小时更新）。→ 个人 SaaS 路线 = ISV 入驻 + 平台审核，不是「注册个应用就能上线」。([飞书任务 v2 概述](https://open.feishu.cn/document/server-docs/task/v2/overview))
   - Atlassian：官方明确写「**收集用户 API token、或让客户自建 3LO 应用不符合安全要求与可接受使用政策**」，所以「让用户填 PAT/Jira token」这条路是被政策禁止的；必须做成可分发的 3LO 应用（默认 private，需手动开启共享/审核）。并且自 **2026-03-02** 起，Jira Cloud 对 Forge/Connect/2LO/3LO 强制执行 points 配额，默认 **Tier 1 – Global Pool：官方原话「Your app shares a single 65,000 point hourly quota across all tenants」——这是「你的 App 跨全部客户租户共享的一整个池子」，不是每租户一份**；官方写明**不能按需提额**，只有经 Atlassian 审核、用量高度集中的 App 才会被分到 Tier 2 – Per-Tenant Pool。([3LO 文档](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)、[速率限制](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/))
   - Qoder Sites：**个人 Free 计划只支持静态站点部署，不支持数据库和存储服务**；Teams/Enterprise 计划的站点**不支持公开访问与组织外共享**。→ 要存每个用户的 token，必须至少用个人付费计划，并且面向非 Qoder 用户开放时要选 public。([Qoder Sites 文档](https://docs.qoder.com/qoder/sites))
3. **Gitee 是四个平台里能力最弱的一环**：官方 MCP 服务器（`https://api.gitee.com/mcp`，个人令牌鉴权）暴露的 Issue 工具只有**仓库级** `list_repo_issues` / `create_issue` / `update_issue` / `get_repo_issue_detail` 加 `list_user_notifications`，**没有「跨仓库、分配给我的 Issue」工具**；且官方文档**没有公开量化调用频率/配额**，只有使用条款的「请求频率过快将导致请求终止」。（见 [Gitee 官方 mcp-gitee README](https://gitee.com/oschina/mcp-gitee)）
   - **更正（2026-11-22，一手：Gitee OpenAPI v5 Swagger）**：上面这条只对**官方 MCP 工具表**成立。REST v5 有跨仓库端点 `GET /api/v5/user/issues?filter=assigned&state=open|progressing|closed|rejected&sort=updated&per_page=100`（Swagger 的 `user_issues` 定义，`state` 枚举同时含 `all`；未认证返回 401）⇒ provider 不需要遍历仓库或消费通知流。该端点已按响应形状写入 `src/providers/gitee.ts` 并用假数据测试，**尚未用真 token 跑过**。
   - **补充（本轮新增核实）**：产品层面 assign **确实会产生站内信**——官方帮助中心的事件表写明「有新的任务指派给我 → 站内信 / 邮件」「有新的 PR 指派给我 → 站内信 / 邮件」；但同一页面写明渠道与「是否通知到用户」由用户在**设置 → 基本设置 → 通知设置**自行开关，所以通知流**不能作为唯一数据源**。API 层面 `list_user_notifications` 是否携带可判定「指派」的字段仍未核实，已给出 1 分钟实测配方。（[消息通知设置](https://help.gitee.com/account/notification-settings)）
4. 落地形态上最容易被忽略的一点：Qoder Sites 的站点地址是「**可编辑前缀 + 固定后缀**」，官方文档**未提供自定义域名入口**；同时文档与接口契约里**没有任何定时/计划任务能力**，所以「每 10 分钟自动拉」不能由站点自己触发，只能是「打开即拉 + 手动 refresh」或把调度放到站点外。GitHub OAuth App、GitLab 应用、飞书安全域名、Atlassian 回调都要把这个地址写死，**改名会直接让所有已注册回调失效**；站点如果是 `private/selected`，访客还必须先用 Qoder 账号登录。
5. **按「每 10 分钟一轮」算预算，真正的天花板不是 GitHub，而是飞书的租户月度池和 Atlassian 的 Global Pool**：每用户每月约 4,320 轮，飞书 1-3 次/轮（会计入「单租户所有自建应用合计」的月池）≈ 4,320-12,960 次/月/用户，对基础免费版的 100 万限时值意味着约 77-231 个用户/租户，而该 100 万本身是**限时政策**（历史值 1 万/月）；Jira 侧 65,000 points/小时是**你的 App 跨全部客户共享的一整个池**，按每轮 10-50 points 估约 217-1,083 个并发轮询用户即打满。GitHub 5,000/小时（按用户）在这个量级下完全够用。详见「轮询成本模型」。

---

## 落地形态限制：Qoder Sites

一手依据：[Sites（Qoder 文档）](https://docs.qoder.com/qoder/sites)、[Sites: Build and Host Websites（CLI）](https://docs.qoder.com/cli/sites)、以及 Qoder Sites 平台接口的参数契约（`prepare_site` / `update_access_policy`）。

| 维度 | 官方事实（一手） | 对本项目的含义 |
|---|---|---|
| 可用范围 | Availability 覆盖个人版（Free/Lite/Pro/Pro+/Ultra）与团队版（Teams/Enterprise）。原话：**「The individual Free plan supports static website deployment only; database and storage services are not supported.」** | token 存储/后端只能在付费个人计划上做；Free 只能做 demo 静态页 |
| 计费与用量 | **「Sites is free for a limited time at launch, with usage limits. Reaching a limit may temporarily restrict creating sites or public access to sites with high usage.」** 用量按账号下所有站点累计，限额在免费期内可能调整 | 高用量用户可能触发「公开访问被临时限制」，对 SaaS 是稳定性风险 |
| 托管内容形态 | 接口参数要求 `webDirectory` = **「Relative built output directory, never source root」**；可选 `spa`；可选 `functionDirectory` = **「Optional relative server function directory with index.ts」** | 是「静态产物 + 单一服务端函数入口」模型，不是任意容器/长驻服务；无框架自由部署 |
| **定时/后台任务** | 官方文档与 CLI 文档、接口契约中**均未出现** scheduled function / cron / 定时触发 能力（只有 visitors 交互触发的 Agent 任务与函数调用） | 「每 10 分钟自动拉一次」**不能由站点自己触发**。三选一：① 前端打开时拉 + 页面内 `setInterval`（关掉页面即停）；② 只做手动 refresh 按钮；③ 调度器放到站点外（独立服务器/自己的 cron），代价是 Sites 只剩展示层 |
| 数据与密钥 | `databaseAccess` 枚举 `none/read_only/read_write`，且说明 **「Non-none requires a Function」**，新草稿需从 `get_database_schema` 取同项目 `schemaRef`；`secretNames` 说明 **「At most 100 application Secret names; values must not be included」**；CLI 文档：Secrets「**values are write-only and can never be read back**」 | 可以存 refresh token（走 DB + Secrets），但密钥上限 100、不可回读，数据库必须绑定 Function |
| 访问策略 | 站点可见性：个人计划三档（仅自己 / 受邀 / 任何人，public 需确认）；Teams/Enterprise 为仅自己 / 受邀（须同组织）/ 组织成员，**「Sharing with people outside the organization and public access are not supported.」** 接口 mode 枚举：`private/selected/public/organization`，public 需 `confirmPublic=true` | 面向公开展业用户 = 必须个人付费计划 + public；企业内网版无法公开分发 |
| 域名/回调地址 | 文档：「Open **More → Settings → General** to change the site name or **address prefix**. The address editor separates the editable part from the fixed suffix.」；接口 `subdomain`：**「New sites only: explicit raw address prefix, without hostname or owner suffix」** | OAuth 回调只能用平台分配域名；改前缀会使四家平台已登记的回调全部失效，需在应用注册文档里写死并冻结命名 |
| 登录态 | **「Visitors to restricted sites must sign in with a Qoder account that has permission. Forwarding a link does not grant access.」** | 若走 private/selected，四家 OAuth 授权跳转回来时用户身份是 Qoder 账号，可作为 per-user token 的归属键；走 public 则需自己做站内账号 |
| 发布与更新 | **「The preview and published version are separate. A chat edit or new preview does not automatically replace live content.」** | 有 draft/published 两态，无灰度/回滚承诺；变更即整体替换 |
| 合规标识 | **「To comply with China's Measures for Labeling AI-Generated and Synthetic Content, AI-generated content labels on sites cannot be removed.」**（引 CAC 办法第十条） | 页面必须保留 AI 生成内容标识，影响 UI；国内访问侧内容合规需自行评估 |
| 其它运维 | 支持暂停/恢复/删除（删除不可逆）、PV/UV 分析（可标注 Not collected）、每目录一个活动站点描述符 `.qoder.site`、描述符不可跨主机迁移恢复记录；`get_context` 明示 **「Remote/cloud sessions are unsupported」** | 部署与本地账号/目录绑定；自动化运维走 Skills 而非手写请求 |
| 未公开 | 函数运行时（Node/Deno）、请求超时、出网白名单、是否支持任意路径反向代理与 webhook 接收、单站点流量上限 | 见「待核实」——这几项直接决定四家 OAuth 与 webhook 能否在 Sites 上跑通 |

**判断**：Sites 足够支撑「单一 Web 前端 + 一个服务端函数 + 一个库 + 100 个以内的 secrets」这种规模的个人工具 MVP（付费个人计划），但它的域名、用量与「公开访问限制」使它更适合作为**自己的实例/小范围内测载体**，不适合作为面向公众多租户 SaaS 的长期生产环境。要长期做，建议把后端（token 交换、存储、定时抓取）放在可自定义域名的独立服务上，Sites 只做展示层，或按官方路线迁移。

---

## GitHub

一手依据：
- [Differences between OAuth apps and GitHub Apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Secondary rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#secondary-rate-limits) / [Best practices for minimizing 429](https://developer.github.com/v3/#best-practices-for-minimizing-429s-and-oauth-token-creation-rate-limits)
- [Searching issues and pull requests](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/searching-issues-and-pull-requests)
- [About third-party app restrictions on your organization](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-settings/about-third-party-app-restrictions-in-your-organization)

要点（决定架构的部分）：

1. **两条接入路线，权限模型完全不同。**
   - OAuth App：用户授权拿到细粒度 PAT；**「Some endpoints can't be used」**；未认证 60/小时；主速率「**The more active your application is, the lower this rate limit will be**」——即以已认证用户身份请求时共享该用户的 5,000/小时预算。
   - GitHub App：安装制、用户权限与组织权限分离、令牌短期有效、内置 webhook、可细粒度限定仓库范围。**GitHub 自己推荐优先做 GitHub App。**
   - 对多租户聚合，GitHub App 明显更优（webhook 免轮询、安装到组织、可按仓库降权）；OAuth App 更适合纯个人自用。
2. **速率与配额**：认证用户 5,000/小时；GitHub Enterprise Cloud 客户端 15,000/小时**但共享同一用户身份预算**；**search 端点 30/分钟**，code search 9/分钟，rate-limiting 维度为「per user 或 per OAuth App」。
3. **搜索侧限制**（GitHub 用 `search/issues` 一条查询覆盖「指派给我」，仍比逐仓库遍历省调用）：`assignee:@me` 可用；单次查询**最多返回 1,000 条**；查询串**≤256 字符、≤5 个 AND/OR/NOT**；search 最多扫描 4,000 个仓库；`sort` 参数不支持 `created`。
4. **组织侧授权阻塞**：托管在组织下的仓库，「**By default, all third-party applications have access restricted**」，需组织管理员逐应用批准 → 用户所在公司组织若未批准你的应用，即使他个人授权也读不到数据（OAuth App 与 GitHub App 都受此约束）。
5. **次要速率限制**（聚合服务最容易被忽略的坑）：并发请求 **100**；单端点 **900 "points"/分钟**（普通端点 1 分、重查询端点 5 分）；**60 秒内 CPU ≤90 秒**；内容创建类 **80/分钟、500/小时**；**创建 OAuth token 与 installation token 合计 ≤2,000/小时**。官方还要求：按用户分配配额、遵守 `Retry-After`、不要对多用户共享凭据、不要压测真实租户。
6. GraphQL：5,000 points/小时（企业 10,000），适合一次请求拉多仓库 issues，但同样受用户预算约束。

---

## Jira / Atlassian

一手依据：
- [OAuth 2.0 (3LO) for Jira and Confluence Cloud apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [Rate limiting in Atlassian platform services for Jira](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/)

1. **政策上只有一条合规路线**：文档原话 —— Apps that **「collect API tokens from users」**、**「enable users to create their own 3LO apps for your app to use」** 或 **「act on behalf of your app using a single set of app credentials」都 "don't comply with Atlassian's security requirements and acceptable use policy."** → 「用户填 Jira token」和「让客户各建一个 3LO 应用再把 client_secret 交给你」都被禁止；正确做法是做一个带「跨多个 Atlassian 账号访问」能力的单一 3LO 应用。
2. **注册与审核**：在 developer.atlassian.com 创建；「**it's private by default**」，要给别人用必须在 API console 勾选 **「enable sharing」**，并且「**not yet been reviewed by Atlassian**」——即未过审的可分发应用。回调 URL 需精确匹配（scheme+host+port+path 全部一致），且**必须保存 client ID/secret 并生成授权 URL**（无法纯前端）。
3. **仅支持 authorization code grant**（「supports the code grant flow only」）→ 必须有服务端交换 token， Sites 上的静态站无法独立完成。
4. **consent 与 token 生命周期**：scope 变更后需用户重新同意；**account-level grant**（授权到用户，覆盖其可见的全部资源）与 **resource-level grant**（逐资源）两种；**refresh token 90 天有效且为 rotating**（使用后旧 token 失效，需处理并发与轮换）。
5. **配额（关键变化）**：自 **2026-03-02** 起对 Forge / Connect / **OAuth 2LO/3LO** 强制执行 points-based 配额，**REST 与 GraphQL 共享同一池**，按 UTC 整点刷新。
   - **Tier 1 – Global Pool（默认，所有 App 起始都在这里）**：官方原话「**Your app shares a single 65,000 point hourly quota across all tenants. This is the default tier for all apps.**」→ 语义是「**你这个 App 面向全部客户租户的总池**」，不是每租户一份，也不是每个客户租户上所有 App 的共享池。官方补充「Most apps operate comfortably within the Global Pool」。
   - **Tier 2 – Per-Tenant Pool**：「a separate hourly quota for each tenant」，Free 65,000；Standard 100,000 + 10×users；Premium 130,000 + 20×users；Enterprise 150,000 + 30×users，单租户封顶 500,000 points/h。**只有「用量极高或高度集中」的 App 才会在审核后进入该层**，「Most apps remain in the Global Pool」。
   - 计费单位是 points 而非请求数：按「实际工作量」（对象数、嵌套、权限计算）计量，多数请求由 **object costs** 主导，未列出的读操作默认 1 point。
   - burst 限制：GET/POST **100 rps**、PUT/DELETE **50 rps**；单 issue 写入 **20 次/2 秒、100 次/30 秒**；未认证与 PAT 请求走独立池。超限返回 **429 + Retry-After**，`RateLimit-Reason` 取值含 `global-app-quota`（Tier 1）/ `tenant-app-quota`（Tier 2）/ `global pool` / `per-IP limits`。
6. **不能自助扩容**：原话 **「You cannot request additional points based on your use case.」** 升级 tier 需 Atlassian 评估「使用模式与资格」，且**不允许对真实租户做压测**来申请扩容，只能用 sandbox。

→ 对一个「每个用户每 5 分钟拉一次 4 个平台」的聚合器：Jira 侧必须做增量拉取 + 合并批量写 + 严格退避，且要为 tier 审批预留时间；这也是最可能限制你用户数的瓶颈。

---

## 飞书（任务 / 文档 / 项目）

一手依据：
- [任务 v2 概述](https://open.feishu.cn/document/server-docs/task/v2/overview)
- [频率控制](https://open.feishu.cn/document/server-docs/docs/drive-v1/frequency/frequency-control)
- [任务列表 / 我的任务列表](https://open.feishu.cn/document/server-docs/task/v2/task/list)

1. **应用类型决定能否做 SaaS**：「**企业自建应用：只允许企业（租户）内部使用**，不能发布到飞书应用市场」；面向公众必须走「**商店应用**」，且上架前要 **「联系平台工作人员，提交应用审核」**。商店应用获取 `tenant_access_token` 必须带 `tenant_key`（自建应用不需要），并用 `app_id + app_secret` 从开发者后台取 **`app_ticket`（每小时更新一次）**。→ ISV 入驻 + 平台审核 + 逐租户授权，是飞书侧最大的流程成本。
2. **载体能力**（对应「飞书文档或相关 assign 功能」）：
   - **任务 v2 是最贴合「分配给我」的官方能力**：权限点 `task:task:read` / `task:task:write` / `task:tasklist:read` / `task:tasklist:write`，且这些「**权限需要申请，且应用管理员审核通过后才会生效**」；有「我的任务列表」入口、`assignee`/`follower` 成员语义、**「用户 token 没有特权，只能查看用户有权限的列表和任务」**、page_size 上限 **100**、写操作要求 `client_token` 幂等。
   - 云文档侧走 Drive 域 API（评论/协作者/@提及），频控分级表也在 Drive 文档体系下公开。
3. **频控**：分 tier 的分级表（最高 tier4 = **1,000 次/分钟 且 50 次/秒** 等），超限返回 **429**，错误码 **99991400**，响应头 **`x-ogw-ratelimit-reset`** 提示重试时间；官方明确**「暂不支持自行调整频率限制」**，需按文档的重试/合并请求策略处理。
4. **总量配额（作用于「轮询频率」之上的更硬约束）**：官方公告《自建应用 API 调用量上限调整说明》原话 ——「**飞书基础免费版内，单租户下所有企业自建应用的 API 调用总量上限调整为 2026 年 6 月份限时 100 万次，该上限在每个自然月的 1 号刷新**」，并且「基础免费版内，**未认证企业和认证企业**的自建应用上限均为该限时值」。官方给的口径是**按租户合计**，不是按应用：例如「自建应用 A 本月 3 万次 + 应用 B 10 万次 → 该企业合计 13 万次，剩余 87 万次」。超限错误码 **99991403**（「本月 API 调用次数已达上限，请联系企业管理员升级飞书版本」）。
   - 历史值：2024-10-28 起该上限曾是 **10,000 次/月**，2026 年 3 月提到 100 万，公告文案写作「2026 年 6 月份限时」→ **这是限时政策，回收风险必须计入设计**（详见「轮询成本模型」）。
   - 不计入调用量的类别（官方列表）：认证及授权、事件订阅、通讯录、飞书人事（标准版/企业版）、招聘、绩效、智能门禁、飞书应用引擎、AI 能力、飞书智能伙伴创建平台。→ **任务 v2 不在此列表内，会计入调用量**。
   - 商业版/企业版「API 调用无次数限制」的说法出现在飞书官方内容站文章（[链接](https://www.feishu.cn/content/article/7618896174031834060)），但公告正文只对基础免费版给出数值 → 付费版本的实际额度仍需按客户租户版本确认。
5. **Webhook 侧限制**（若做事件推送）：安全域名/请求地址需在开发者后台登记，URL 校验用 encrypt 模式，超时重推策略有限；建议 MVP 先走轮询。

---

## Gitee

一手依据：
- [oschina/mcp-gitee（官方 MCP 服务器 README）](https://gitee.com/oschina/mcp-gitee)
- [Gitee MCP 使用指南（帮助中心）](https://help.gitee.com/mcp)
- [Issue 个人助理（企业版/马建仓帮助中心）](https://help.gitee.com/enterprise/codereview/Issue%E4%B8%AA%E4%BA%BA%E5%8A%A9%E7%90%86)
- [Gitee 使用条款](https://gitee.com/terms)

1. **鉴权与接入形式**：官方 MCP 提供 Remote（推荐）`https://api.gitee.com/mcp` + `Authorization: Bearer <personal access token>`，也提供本地 stdio（`npx @gitee/mcp-gitee@latest`、Go 二进制、`go install`），环境变量 `GITEE_ACCESS_TOKEN` / `GITEE_API_BASE`；`--api-base` 默认 `https://gitee.com/api/v5`，README 称「**可配置的 API 基础 URL，支持不同的 Gitee 实例**」→ 私有化马建仓可复用同一工具集。工具集可用 `--enabled-toolsets/--disabled-toolsets` 或远程请求头 `X-MCP-Enabled-Tools` / `X-MCP-Disabled-Tools` 白名单/黑名单控制（同时给出时白名单优先）。
2. **能力边界（对你这个项目最要命的部分）**：README 的「可用工具」表里，Issue 域只有 `create_issue`、`update_issue`、`get_repo_issue_detail`、`list_repo_issues`（**仓库级**），跨仓库的用户维度只有 `list_user_notifications` 与 `list_user_repos`（"列出用户授权的仓库"）。**没有「列出所有分配给我的 Issue」的官方工具**，`search_issues` 未暴露。企业维度另有 `list_enterprise_repositories` / `update_enterprise_issue`。
   → 落地只能：`list_user_repos` → 逐仓库 `list_repo_issues?assignee=<me>`；或用 `list_user_notifications` 逼近「与我相关」。用户参与仓库多时，调用量随仓库数线性放大——这正好撞上「请求频率」风险。
3. **assign 会推送站内信（一手确认），但通知 ≠ 待办真相。** 官方帮助中心《消息通知设置》的事件表：
   - 任务通知（我创建和参与的任务）：**「有新的任务指派给我」→ 站内信 / 邮件**；「任务状态变更」→ 站内信 / 邮件；「任务被评论」→ 站内信 / 邮件。
   - Pull Request 通知：**「有新的 PR 指派给我」→ 站内信 / 邮件**；「PR 状态变更」「PR 被评论」同上。
   - 我关注的仓库：「有新的任务」「有新的 PR」「有新的 Push」「有新的评论」→ 站内信 / 邮件。
   - 关键前提：原话「用户可以通过 **「设置」->「基本设置」->「通知设置」** 对相关的消息通知进行设置，**决定通知的渠道和是否通知到用户**」→ 用户可以关掉任务通知；关掉后，任何以 notifications 为数据源的聚合器会直接空转。另外官方说明微信通知需关注公众号并绑定账号，且支持把 WebHook 指向钉钉/企业微信/飞书/Slack 机器人。
   - API 侧：官方 MCP 只有 `list_user_notifications`，README 未列出参数与返回字段；腾讯云对官方该 MCP 的描述镜像里给出参数 `page`、`per_page`、`unread(仅未读通知)`、`type(通知类型)`、`since(更新时间)`（**此条为第三方镜像，非 Gitee 一手，需用下面的方法实测**）。因此「通知对象里是否带 issue 编号 / 是否能区分 assign 与其他原因」**未核实**。
   - 实测配方（1 分钟，你自己的 PAT 即可判定，不需要等官方文档）：
     ```bash
     # 1) 看结构：是否有 subject.type / subject.title / repository / reason 或 type 字段
     curl -s "https://gitee.com/api/v5/notifications?per_page=5&access_token=$GITEE_PAT" | jq '.[0]'
     # 2) 让别人（或你的第二个账号）把某 issue assignee 改成你，再拉一次，比对新增条目的字段
     # 3) 用 unread=true / type=<疑似枚举> 复现筛选，确认 type 的取值集合
     ```
     判定规则：**若返回体里能区分「指派给你」这类原因并带 repo+issue 编号** → notifications 可做增量主力；**若只有标题文本** → 只能当「有新动静」的触发器，仍需逐仓库拉取来确认 assignee 现值。
4. **配额无公开一手数据**：Open API v5 的 swagger / OAuth 文档页均为前端渲染，本次抓取**未能取到任何量化速率条款**。能引用的一手约束只有使用条款：「**请求频率过快将导致请求终止**」（原文见 [Gitee 使用条款](https://gitee.com/terms)）。
   → 结论：**Gitee 侧不要假设存在类似 GitHub 的 5,000/小时公开预算**；设计上必须做（a）本地缓存与增量、（b）串行 + 抖动退避、（c）在条款允许范围内保守限频（建议单用户 ≤1 req/s 量级），并（d）上线前通过 Gitee 商务/工单确认应用注册（`client_id/client_secret`，Open API v5 走标准 `response_type=code` 授权码流程，官方 swagger 页面自身即以 `redirect_uri=https://gitee.com/api/v5/swagger` 精确登记为例）与配额。
5. **国内既有的「分配给我」面板只在企业版**：马建仓「Issue 个人助理」提供 全部/我负责的/我参与的/与我相关（含评论与负责仓库），并可「导出明细」——但它是**企业实例内**的功能，不跨企业、不跨平台。开源 Gitee 侧无对应产品化能力。

---

## GitLab（顺带核实，能力最强）

一手依据：[Todos API](https://docs.gitlab.com/ee/api/todos.html)、[Issues API](https://docs.gitlab.com/ee/api/issues.html)

- `GET /api/v4/todos` 直接返回「分配给我 / 我参与 / 我创建的」待办，`GET /api/v4/issues?assignee_username=<name>` 支持**跨项目**按指派人查询。→ 四家平台里唯一原生提供「全局按人查询 issue」的；成本最低，适合作为第一个 provider。
- 注意：Super Productivity 自 v20 起把 GitLab 从内置改为 bundled plugin（见同目录笔记），说明「连接器与核心解耦」是这类工具的常态形态。

---

## 轮询成本模型（针对「每 10 分钟自动 + 其余手动 refresh」）

基准：10 分钟一轮 = **6 轮/小时 = 144 轮/天 ≈ 4,320 轮/月**（30 天，按用户计）。

| Provider | 单用户每轮请求数（最小实现） | 单用户每小时 | 单用户每月 | 一手预算 | 结论 |
|---|---|---|---|---|---|
| GitHub | 1（一次 GraphQL 查多个仓库）；逐仓库 REST 则 = 仓库数 N | 6（N=30 时 180） | 4,320 | 5,000/hr **且以用户身份共享该用户预算**；search 30/min；次要速率并发 100、单端点 900 points/min | **最不缺的一个**。30 仓库全 REST 也只占用户预算 3.6%。真正的风险是手动尖峰撞次要速率 |
| GitLab | 1（`/todos`）+ 可选 1（`/issues?assignee_username`） | 2-12 | 1,720-10,368 | 一手未取到 GitLab.com 默认配额数值（本轮只核实了端点能力） | 量级安全；配额数值待核实后再放开自动轮询 |
| 飞书任务 | 1-3（page_size **≤100**，需翻页） | 6-18 | **4,320-12,960（全部计入租户池）** | 基础免费版**单租户所有自建应用合计** 2026-06 限时 **100 万次/自然月**；历史值 10,000 次/月 | **这是你最早会撞的天花板**：100 万 ÷ 4,320~12,960 ≈ **77-231 个用户/租户**；若限时回收到 1 万 → **1-2 个用户当月吃光整个租户额度**，且报错来自客户租户而不是你 |
| Jira | 1-3（JQL search + 需要的字段展开） | 按 points 计，估 60-300 points | — | **Global Pool 65,000 points/h，你的 App 跨全部客户租户共享一整个池**；burst GET/POST 100 rps | 65,000 ÷ (60~300) ≈ **217-1,083 个同时在轮询的用户**就打满全平台（不是每客户一份）。所以「按用户抓取」在多租户下必须做**同站点合并抓取 + 结果缓存** |
| Gitee | notifications 路径 1-2；逐仓库路径 = 授权仓库数 N | 6-12 / 180（N=30） | 4,320-12,960（逐仓库会到 ~13 万/月/用户） | **无公开量化配额**；一手条款只有「请求频率过快将导致请求终止」 | 无预算可算 → 只能自己定保守值：**≤6 请求/分钟/用户**，并在逐仓库路径加抖动 + 分页合并；否则一旦被封是「请求终止」而不是可退避的 429 |

**由这张表推出的四条设计约束**（比"频率大不大"更重要）：

1. **合并维度是「租户/站点」，不是「用户」。** 飞书按租户合计、Jira 按 App 跨租户合计 → 同一 Jira 站点上的 3 个用户必须共享一次抓取（抓到后按 assignee 分发），否则你在为同一份数据付 3 倍配额。GitHub 反过来：预算属于用户凭据，**不能**用集中凭据合并（GitHub 官方最佳实践明确要求按用户分配配额、不要共享凭据）。
2. **手动 refresh 才是尖峰来源，自动轮询反而温和。** 需要：客户端按钮防抖 + 服务端 singleflight（同一用户同一 provider 的并发刷新请求合并成一个上游调用）+ 尊重 `Retry-After`/`x-ogw-ratelimit-reset`。Jira 的 points 池按小时结算，尖峰主要撞 burst rps；GitHub 主要撞次要速率的「单端点 900 points/分钟」。
3. **Sites 没有公开的定时能力**（见上表），所以「每 10 分钟」实际上只在「用户开着页面」时成立。把它设计成 **stale-while-revalidate**（进页面先渲染 DB 里的上次结果，再后台拉一次增量），既符合平台形态，又把每用户每月的请求量降 1-2 个数量级——这一步同时缓解飞书与 Jira 两个天花板。
4. **给「客户租户额度用尽」留产品出口。** 飞书 99991403、Jira 429 `global-app-quota` 都不是「你的服务器坏了」，而是「客户没额度了 / 你的 App 池满了」。UI 必须区分这两类并给出可执行提示（升级到商业版/企业版、降低该用户轮询频率、切手动），否则用户只会看到"拉不到数据"。

## 阻塞清单（按优先级）

| # | 阻塞 | 影响的路线 | 建议动作 |
|---|---|---|---|
| 1 | 飞书自建应用不能对外服务，商店应用需 ISV 入驻 + 平台审核 + `app_ticket`/`tenant_key` | 任何「多租户 SaaS + 飞书任务」 | MVP 先只做「自建应用 = 自己公司租户内用」；对外版本独立立项走商店审核 |
| 2 | Atlassian 禁止收集用户 token / 禁止让用户自建 3LO；且 2026-03-02 起默认 Global Pool 65,000 points/h 不可自助提额 | Jira provider 的多用户规模 | 立刻申请可分发 3LO（enable sharing），只做增量拉取与批量写；把 tier 审批当成上线前置条件 |
| 3 | Qoder Sites 个人 Free 不支持数据库/存储；Teams/Enterprise 不支持公开访问；无自定义域名入口；免费期有用量上限 | 整体落地形态 | 用付费个人计划；把地址前缀视为「不可变更的生产配置」登记到四家应用；长期迁移到可自定义域名的后端 |
| 4 | Gitee 的 MCP 工具表没有「跨仓库分配给我」；REST v5 有 `user/issues`（Swagger 一手，未用真 token 实测）+ 无公开量化配额 | Gitee provider | 用 REST `/user/issues?filter=assigned`（见 TL;DR 更正），不遍历仓库；仍自己实现全局限速器；工单确认配额 |
| 5 | GitHub 组织默认限制第三方应用访问 | GitHub provider（公司仓库） | 引导用户自查组织已批准的 OAuth App/GitHub App；失败时给出可执行的提示 |
| 6 | 所有平台的回调地址必须与登记完全一致（Atlassian 尤其严格，含端口与路径） | OAuth 全流程 | 站点部署前先固定域名；写一份 redirect 矩阵文档；本地调试用独立应用而非生产应用 |

## 待核实

- Gitee Open API v5 是否有公开的按应用/按令牌频控数值、以及第三方应用注册是否需要审核（swagger/OAuth 页面前端渲染，未取到正文）。
- **Gitee notifications 的返回结构**：`list_user_notifications` 能否区分「指派给你」这类原因、是否携带 repo + issue 编号、`type` 参数的取值集合 —— 官方 README 未列参数。已给出实测配方（Gitee 节第 3 条），**做完这一步才能决定 Gitee provider 用「事件流」还是「状态快照」模型**。
- `list_repo_issues` 是否支持服务端 `assignee` 过滤（官方 README 工具表只有 owner/repo/page/per_page/state）；若不支持，客户端按 `issue.assignee.username` 过滤是唯一路径。
- Qoder Sites 服务端函数的运行时、请求超时、出网白名单、**是否存在定时/计划任务能力**、是否支持任意路径 webhook 入站（产品文档与接口契约均未公开）。
- GitLab.com 的默认 API 配额数值（本轮只核实了 `/todos`、`/issues?assignee_username` 端点能力）。
- Atlassian JQL `assignee = currentUser()` 在 3LO 用户身份下的实际可用字段与 search 端点上限（本轮未取一手页）。
- 飞书「云文档评论/@提及」是否可作为「与我相关」的补充载体（本轮只核实了任务 v2 与频控）。
- 国内 DevOps 套件（ONECODE、极狐 GitLab 私有化、CODING）的「个人跨项目待办」能力边界。

## 来源清单

**Qoder**
- https://docs.qoder.com/qoder/sites （计划可用性、Free 仅静态、访问策略、地址前缀/固定后缀、AI 标识不可移除、用量上限、发布/暂停/删除）
- https://docs.qoder.com/cli/sites （Skills 入口、`/sites` 面板、Secrets 只写不可读回、`qoder sites` 子命令与操作目录）
- Qoder Sites 平台接口契约（`prepare_site`：webDirectory/functionDirectory/index.ts、databaseAccess 需 Function、secretNames ≤100、subdomain 前缀语义；`update_access_policy`：`private/selected/public/organization` + `confirmPublic`）
- https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm （人工智能生成合成内容标识办法，第十条）

**GitHub**
- https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#secondary-rate-limits
- https://developer.github.com/v3/#best-practices-for-minimizing-429s-and-oauth-token-creation-rate-limits
- https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/searching-issues-and-pull-requests
- https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-settings/about-third-party-app-restrictions-in-your-organization

**Atlassian / Jira**
- https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- https://developer.atlassian.com/cloud/jira/platform/rate-limiting/

**飞书**
- https://open.feishu.cn/document/server-docs/task/v2/overview
- https://open.feishu.cn/document/server-docs/docs/drive-v1/frequency/frequency-control
- https://open.feishu.cn/document/server-docs/task/v2/task/list
- https://open.feishu.cn/document/platform-notices/platform-updates-/custom-app-api-call-limit （自建应用 API 调用量上限调整说明：单租户合计、限时 100 万/自然月 1 号刷新、不计入调用量的类别）

**Gitee**
- https://gitee.com/oschina/mcp-gitee （README：Remote MCP、工具清单、鉴权方式、api-base 可配、许可证 MIT、版权 2025 Gitee）
- https://raw.giteeusercontent.com/oschina/mcp-gitee/raw/master/README_CN.md （官方 README 中文原文，工具表 25 项，与 v1.0.0 一致）
- https://gitee.com/oschina/mcp-gitee/releases （v1.0.0 2026-04-23：工具 30→25，「所有合并均通过枚举参数区分，功能无删减」；v0.1.1 说明同时支持 Gitee 专业版与 SaaS 版）
- https://help.gitee.com/account/notification-settings （消息通知设置：「有新的任务指派给我 → 站内信 / 邮件」等事件表 + 渠道与是否通知由用户设置决定）
- https://gitee.com/api/v5/swagger 、https://gitee.com/api/v5/oauth_doc （页面存在但正文为前端渲染，未取得条款）
- https://help.gitee.com/mcp （MCP 工具安装与用途）
- https://help.gitee.com/enterprise/codereview/Issue%E4%B8%AA%E4%BA%BA%E5%8A%A9%E7%90%86 （Issue 个人助理）
- https://gitee.com/terms （「请求频率过快将导致请求终止」）

**非一手（仅用于定位官方页面或提示待验证项，未作为结论依据）**
- 腾讯云对官方 mcp-gitee 工具参数的描述镜像：https://docs.cloudbase.net/ai/mcp/develop/server-templates/cloudrun-mcp-gitee 、https://tcb.cloud.tencent.com/mcp-server/mcp-gitee （给出 `list_user_notifications` 的 page/per_page/unread/type/since）
- https://www.feishu.cn/content/article/7618896174031834060 （提及商业版/企业版无调用次数限制，未见对应公告正文）
- CSDN / 百家号 / 今日头条等对飞书 1 万→100 万额度变更的转述（用于定位公告，结论以公告原文为准）

**GitLab**
- https://docs.gitlab.com/ee/api/todos.html
- https://docs.gitlab.com/ee/api/issues.html
