---
title: 跨平台个人待办面板 · 决策共识（参赛版 v1）
date: 2026-11-16
status: 已确认（grilling Round 1–13，用户于 2026-11-16 确认共识）
method: 逐轮 design-tree 访谈；每轮只问 frontier（前置已定的决策）；事实由 agent 一手核实，决策由用户逐个拍板
deadline: 2026-11-30（大赛官网赛题页论坛发布作品帖）
related:
  - research/personal-cross-platform-issue-dashboard.md
  - research/platform-limits-and-landing-form.md
  - research/super-productivity-implementation.md
---

# 决策共识

这份文档是访谈结论，不是调研报告。调研证据在 `research/` 三份笔记里；本文只记录**决定了什么、为什么、以及哪些风险被有意承担**。§3 例外：那里的平台事实是多个决策的直接前提，所以连同出处一起留档。

## 0. 六段结论

### 0.1 范围与定位

参赛作，非生产用途，多租户，目标是让评委**真实体验**。核心 JTBD 只有一个：**60 秒回答"今天该做什么"**。

外部 issue 一律**只读**，其上盖一层本地规划（今日清单 + 拖拽排序），**不做任何回写**。v1 = GitHub + Jira；v2 = 飞书任务（文档 / 表格 / 审批仅作为 PRD 拓展项）。更新机制 = 可见标签页轮询 + 手动 refresh，v1 无推送。30% 精力投在演示打磨上。

交付物 = 大赛论坛作品帖 + 一个**设为公开访问**的 Qoder Sites 地址 + 帖子五部分（自我介绍 / 作品是什么 / 为什么做 / 怎么用 5 步以内 / 用 Qoder 做出来的过程含截图凭证）。

**不做"帖子式包装"**：初筛阶段评委就会点进链接真用，所以线上真实体验是评分界面，帖子只是入口。

### 0.2 Provider 与各平台的真实程度

登录即首次 provider 连接（用 GitHub OAuth 登录，不建独立账号体系）。落地即演示：默认载入**代持演示租户**，真连入口在第二屏。

四张卡片的真实程度**必须各不相同且各自标明**：

| Provider | 参赛版形态 | 依据 |
|---|---|---|
| GitHub | **真连，对外可用**，双档授权（`public_repo` / `repo`） | 唯一有浏览器可用 CORS 且有公私粒度的一档 |
| Gitee | **真连，对外可用** | 国内评委可用性最高；但 access_token 一天过期 |
| Jira | **真连但仅内部自证**：app 保持默认 private、不开 sharing、UI 一律标"样例数据"，帖子里只写"已跑通真实 3LO 接入（截图为证）" | Atlassian 规定 app 只能访问**已安装它的站点**，且要求用户在 consent 屏选站点；评委几乎必然没有自有 Jira Cloud 站点 |
| 飞书 | **第四张样例卡，零真连代码** | 自建应用只能在本租户内使用；真实接入需企业租户 + 回调域名白名单 |

### 0.3 架构

前端托管在 **Qoder Sites**（满足赛题"用 Qoder Sites 部署并设为公开访问"），**后端在自有服务器**（已有域名 + HTTPS）。回调三条固定路径 `/cb/github`、`/cb/gitee`、`/cb/jira`，**不开 wildcard**。

理由不是偏好，而是三条硬事实叠出来的：①OAuth 换取 token 必须在服务端（GitHub 与 Gitee 的 `client_secret` 都是 Required，Atlassian 无 implicit flow）；②Gitee 一天过期需要真定时器；③回调 URL 要在三家后台预先登记，需要永久稳定的主机名。

Provider 抽象做成**内部统一契约**（不开放第三方插件）：

```
search()  getByIds()  normalize()  doneStates  deletedStates  pollIntervalMs  scopeDescriptor
```

`scopeDescriptor` 是必需字段——Q36 证明"公私粒度"在各平台根本不对称（GitHub 有、Gitee/Jira 没有），硬编码会让这个差异散落到每个 `if` 里。`normalize()` 必须在阶段 1 定稿，否则阶段 3 的跨平台重复项合并会建在各自原始字段上。

### 0.4 凭据与安全

