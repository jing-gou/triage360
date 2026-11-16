---
question: 是否存在面向「个人」的任务追踪面板，能集成 GitHub / GitLab / Gitee 等代码托管平台与 Jira 等缺陷管理平台的 issue，帮助个人做任务规划与总览？
date: 2026-11-16
method: 仅采用一手来源（官方文档、官方 API 文档、源码仓库描述、官方站点），二手博客/榜单仅作参考并标注
status: 主结论已核实；部分候选产品因拿不到一手来源列入「待核实」
---

# 跨平台「个人任务面板」调研报告

## 结论摘要（TL;DR）

1. **没有任何产品原生同时接入 GitHub + GitLab + Gitee + Jira 四家。** 这是本轮调研最核心的结论，通过对最接近的候选（Super Productivity）官方集成目录逐项核对得出——其连接器列表为 Jira、GitHub、GitLab、Gitea/Forgejo、Google Calendar、CalDAV，**不含 Gitee**。
   来源：[Super Productivity Integrations](https://super-productivity.com/integrations/)
2. **最接近你需求的是开源软件 Super Productivity**：官方明确说明可同时连接多个 provider，且"Issues from all sources appear in a unified task list"（所有来源的 issue 汇聚到一个统一任务列表）。Jira（Cloud & Data Center）、GitHub（Issue & PR）、GitLab（含自建实例）均可用；Gitee 需要自己写插件适配。
   来源：[Super Productivity Integrations](https://super-productivity.com/integrations/)（FAQ "Can I use multiple integrations at once?"）
3. **各平台自身已提供「分配给我的」个人视图，但不跨平台**：GitLab 有 To-Do List（跨项目/跨组的分配待办），GitHub 有全局 `assignee:@me` 搜索 + Issues dashboard + Inbox，Jira 有 JQL `assignee = currentUser()` + dashboard gadget。这些是「单平台内的个人面板」，不能相互合并。
   来源见下文「各平台原生能力」。
4. **把 GitHub + GitLab + Gitee + Jira 合到一起，现实路径只有两条**：
   - 用 Super Productivity 覆盖 Jira+GitHub+GitLab 三家，Gitee 走它的 plugin/REST API 扩展；
   - 自建聚合（各平台官方 API 都有对应的「我负责的」查询端点，见「自建方案」一节），或用 MCP 把四家的官方 MCP server 挂进同一个 AI 客户端，由 agent 做汇总。
5. **MCP 正在成为可行的「替代聚合层」**：Atlassian、GitHub、Gitee 都提供官方 MCP server（Atlassian 覆盖 Jira/JSM/Confluence/Bitbucket；Gitee 提供 remote endpoint `https://api.gitee.com/mcp`）。这不是传统面板，但确实能实现「一个入口问出我今天所有平台的待办」。
   来源：[Atlassian MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/)、[Gitee MCP Server](https://help.gitee.com/ai-productivity/mcp-server)

## 关键判断

- **"个人任务面板"这个需求在市场上是分裂的**：做「多平台聚合」的（Super Productivity、Sunsama 一类）偏个人时间管理，弱化平台侧写回；做「缺陷管理」的（Jira/Plane/YouTrack/Linear）把自己当成唯一 source of truth，聚合外部 issue 只是一次性 import 或链接卡片，不是可规划的统一待办池。
- **Gitee 是国内场景的主要缺口**。Gitee 官方的「Issue 个人助理」属于**企业版马建仓 AI 助手**能力，且只在 Gitee 页面上下文内总结当前用户负责的工作项，不跨平台；Gitee 官方 MCP 的 Issue 类工具是 `list_repo_issues`（需指定 owner/repo）与 `list_user_notifications`，**没有「跨仓库查询分配给我的 issue」这个工具**。
  来源：[Gitee Issue 个人助理](https://help.gitee.com/enterprise/ai/program_manage/ai-issue-assistant)、[Gitee MCP Server](https://help.gitee.com/ai-productivity/mcp-server)
- **凡是不在你自己账号体系里的东西（Jira 权限、企业 GitLab token scope）都会成为聚合面板的第一道落地门槛**，比选型更容易卡住项目。

## 候选清单

| 产品/项目 | 可接入的目标平台 | 个人向 / 免费 | 2026 维护状态 | 关键局限 | 来源 |
|---|---|---|---|---|---|
| **Super Productivity** | Jira（Cloud & Data Center）、GitHub、GitLab（含自建）、Gitea/Forgejo、Google Calendar、CalDAV；另有 plugin + REST API 做自定义适配 | 开源、免费、local-first（桌面/移动/Web App） | 活跃（官网 © 2026） | **无 Gitee 连接器**；issue 写回失败不自动重试 | [官网集成目录](https://super-productivity.com/integrations/) |
| **GitLab To-Do List**（平台自带） | 仅 GitLab（Issue/MR/里程碑等） | GitLab 自带 | 活跃 | 不跨平台；不覆盖 GitHub/Jira | [docs.gitlab.com/user/todos/](https://docs.gitlab.com/user/todos/) |
| **GitHub 全局 issue 搜索 / Issues dashboard / Inbox** | 仅 GitHub | GitHub 自带 | 活跃 | 不跨平台 | [Searching issues and PRs](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)、[Filtering and searching](https://docs.github.com/zh/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests) |
| **Jira JQL + dashboard** | 仅 Jira | Jira 自带 | 活跃 | 不跨平台（外部代码平台靠 connector 展示，不是可规划待办） | [JQL functions](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/) |
| **Gitee 马建仓「Issue 个人助理」** | 仅 Gitee 企业版内的工作项 | **企业版付费能力** | 活跃 | 只在 Gitee 页面上下文内总结；不跨平台 | [Gitee 帮助中心](https://help.gitee.com/enterprise/ai/program_manage/ai-issue-assistant) |
| **MCP 路线（Atlassian + GitHub + Gitee 官方 server）** | Jira/JSM/Confluence/Bitbucket、GitHub、Gitee | 各家 server 本身免费/自带，宿主客户端另计 | 活跃（Atlassian 正在做 v1→v2 迁移） | 需要 AI 客户端；非可视化面板，无持久化「今日计划」；GitLab 侧需另找 server | [Atlassian MCP](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/)、[Gitee MCP](https://help.gitee.com/ai-productivity/mcp-server) |

### 待核实（本轮未能取得一手来源，勿据此决策）

以下候选只出现在第三方榜单/博客中，本轮按要求未采信为结论，需自行到官网确认后再评估：

- **Sunsama**（宣称集成 Asana/ClickUp/GitHub/Jira/Linear/Notion/Trello 等，约 US$16–20/月，无免费档）——二手来源：[Motion 博客](https://www.usemotion.com/blog/best-time-blocking-apps.html)、[Digital Project Manager](https://thedigitalprojectmanager.com/tools/best-free-productivity-apps/)；一手页面仅拿到微软认证页（只描述"每日规划器"，无集成清单）：[Summay, Inc. / Sunsama](https://learn.microsoft.com/en-za/microsoft-365-app-certification/teams/summay-inc-sunsama)
- **Plane**、**YouTrack**、**Linear**、**Vikunja**、**OpenProject**、**Leantime**、**Focalboard**、**Gitify**、**Notion/ClickUp/Todoist 的 GitHub/Jira 连接器**、**Beebox/Weave/Zenko 等已停服项目**——本轮均未取得一手来源，状态与能力**未核实**。

> 说明：Jira 术语已从 issue→work item、project→space 迁移（见 JQL 文档示例 "Find work items that are assigned to you"），检索这些产品文档时需注意用新词。

## 各平台原生「分配给我」能力（已核实的一手细节）

### GitHub

- 搜索可**全局跨所有 GitHub**，或限定到某个组织：原文 "You can search for issues and pull requests globally across all of GitHub, or search for issues and pull requests within a particular organization."
- `assignee` 限定符：可查某人被分配的 issue/PR；通配符 `*`（任意受理人）**只在单仓库内可用**——原文 "You can search for issues and pull requests that have *any* assignee by using the wildcard character `*`, but only within a single repository."
- `@me` 语法：可查自己创建或参与过的条目。
- 规模上限：可访问的 PR 超过 10,000 个仓库时，必须把查询限定到具体 org/user/repo 才有结果。
- 仓库内 issue 列表的默认筛选器包含「分配给你的议题和拉取请求」，并可用 `user:` / `org:`（各最多 16 个）组合多仓库范围。
- 来源：[Searching issues and pull requests](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)、[筛选和搜索议题以及拉取请求](https://docs.github.com/zh/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)

实用查询（由上述文档语法直接组合）：`is:issue is:open assignee:@me`，可自行追加 `org:xxx`、`-label:` 等。

### GitLab

- To-Do List 是 GitLab 自带的个人待办面，覆盖分配给你的 Issue/MR 等；文档记录了按组视图（`todos_grouped_view`，19.6 GA）、snooze（17.9）、批量编辑（17.10）等演进。
- API：`GET /api/v4/todos?action=assigned&type=Issue`；CLI：`glab todo list --action=assigned --type=Issue --output=json`。
- 跨项目 issue 查询亦可用 `GET /issues?assignee_username=<name>`。
- 来源：[GitLab To-Do list](https://docs.gitlab.com/user/todos/)、[Issues API](https://docs.gitlab.com/api/issues/)

### Jira

- JQL 函数 `currentUser()`：文档原文示例 "Find work items that are assigned to you: `assignee = currentUser()`"；支持该函数的字段包括 Assignee、Reporter、Voter、Watcher、Creator，且仅登录用户可用。
- 其他相关函数：`openSprints()`、`closedSprints()`、`membersOf()`、`workItemHistory()` 等。
- 来源：[JQL functions](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/)

实用查询：`assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC`，或迭代视角 `assignee = currentUser() AND sprint in openSprints()`。

### Gitee

- 官方个人向能力是**企业版**马建仓 AI 助手的「Issue 个人助理」：在"企业工作台、项目工作项列表、迭代工作项列表等任意包含 issue 列表的页面"召唤助手，可问"我今天有什么任务要完成？"，AI 会筛选并总结当前用户负责的工作项、结合优先级/截止时间/状态生成今日或本周计划。范围限于 Gitee 内部。
- API 侧：`https://gitee.com/api/v5/swagger` 为官方 Open API v5 文档入口，OAuth scope 含 `issues`、`notifications` 相关能力（scope 列表：`user_info projects pull_requests issues notes keys hook groups gists enterprises`）。
- 来源：[Issue 个人助理](https://help.gitee.com/enterprise/ai/program_manage/ai-issue-assistant)、[Gitee OAuth 文档](https://gitee.com/api/v5/oauth_doc)

## 自建方案路径

四家都有可支撑「我的待办」的官方端点，聚合面板技术上完全可行，工作量主要在鉴权与去重：

- **GitHub**：`GET /search/issues?q=is:issue+is:open+assignee:@me`（全局搜索，注意上面的 10,000 仓库上限规则）；通知侧用 notifications API 可拿到 `reason: "assign"` 这类分配事件。来源：[Searching issues and PRs](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)
- **GitLab**：`GET /api/v4/todos?action=assigned&type=Issue`（一次拿全「分配给我的」，最省事）；或 `GET /api/v4/issues?assignee_username=`。来源：[To-Do list](https://docs.gitlab.com/user/todos/)、[Issues API](https://docs.gitlab.com/api/issues/)
- **Jira**：REST search + JQL `assignee = currentUser() AND statusCategory != Done`。来源：[JQL functions](https://support.atlassian.com/jira-software-cloud/docs/jql-functions/)
- **Gitee**：Open API v5（`issues` scope）+ `/notifications`。注意官方 MCP 只提供仓库级 `list_repo_issues` 与 `list_user_notifications`，跨仓库「分配给我」需自己按仓库遍历或用通知接口。来源：[Gitee MCP Server](https://help.gitee.com/ai-productivity/mcp-server)、[OAuth 文档](https://gitee.com/api/v5/oauth_doc)

**MCP 路线（成本最低的"个人总览"）**：
- Atlassian 官方 MCP：`https://mcp.atlassian.com/v2/mcp`，文档描述为"cloud-hosted MCP server，为 AI 工具提供对 Jira、Confluence、Bitbucket 等 Atlassian 数据的实时安全访问"，可"不切换工具地汇总与搜索 Jira、JSM、Confluence、Projects、Goals 等"；接入示例 `claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp`。注意 v1→v2 迁移：文档写明 **2027-03-01 起现有 v1 用法将自动切换到 v2 工具**，且会消耗 Rovo credit。
- Gitee 官方 MCP：remote 免安装 `https://api.gitee.com/mcp`（Bearer personal access token），或 `npx -y @gitee/mcp-gitee@latest`，源码 `gitee.com/oschina/mcp-gitee`，MIT。
- 来源：[Atlassian MCP server](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/)、[Gitee MCP Server](https://help.gitee.com/ai-productivity/mcp-server)

## 推荐组合与落地建议

针对「后端开发，GitHub 多仓库 + Jira 缺陷 + 可能还有 GitLab/Gitee」这个具体画像：

1. **首选：Super Productivity 作为个人面板**（免费、开源、本地存储、issue 写回原平台）。覆盖 Jira + GitHub + GitLab 三家，日常规划用它的统一任务列表；把每个 provider 的「拉取分配给我的 issue」查询配好即可。Gitee 若为必需，用它的 plugin 机制自行适配。
   注意两条官方告警：**issue 更新失败不会自动重试**（需重连并回原平台核对），以及连哪个服务就会把所需数据交给那个服务（token 存本地、直连）。
2. **次选：轻量自建 + MCP**。不想换 UI 的话，直接在 AI 客户端挂 Atlassian / GitHub / Gitee 官方 MCP，用一句"列出我今天所有平台分配给我的待办并按优先级排序"替代面板；GitLab 侧可补 `glab todo list --output=json`。这条路适合"要总览、不要看板"。
3. **最低成本兜底：不聚合，只做书签化**。四家各自的官方个人视图已经够用：GitHub `is:issue is:open assignee:@me`、GitLab To-Do List、Jira `assignee = currentUser()` 存成筛选器/仪表盘、Gitee 企业版 Issue 个人助理。缺点是仍然四屏切换，但零维护、零数据外泄风险。

## 已核实为不再可用 / 已停服

- 本轮**未**对 Beebox、Weave、Zenko、Height 等常被榜单提及的聚合工具做一手核实，因此不在此列出结论。
- 已核实的**替代/迁移事实**：Atlassian MCP server v1 将在 **2027-03-01** 起自动以 v2 工具暴露（属版本迁移，不是停服）。来源：[Atlassian MCP server 文档](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/)

## 附：Super Productivity 项目时间线（2026-11-16 补充）

一手数据来自 GitHub REST API（git 对象/tag/release）、作者本人 HN 发言、以及最新 release 的 changelog。

| 时间 | 事件 | 来源（一手） |
|---|---|---|
| 2016 年末 | 作者自述开始写："I started building Super Productivity in late 2016 because I needed to log time against my Jira tickets." | 作者 johannesjo 在 HN 的自述帖（2026-01-08 / 01-09）：https://hn.algolia.com/api/v1/search?query=%22Super+Productivity%22&tags=story （story 46552115） |
| 2017-01-06 | 公开仓库创建（`created_at: 2017-01-06T22:30:58Z`） | GitHub API：https://api.github.com/repos/super-productivity/super-productivity |
| 2017-02-04 | **首个 v1.0.0 annotated tag**（tagger: Johannes Millan，`2017-02-04T19:01:19Z`，message "Release v1.0.0"） | GitHub API：https://api.github.com/repos/super-productivity/super-productivity/git/ref/tags/v1.0.0 → git/tags/51145b52 |
| 2017-02-05 | 作者第一次公开推广："New Personal to Do List / Time Tracking Tool for Programmers with Jira Support"，HN 仅 1 分、3 评论——**当时只支持 Jira** | HN Algolia API story 13570166 |
| 2018-03-30 | 作者发帖 "Big Update for Productivity App SuperProductivity"（1 分） | HN story 16717538 |
| 2020 全年 | 多次 HN 发帖均 1–2 分（自由职业者时间追踪、远程办公等角度） | HN stories 22775107 / 23616834 / 23712358 / 24268866 / 24690739 |
| 2024-09-23 | 作者宣布 **V10** 发布 | HN story 41625779 |
| 2025-09-14 | 作者宣布 **v15**："complete UI overhaul" | HN story 45241968 |
| 2026-03 前 | 仓库从个人账号迁到组织：`johannesjo/super-productivity` → `super-productivity/super-productivity`（API 现解析到组织 owner） | GitHub API repo 元数据 + HN story 47249435（2026-03-04） |
| 2026-11-06 | **v20.0.0** 发布（latest release，由 github-actions 自动发布） | GitHub API：https://api.github.com/repos/super-productivity/super-productivity/releases/latest |
| 2026-11-14 | 最近一次 push（仍在活跃开发） | GitHub API repo 元数据 `pushed_at` |

### 2026-11 现状指标（GitHub API，round-trip 于 2026-11-16）

- stars **23,712**、forks 2,373、subscribers 151、open issues 1,232、语言 TypeScript、MIT、仓库体积约 190 MB。
- v20.0.0 单次 release 的 changelog 列出 **27 位贡献者**、11 位首次贡献者，PR 编号已到 11,4xx 量级——社区规模已不是个人项目。
- v20.0.0 分发渠道（release assets）：Windows（x64/arm64/Setup）、macOS（arm64/universal/x64 dmg）、Linux（.deb/.rpm/.snap/AppImage）、Android APK，另有 **`super-productivity.mcpb`**（MCP server bundle）。官网另列 Microsoft Store / App Store / Google Play / Snap / Flathub 链接。

### 关于「广为人知」的判断（附证据边界）

- **它不是靠某一次爆款传播起来的。** HN 上以 "Super Productivity" 为标题的 story 共 29 条，最高仅 28 分（2023-12-16，非作者转发），作者自己的发帖长期停留在 1–2 分。可见 HN 从未形成病毒式关注。
- **增长方式是「慢积累」**：2017 年 v1.0 起持续发布，2024→2026 三年间从 v10 走到 v20（约每 5–6 个月一个大版本），配合包管理器/应用商店分发与 plugin 生态。作者自评 8 年（2026-01）。
- 本轮**未能取得** star 增长曲线的一手数据（GitHub API 不提供历史 star 时间序列；anonymous stargazer 列表无 `starred_at`），因此「哪一年开始广为人知」只能定性判断为 **2023 年之后逐步进入主流开源工具推荐视野**，属推断而非核实结论。

### v20.0.0 changelog 对主报告的两处修正/补充

1. **Provider 架构变化**："Moved GitLab into a bundled plugin." —— GitLab 支持已从内置 provider 改为随包发布的 plugin；后续核对连接器清单时要以最新版为准。
2. **平台覆盖扩大**："Added an option to include Gitea pull requests and support for sending task completion to **Azure DevOps work items**." —— 主报告 TL;DR 中「没有任何产品原生同时接 GitHub+GitLab+Gitee+Jira」的结论不变（仍无 Gitee），但可聚合的代码/缺陷平台数量比上一版调研描述更多（新增 Azure DevOps 方向）。
3. 新增 `super-productivity.mcpb` 说明官方已开始提供 MCP 打包件，与主报告「MCP 作为替代聚合层」的判断一致。

## 来源清单

一手来源（本报告结论均出自以下条目）：

- Super Productivity 官网集成目录与 FAQ — https://super-productivity.com/integrations/
- Super Productivity 官网首页（"Integrates with Jira, GitHub, GitLab and more"）— https://super-productivity.com/
- Super Productivity 文档锚点（README `#issue-provider-integration`、`#plugins`）— https://github.com/johannesjo/super-productivity/blob/master/README.md （注：该仓库页面本轮 WebFetch 多次失败，provider 清单以官网集成页 + 官网对 README 锚点的引用为准）
- GitLab 官方文档 To-Do list — https://docs.gitlab.com/user/todos/
- GitLab 官方 Issues API — https://docs.gitlab.com/api/issues/
- GitLab CLI `glab issue list` — https://gitlab.cn/docs/cli/issue/list/
- GitHub 官方文档 Searching issues and pull requests — https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
- GitHub 官方文档 筛选和搜索议题以及拉取请求 — https://docs.github.com/zh/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests
- Atlassian 官方 JQL functions — https://support.atlassian.com/jira-software-cloud/docs/jql-functions/
- Atlassian 官方 MCP server 文档 — https://support.atlassian.com/atlassian-rovo-mcp-server/docs/use-atlassian-rovo-mcp-server/
- Gitee 帮助中心「Issue 个人助理」（企业版）— https://help.gitee.com/enterprise/ai/program_manage/ai-issue-assistant
- Gitee 帮助中心「Gitee MCP Server」— https://help.gitee.com/ai-productivity/mcp-server
- Gitee Open API v5 OAuth 文档 — https://gitee.com/api/v5/oauth_doc

二手来源（仅用于「待核实」线索，不作为结论依据）：

- Summay, Inc. / Sunsama 微软认证页（一手但无集成清单）— https://learn.microsoft.com/en-za/microsoft-365-app-certification/teams/summay-inc-sunsama
- Motion 博客 time-blocking 工具对比 — https://www.usemotion.com/blog/best-time-blocking-apps.html
- The Digital Project Manager 工具清单 — https://thedigitalprojectmanager.com/tools/best-free-productivity-apps/