**服务端代持**：token 落库，**AES-256-GCM** 加密，密钥同机（环境变量/本地文件）。**镜像 = 全量元数据 + 标题入库；正文、评论、diff、代码永不入库。**

叙事走**托管纪律（custody discipline）**，不走零持有。措辞精确到：**"数据库文件泄露不导致凭据泄露"**，并明写它**挡不住服务器被完全控制**。这条边界必须写出来——Super Productivity 官方文档对自己同类机制的原话是 *"They are currently **unencrypted at rest**, so this is an isolation boundary, not hardware-backed secure storage"*；把边界写明比把话说满是更强的加分项。

- 自陈屏：点"连接"之前先显示一张表（存什么 / 不存什么 / 谁可见 / 怎么清），用户点"我知悉并同意"再跳 OAuth。**只出现在连接前，不进帖子、不做常驻入口**。
- 删除义务：撤销授权即**物理删除**该租户全部数据；连续 30 天未访问自动清除。**不做数据导出**（对评委体验几乎无加分，却要处理镜像序列化）。
- 刷新分档：**演示租户**走 cron 定时 + 分布式锁；**真实租户**走懒刷新（访问时判断 `expires_at`）；过期态必须显式可见并给"一键重新连接"，不允许静默空列表。
- 公私粒度：**只有 GitHub 做得到**，实现为两档两次授权流程（`public_repo` / `repo`，两个 token 并存，官方 "Creating multiple tokens for OAuth apps" 明确背书）。用 `X-OAuth-Scopes` 响应头做真值检测并显示实际授予，以捕捉"用户在 GitHub 侧把 `repo` 编辑成 `public_repo`"这种降级；Gitee 与 Jira 卡片上不出现该开关，改为一行说明"该平台授权粒度不区分公开/私有"。
- 撤销：**一键全撤**。补一句零代码文案："如需仅关闭私有仓库访问，请在 GitHub 应用授权页调整 scope 后重新连接"（`https://github.com/settings/connections/applications/:client_id`）。
- **不做节流**（用户判断，见 §5）。

### 0.5 AI

**规则打分负责排序，LLM 只负责措辞，输入只有元数据。** 两个功能严格分离、分别命名：

- **「为什么是这几条」**＝单条排序理由，**同步返回，2 秒硬指标**。
- **「AI 提炼」**＝批量任务摘要，首页按钮触发、**一次 ≤20 条**、缓存键 `provider + issue_id + updated_at`（源站未更新不重算）、**并发流式逐条填充**、允许输出**"信息不足"**，且界面明示"AI 只看得到标题和标签，看不到正文和评论"。这条"主动示弱"同时兑现托管纪律与字段边界，也避免评委怀疑偷喂正文。批量摘要不阻塞任何交互：评委可以一边看条目长出来一边拖拽排序。

运行位置：**自有服务器 + 自己的模型 key**。Qoder 的叙事价值走帖子第五节"用 Qoder 做出来的过程"承担，不压到运行时链路上赌一个无文档的调用路径；若要在运行时也用 Qoder 能力，阶段 1 里花 30 分钟从自有服务器 curl 一次 Qoder Cloud Agents 接口验证，通了再换。

**学习闭环做最小可实现版**（修订了早期"不声称学习"的约定）：记录 `provider + issue_id + 时间 + 用户放置的位置`，下次打分时按"历史上你反复把某 repo / 某类 label 排到前面"线性加权；用户**首次主动排序后弹窗**说明它现在学的是什么，AI 理由文案里可出现"因为你上周连续 3 次把 X 仓库的缺陷置顶"。三处连带义务：自陈表加一行"记录排序行为"、30 天自动清除覆盖它、约一天工作量。

### 0.6 演示与交付

**新注册专用演示账号**（不用真实工作账号），且**必须含 ≥1 私有仓库**，否则公私开关演示不出差异。

双层数据集：默认**精选 12 条**——1 条已逾期、2 条今日到期、**2 条跨平台重复项（GitHub 与 Gitee 各一条，措辞相似但不同）**、1 条来自私有仓库、1 条标题信息量低到 AI 必须答"信息不足"、2 条已完成（演示 `doneStates` 收敛）、3 条一般项。可切换**展开 83 条对照视图**，用于"信息过载时它仍只推这三条"；这 83 条必须在源站真实存在（Gitee 侧不能前端伪造，否则真连一演示就露）。

那 2 条跨平台重复项是**整个作品唯一能一眼证明"整合有价值"的画面**；措辞必须相似而不同（"登录页 500" vs "Login 接口偶发 500"），完全同名反而像 bug。

界面常态保持安静：状态信息收在**右下角角标**，异常时才变色；失败时把"此条数据来自 12:07 快照"**就地打在受影响卡片右上角**，正常态不出现任何多余元素、不做顶部横幅。

评委五步路径：①打开链接（默认载入演示代持账号）→ ②看"今天该做什么"自动生成清单 → ③手动拖拽排序（首次触发后弹出学习机制说明）→ ④点「为什么是这几条」看 2 秒理由 → ⑤连接自己的账号，可自选 public / private 权限。每个 issue 标题下由「AI 提炼」补一段任务总结，点击标题跳源站。

帖子前两节写法：**自我介绍 2 句**（后端工程师 + 一次具体的漏看事故）；**"为什么做"只写一个事故 + 一条已核实的一手事实**（例如 Gitee 官方 API 无跨仓库"指派给我"端点，所以国内产品必须靠通知流拼装）；把三份调研笔记、每条 claim 的出处、**以及自己被推翻过的判断**折叠进第五节——"我如何发现自己错了"是唯一无法事后编造的过程凭证。

## 1. 决策台账

| # | 议题 | 决定 | 备注 |
|---|---|---|---|
| Q1 | 项目定位 / 租户模型 | 参赛作 + 多租户 | 让评委真实体验优先于生产稳健性 |
| Q2 | 是否回写外部平台 | C：外部只读 + 本地规划层 | |
| Q3 | 核心 JTBD | a：60 秒早晨 triage | |
| Q4 | v1 平台范围 | GitHub + Jira | |
| Q5 | 飞书接什么 | 先飞书任务；文档/表格/审批进 PRD 拓展项 | |
| Q6 | 更新机制 | 可见标签页轮询 + 手动 refresh，无推送 | |
| Q7 | 评委入口 | C：默认一键演示 + 二屏真 OAuth | |
| Q8 | 演示打磨投入 | 30%（拒绝 40%） | |
| Q9 | 登录方式 | A：登录即首个 provider 连接（GitHub OAuth） | |
| Q10 | Jira/飞书呈现 | B：标"样例租户 / 样例工作区" | |
| Q11 | 规划层深度 | a：今日清单 + 排序，无回写 | |
| Q12 | AI 边界 | 规则打分 + LLM 仅措辞，输入仅元数据 | "不声称学习"一条被 Q35 修订 |
| Q13 | 后端落点（第一次） | 先 Sites，自有服务器兜底 | 前提被 Q17/Q20/Q21 推翻，重导出为 Q26 |
| Q14 | GitHub scope / token 存放 | 用户重开：private 是真实需求，约束应产品化 | 在 Q17 定稿 |
| Q15 | AI 具体形态 | 同 Q12 | |
| Q16 | 时间线与交付物 | 两周；线上初筛看帖 + 晋级后路演；帖子五部分 | |
| Q17 | token 形态 | **A：服务端代持、落库、全代理** | |
| Q18 | Jira 是否真连 | **做真连**（口径由 Q28 收窄为内部自证） | |
| Q19 | 是否让帖子主导实现顺序 | **否**：初筛评委就会点链接真体验 | 撤回 agent 的"初筛只读帖"前提 |
| Q20 | 服务端保存什么 | **C：完整镜像**（字段边界由 Q23 定） | |
| Q21 | Gitee 形态 | **C：真连** | "虽然难但我想试试" |
| Q22 | 安全叙事 | **A：托管纪律**（非零持有） | |
| Q23 | 镜像字段边界 | **C：元数据全量 + 标题入库，正文永不** | |
| Q24 | 评委前 60 秒 | **C：落地即演示 + 代持一个真实测试租户** | 未选含录屏兜底的 D |
| Q25 | 义务边界 | **B：撤销即物理删除 + 30 天自动清除**，不做导出 | |
| Q26 | 后端落点（最终） | **B：前端 Sites + 后端自有服务器** | |
| Q27 | 凭据刷新策略 | **C：演示租户定时 / 真实租户懒刷新 / 过期显式可见** | |
| Q28 | Jira 真连验收口径 | **A：仅内部自证，app 保持 private** | 省约半天；证据是截图 |
| Q29 | 授权前自陈屏 | **B：连接前一屏**，不进帖子、不常驻 | 未选 C |
| Q30 | 服务器接回调条件 | **A：已有域名 + HTTPS**，三条固定回调路径 | |
| Q31 | 节流 | **A：不做** | agent 推荐 B；风险见 §5 |
| Q32 | 演示租户数据来源 | 新注册专用账号 | |
| Q33 | 帖子五步 / 评委路径 | 用户自定义（见 §0.6） | |
| Q34 | AI 提炼边界 | **C：按钮触发 + ≤20 条 + 缓存 + 允许"信息不足"** | |
| Q35 | 学习闭环 | **B：最小可验证实现** | 修订 Q12 的"不声称学习" |
| Q36 | 公私开关 | **C：仅 GitHub 两档 + `X-OAuth-Scopes` 真值检测显示** | |
| Q37 | 失败 / 过期 / 真空态 | **C：provider 状态卡 + 保留上次快照水印**，附加约束"不喧宾夺主" | |
| Q38 | 飞书形态 | **B：第四张样例卡，零真连代码** | |
| Q39 | 双 token 撤销粒度 | **A：一键全撤** | 未选 C；用文案补出口 |
| Q40 | 状态信息克制程度 | **B：右下角角标** | 未选 A 常驻状态条 |
| Q41 | 演示数据集 | **C：精选 12 + 展开 83 双层** | |
| Q42 | 异常可见性（Q40-B 之后） | **C：就地卡片水印**，无横幅 | |
| Q43 | 两周排期与 kill 时点 | 全表采纳 | 见 §2 |
| Q44 | provider 抽象 | **B：内部统一契约七法** | 兑现"飞书留位"那句话 |
| Q45 | token 静态加密 | **B：AES-256-GCM，密钥同机**，边界写进自陈屏 | |
| Q46 | LLM 运行位置与延迟 | 自有服务器 + 自有 key；理由同步 2s / 摘要流式异步 | Cloud Agents 仅 30 分钟可选验证 |
| Q47 | 路演 5 分钟脚本 | **显式推迟**（先过初筛） | 唯一被有意搁置的分支 |
| Q48 | 帖子前两节叙事 | **C：职业 + 一次事故 + 一条一手事实，调研过程进第五节** | |

## 2. 两周排期与 kill 时点

原则：**先打通"能演完整故事"的最短路径，再补安全工程**——阶段 1 是路演保命线，凭据保管晚一天做不会让作品讲不出来。

| 阶段 | 日期 | 内容 | 完成标志 |
|---|---|---|---|
| 1 | 11-17 → 11-19 | 三条回调骨架 + GitHub `public_repo` 端到端 + 规划层（今日清单 / 拖拽 / `doneStates`）+ 演示账号 12 条精选 | **一键演示能讲完整故事**（凭据可临时放本地） |
| 2 | 11-20 → 11-21 | 凭据加密存储、自陈屏、`X-OAuth-Scopes` 检测显示、撤销即物理删除、30 天清除 | §0.4 每句承诺都有对应代码 |
| 3 | 11-22 → 11-24 | 刷新策略（cron + 锁 / 懒刷新 / 过期态）+ Gitee 真连（含 403 User-Agent 坑）+ 83 条对照视图 + **跨平台重复项合并** | 演示租户隔夜仍有数据；重复项合成一张卡 |
| 4 | 11-25 → 11-26 | 规则打分 + AI 提炼（≤20 / 缓存 / 信息不足）+ 学习闭环 | 第 4 步 2 秒内出结果 |
| 5 | 11-27 | Jira 真连仅自证：授权→拉取→落库→撤销，全程截图 | 帖子那句话有证据 |
| 6 | 11-28 → 11-29 | 30% 打磨 + 五部分帖子 + 截图 + 发布前压测 | 功能冻结 |
| — | 11-30 | 缓冲 | |

Kill 时点（每条都是**降级**，不是停摆）：

- **11-21 22:00** 阶段 1+2 未全绿 → 砍掉 Gitee 与 Jira 真连，全部退样例卡，剩余时间全灌进阶段 1/2/6。作品仍成立，真连只剩 GitHub。
- **11-24 22:00** Gitee 未通 → Gitee 降样例，"每日过期 + cron"复杂度归零。
- **11-26 22:00** Jira 未通 → **删掉**帖子里"已跑通真实 3LO 接入"这句；无证据不得写。
- **11-26 22:00** 学习闭环未通 → 弹窗文案降级为"已开始记录你的排序习惯，学习闭环在路线图中"。这是全树**唯一允许降级声称**的位置（方向由强到弱，不会留下虚假宣传）。
- **11-28 22:00** 无论进度，进入只修 bug + 写帖状态。

## 3. 一手事实与出处

这些是决策的直接前提，逐条可复核。

**GitHub**（[Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[Scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)）

- web flow 第 2 步 `client_secret` = **Required**；`code_verifier`(PKCE) 只是 "Strongly recommended"，**不能替代** client_secret；device flow 才写明 "The `client_secret` is not needed for the device flow"。→ Q26 服务端不可省的依据。
- 可开启过期 token：*"The access token expires after eight hours"*；`offline_access` scope 可在运行时索取短期 token + refresh token。
- **`repo`** = *"Grants full access to public and private repositories"*；**`public_repo`** = *"Limits access to public repositories"*。**没有任何 scope 是"私有但不含公开"** → Q36 只能做两档的依据。
- 官方背书分档授权：*"Creating multiple tokens for OAuth apps … your app can perform the web flow for each use case, requesting only the scopes needed."*
- *"users can edit their scopes, effectively granting your application less access than you originally requested. You should be aware of this possibility and adjust your application's behavior accordingly."* → Q36-C 的依据。
- 本机 curl 实测响应头：`api.github.com` 带 `Access-Control-Allow-Origin: *`，且 `Access-Control-Expose-Headers` 含 `X-OAuth-Scopes, X-Accepted-OAuth-Scopes` → 前端可直连 API **并能读到实际 scope**。`github.com/login/oauth/access_token` **无任何 `Access-Control-Allow-Origin`** → 浏览器换不到 token。

**Atlassian**（[OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)，页面日期 2026-11-16）

- *"Apps that collect API tokens or instruct customers to create individual 3LO apps don't comply with our Security requirements … Best practices: Build a single, distributable 3LO app for your integration."* → Q18 走统一 3LO 是**官方推荐**形态，非灰区。
- *"When you create an OAuth 2.0 (3LO) app, it's private by default … If you want to distribute your app to other users, you must enable sharing."*
- *"Users trying to install an unapproved OAuth 2.0 integration are warned that the app has not yet been reviewed by Atlassian."*
- *"the app can make requests on their behalf for only the sites where the app is installed"* + *"The consent screen currently requires the user to select the site where they want to install the app."* → **Q28-A 的决定性依据**。
- *"Rotating refresh tokens … Every new refresh token returned invalidates the refresh token used to get the new access token."*（默认不活动 90 天过期）→ 刷新必须**原子替换**，写坏一次永久丢一个租户。
- *"CORS whitelisting is supported for `api.atlassian.com`."*
- 配额：2026-03-02 起 points 制，Tier 1 Global Pool **全站共享 65,000 points/小时**。Q28-A 之后只有自家用，风险≈0。

**Gitee**（[码云 OpenAPI OAuth 说明文档](https://gitee.com/api/v5/oauth_doc)，JS 渲染页需浏览器读取）

- API 使用条款：*"未经用户允许，不准爬取或存储用户的资源。"* → **经允许即可存储**，这是 Q20-C 镜像的合规锚点，也是 Q29-B 自陈屏的依据。
- *"禁止滥用 API，请求频率过快将导致请求终止。"* → **无任何量化数字**。
- *"当 access_token 过期后（**有效期为一天**），你可以通过以下 refresh_token 方式重新获取"* → Q27-C 定时刷新的由来。
- scope 枚举：`user_info projects pull_requests issues notes keys hook groups gists enterprises` → **无公私维度**；可只申 `user_info projects issues` 做最小化。
- 换取 token 需 `client_secret`（官方建议放 Body）。创建应用：*"在 修改资料 -> 第三方应用，创建要接入码云的应用"* → 个人自助，页面**未记载审核环节** [未核实]。
- 踩坑提示：*"如果获取 access_token 返回 403，可能是没有设置 User-Agent 的原因。"*

**Qoder Sites**（第一方工具面）

- `update_access_policy` 的 `mode` 枚举含 `public`（需 `confirmPublic`，"Public sharing requires explicit authorization"）→ 赛题"设为公开访问"在平台层存在。
- `get_site` 的 `include` 支持 `secrets`，且 *"Secret values are never returned."*
- `ensure_backend` capabilities = `database | functions | storage | qoder`，`databaseAccessModel: legacy | function_backend`。

### 仍 NOT DOCUMENTED（带自证配方）

| 未知项 | 影响 | 配方 |
|---|---|---|
| Sites 函数的超时 / 出网 / 定时能力 | Q26-B 之后**不再关键**，但仍是"能否只用 Sites"的判据 | 最小 function 里 `fetch('https://api.github.com/meta')` 打回状态码与耗时，另返回一个 302 |
| Gitee 限流是否按 IP 计 | 所有租户共用你服务器一个出口 IP，Q31 又不节流 | 服务器上拿两个不同租户 token 交替高频打 `gitee.com/api/v5/user`，看 403/429 是按 token 还是整 IP 被封 |
| Gitee OAuth 应用是否有人工审核 | 阶段 3 排期 | 直接在 修改资料→第三方应用 建一个，看是否即时可用 |
| Qoder Cloud Agents 能否被非 Sites 后端调用 | Q46 可选支线 | 自有服务器 curl 一次，30 分钟定生死 |

## 4. 被推翻或修订过的前提

留档以免回潮。

1. **"初筛只读帖子"** — 被 Q19 推翻。评委初筛就会点链接真体验，所以 30% 打磨全部落在线上真实体验，Q7-C 的一键演示从加分项变成生死线。
2. **"token 存放问题是 Qoder Sites 的限制"** — 归因错误。OAuth 换取必须在服务端是 **GitHub/Gitee/Atlassian 的限制**；Sites 带来的真实约束只有回调地址不可自定义域名、需预先登记。安全卖点必须写成"主动不落库/克制代持 + 可当场自证"，不能写成"平台不让我们存"。
3. **Q13 的"后端需求很轻"** — 被 Q17-A + Q20-C + Q21-C 推翻：后端要承担三条 OAuth 回调、三套 client_secret、token 加密、每日刷新、轮换原子写、镜像入库、撤销即删，于是重导出为 Q26-B。
4. **"不声称 preference-learning"** — 被 Q35-B 修订：现在做真闭环，因此措辞可以且必须提到学习机制，但要具体到"学的是什么"。
5. **"按任务数估算轮询成本"** — 已更正为**每 provider 每轮 ≈ 一个批量请求**（`getByIds` / `getFreshDataForIssueTasks` 语义），见 `research/super-productivity-implementation.md`。

## 5. 有意承担的风险

三处用户覆盖了 agent 的推荐，记录在案、不重开：

- **Q31 不做节流** → 429 / 请求被终止概率上升（Gitee 尤其：规则未量化 + 单一出口 IP）。由 Q42-C 的就地水印向用户解释，而非由代码避免。
- **Q40 常态低调（角标）** → 系统健康态没有常驻视觉位置。由卡片水印补，代价是截图时需要异常态存在。
- **Q39 一键全撤** → "只想关私有访问"的用户在界面里没有出口。由一句去 GitHub 调 scope 的文案补。

## 6. 尚未访问的分支

- **路演 5 分钟脚本**：按 Q47 **显式推迟**到初筛通过之后。届时需要重开的是：现场断网兜底录屏（与 Q24 拒绝的"帖子内嵌录屏"是两件事）、以及"被质疑数据造假时是否当场真连"的支线。
- 前端技术栈选型、视觉来源、DB 选型：视为阶段 1 内可自行决定的实现细节，未列入决策树。
