---
question: Super Productivity 是怎么做的——多 provider 抽象、插件化边界、轮询/同步策略、凭据与数据存储、限流与错误处理，以及对「个人跨平台任务面板」自建的直接可借鉴点
date: 2026-11-16
method: 仅采用一手来源 = 官方仓库 `super-productivity/super-productivity`@master 的**源码原文**与**仓库内文档/ADR**。逐条 claim 标注文件路径；抓取通道为 GitHub 页面内嵌的 `rawLines`（源码逐行原文）与 `richText`（markdown 渲染原文），未采用任何博客/评测/官网营销页转述
status: 已逐行核实——核心 provider 契约、插件 provider 契约、官方「新增集成」流程、bundled 插件清单、凭据 API 语义、HTTP 错误处理器、GitHub 鉴权方式、ADR#3/#4/#9/#10。仍未取一手——轮询调度实现（`issue.service.ts` 正文）、各 provider 的 429 退避策略、`issue-provider-kit` 导出清单、SuperSync 服务端正文——均列入「待核实」并给实测配方
related: [personal-cross-platform-issue-dashboard.md, platform-limits-and-landing-form.md]
---

# Super Productivity 的实现方式（源码级）

> 取证基线：repo id `78243781`，owner 已是组织 `super-productivity`（不是个人账号），default branch `master`，本轮所有文件取自 commit `2b3f78edbf0721f0842daa097e47247fe245852f`。仓库根含 `AGENTS.md`、`CLAUDE.md`(symlink)、`.claude/`、`ARCHITECTURE-DECISIONS.md`、`eslint-local-rules/`——这个项目的架构约束是**写给 agent 和 lint 强制执行的**，不是只写在文档里。

## 结论摘要（TL;DR）

1. **它把「接入一个平台」收敛成一份 ~200 行的类型契约，并且官方明文禁止再往核心里加 provider。** `docs/add-new-integration.md` 第一句：「New external issue and calendar integrations should be **issue-provider plugins**. Do not add a new built-in provider to `src/app/features/issue/providers/` unless a maintainer has approved a core-only requirement that the plugin API cannot meet.」理由写得很具体：新增核心 provider 会产生「permanent unions, configuration state, forms, migrations, and sync compatibility」。→ 这就是这类工具能撑到 9+ 家连接器的唯一可行解。
2. **GitHub / GitLab / Gitea / Azure DevOps / Linear / ClickUp / Trello / Redmine / Nextcloud Deck 全都是插件**，在 `packages/plugin-dev/*-issue-provider/`，随应用打包（`src/assets/bundled-plugins/`）；**Jira / OpenProject / PlainSpace / CalDAV / calendar 才是核心内置**（`src/app/features/issue/providers/` 下只有这 5 个目录）。这校准了前一份笔记的隐含印象：不是「SP 原生支持 GitHub」，而是「SP 用插件层支持 GitHub，只是这个插件官方自带」。
3. **轮询节奏由 provider 自己声明，官方最小 manifest 示例就是 `pollIntervalMs: 600000` = 10 分钟**；核心契约 `IssueServiceInterface.pollInterval` 注释「0 means no polling」。→ 你上一轮定的「每 10 分钟拉一次」正好是这个项目自己选的默认值，不是拍脑袋。
4. **批量刷新是契约级能力，不是优化项。** 插件侧有可选 `getByIds(issueIds[], ...)`，官方注释：「used when refreshing many tasks at once. Implement it when the API can return several issues in one request. Ids missing from the result is skipped (not treated as deleted).」核心侧对应 `getFreshDataForIssueTasks(tasks: Task[])`（复数版）。→ 每轮 = 每 provider 约 1 次请求，而不是每 task 一次。这直接改写前一份笔记「轮询成本模型」的分母。
5. **凭据分两条路，且官方把安全边界写得很坦白**：
   - OAuth：插件声明 `oauth` + `http` 权限、放一个 `type: 'oauthButton'` 字段 + `OAuthFlowConfig`，**由宿主完成平台适配的授权流程并存 token**，插件只 `await PluginAPI.getOAuthToken()`。原文警告：「A `clientSecret` embedded in plugin source or configuration is **not confidential**.」= 只做公开客户端（PKCE）。
   - PAT/密码：`PluginAPI.setSecret/getSecret/deleteSecret`，**每设备、不进同步/导出/备份**，且原文直说「They are currently **unencrypted at rest**, so this is an isolation boundary, not hardware-backed secure storage. Users must enter the secret again on each device.」`type: 'password'` 只是遮 UI。
   - GitHub 侧就是**用户自填 classic PAT + `repo` scope**（`docs/github-access-token-instructions.md` 全文 11 行，还补一句「Fine-grained tokens may work but classic tokens are recommended and tested」）。
6. **写回全部是可选能力 + 默认保守。** `fieldMappings` 每条带 `defaultDirection: 'off' | 'pullOnly' | 'pushOnly' | 'both'`，官方指引「Default a mapping to `off` or `pullOnly` when remote write behavior is surprising」；`updateIssue/createIssue/deleteIssue`、`timeBlock`、`timeTracking` 全是 optional。日历写回更进一步：ADR#9「Calendar Writes Live in Plugins, Behind Per-Provider Opt-In」，SP 永不是日历的 source of truth。
7. **同步不是「纯本地无后端」**：op-log（append-only）+ **vector clock**（ADR#10，`MAX_VECTOR_CLOCK_SIZE = 20`）+ 官方 `packages/super-sync-server`（PostgreSQL，`docker-compose.supersync.yaml`），同时保留 WebDAV/Dropbox/本地文件型 provider。provider 的**配置**参与同步（`entity-registry` 里 `ISSUE_PROVIDER`），**token/secret 不参与**（per-device）。
8. **身份即数据契约**：`src/app/plugins/bundled-plugins.const.ts` 顶部注释——插件 `id` 会成为它持久化数据的前缀 `<pluginId>:<key>`（IDB、op-log、同步线上），「Once a plugin ships, renaming its id orphans every user's stored data」。同时 `BUNDLED_PLUGIN_IDS` 是**保留 id 集合**，上传插件不得复用，否则未审代码可冒充内置插件（该不变量由 `electron/bundled-plugin-ids.test.cjs` 守住）。

---

## 1. 分层：一条抽象、两套实现

一手依据：`git/trees/master:src/app/features/issue/providers` 与 `:packages/plugin-dev` 的递归列举 + `docs/add-new-integration.md`。

```
src/app/features/issue/
├── issue-service-interface.ts     ← 内置 provider 契约（legacy，但仍是运行时真接口）
├── issue.service.ts (41 KB)       ← 宿主调度：轮询、刷新、映射到 task
├── handle-issue-provider-http-error.ts ← 所有 provider 共用的错误出口
├── cert-trust.service.ts          ← 自建实例证书信任
├── two-way-sync/  issue-sync-state/  mapping-helper/  store/  base/  providers/
└── providers/{jira, caldav, calendar, open-project, plainspace}   ← 只有 5 个内置
packages/
├── plugin-api/src/{issue-provider-types.ts, types.ts, global.ts}   ← 公开契约（权威）
├── plugin-dev/{github,gitlab,gitea,azure-devops,linear,clickup,trello,redmine,nextcloud-deck}-issue-provider
├── plugin-dev/{google-calendar,caldav}-calendar-provider + issue-provider-kit
├── super-sync-server/  sync-core/  sync-providers/
```

- 内置 provider 每家目录固定 6 件套：`*-api.service.ts`（HTTP）、`*-common-interfaces.service.ts`（实现契约）、`*-issue-map.util.ts`（响应→`IssueData`）、`*-cfg-form.const.ts`（表单）、`*-issue.model.ts`、`is-*-enabled.util.ts`。Jira 额外有 `jira-issue.effects.ts`(16 KB)、`jira-electron-bridge.service.ts`（走 Electron 主进程绕 CORS/证书）、`dialog-jira-transition*`（状态流转）。
- 宿主侧 `src/app/plugins/`（58 个文件）是完整的插件运行时：`plugin-loader.service.ts` / `plugin-runner.ts` / `plugin-security.ts` / `plugin-bridge*.service.ts` / `oauth/` / `secret/` / `store/` / `plugin-cache.service.ts` / `plugin-persistence.model.ts`，并有 `plugin.service.load-from-zip.spec.ts` → 支持用户上传 zip 插件。
- 内置清单（`BUNDLED_PLUGIN_PATHS`，24 项）：9 个 issue provider + 2 个 calendar provider + `automations`、`sync-md`、`doc-mode`、`ai-command`、`brain-dump`、`voice-reminder`、`app-auto-track`、`todoist-import`、`ticktick-import`、`parallel-code`、`procrastination-buster`、`yesterday-tasks-plugin`、`api-test-plugin`（最后一项标 `DEV_ONLY_BUNDLED_PLUGIN_IDS`）。

## 2. 核心侧契约（`src/app/features/issue/issue-service-interface.ts`，60 行全文）

```ts
export interface IssueServiceInterface {
  // MANDATORY
  isEnabled(cfg: IssueIntegrationCfg): boolean;
  testConnection(cfg: IssueIntegrationCfg): Promise<boolean>;
  pollInterval: number;                       // 0 means no polling
  issueLink(issueId, issueProviderId): Promise<string>;
  getById(id, issueProviderId): Promise<IssueData | null>;
  getAddTaskData(issueData: IssueDataReduced): IssueTask;
  searchIssues(searchTerm, issueProviderId): Promise<SearchResultItem[]>;
  also used to determine if task is done →
  getFreshDataForIssueTask(task): Promise<{taskChanges, issue, issueTitle} | null>;
  getFreshDataForIssueTasks(tasks: Task[]): Promise<{task, taskChanges, issue}[]>;
  // OPTIONAL
  getMappedAttachments?(issueData): TaskAttachment[];
  getNewIssuesToAddToBacklog?(issueProviderId, allExistingIssueIds): Promise<IssueDataReduced[]>;
  getSubTasks?(issueId, issueProviderId, issue): Promise<IssueDataReduced[]>;
  updateIssueFromTask?(task: Task): Promise<void>;
}
```

值得抄的三处细节：
- `getFreshDataForIssueTask` 返回的是 **`Partial<Task>` 补丁**而不是整个 task——provider 只声明「哪些字段变了」，宿主负责合并。这是「多 provider 不互相踩」的关键。注释还点明这个方法同时充当「是否已完成」的判定源。
- `getNewIssuesToAddToBacklog(issueProviderId, allExistingIssueIds)`：**宿主把本地已有 id 传进来**，provider 自己差集。→ 自动导入 backlog 不需要服务端记录游标，天然幂等。
- `getSubTasks` / `updateIssueFromTask` 可选 → 不支持子任务或禁止写回的平台可以完全不实现。

## 3. 插件侧契约（`packages/plugin-api/src/issue-provider-types.ts`，331 行）

`IssueProviderPluginDefinition` 必填 6 项、可选 12 项：

| 成员 | 必填 | 一手语义（摘自原文注释） |
|---|---|---|
| `configFields: PluginFormField[]` | ✅ | 表单即数据；`type` 含 `input/password/textarea/checkbox/select/multiSelect/link/**oauthButton**`；支持 `advanced`（折叠进 Advanced Config）、`showIf`（依赖别的 key）、`pattern`、`oauthConfig`、`loadOptions(config, http)`（**OAuth 之后动态拉选项**，如选 workspace） |
| `getHeaders(config)` | ✅ | 可 async → 供 `await getOAuthToken()` 后拼 `Authorization` |
| `searchIssues` / `getById` | ✅ | 走注入的 `http: PluginHttp`，插件不自己 import axios |
| `getIssueLink` | ✅ | 同步返回字符串 |
| `issueDisplay: PluginIssueField[]` | ✅ | `{field,label,type:'text'|'markdown'|'link'|'date'|'list',linkField,hideEmpty}`——**渲染由数据描述驱动**，宿主不为每家写模板 |
| `getByIds?` | 可选 | 批量刷新；缺失 id 视为「跳过」而非「已删除」 |
| `testConnection?` / `getNewIssuesForBacklog?` | 可选 | backlog 自动导入 |
| `fieldMappings?: PluginFieldMapping[]` | 可选 | `taskField ∈ isDone/title/notes/dueDay/dueWithTime/timeEstimate/tagIds`，`issueField` 为远端路径，`defaultDirection ∈ off/pullOnly/pushOnly/both`，`mutuallyExclusive?: string[]`（例：`dueWithTime` 与 `dueDay` 互斥），`toIssueValue/toTaskValue` 双向转换函数 |
| `updateIssue?` / `createIssue?` / `deleteIssue?` / `extractSyncValues?` | 可选 | 反向写回；`extractSyncValues(issue)` 挑出「值得存进同步」的字段 |
| `doneStates?` / `deletedStates?` | 可选 | 原文：默认把 `closed/done/completed/resolved` 当完成；**空数组表示任何状态都不算完成**；只有非空数组才会让「刷新」改动 task 完成态；`state` 未设时刷新保留原完成态 |
| `timeBlock?: {upsertEvent, deleteEvent, logWorkSession?}` | 可选 | 把任务定时到日历；`logWorkSession` 只在**跟踪它的那台设备**上调用，且受 well-known key `isLogWorkSessions` 控制 |
| `timeTracking?: PluginTimeTracking` | 可选 | `logTime` / `getTimeLogged?` / `getActivities?`；行为由 well-known config keys 控制：`isShowTimeTrackingDialog`、`isShowTimeTrackingDialogForEachSubTask`、`timeTrackingDialogDefaultTime`(`AllTime|AllTimeMinusLogged|TimeToday|TimeYesterday`)、`isSubmitWorklogOnFinishDay` |
| `commentsConfig?` | 可选 | 声明 `authorField/bodyField/createdField/avatarField/sortField`——评论也是靠字段路径映射，不是硬编码 |

数据结构刻意做小（其余走 `[key: string]: unknown` 索引签名）：
- `PluginSearchResult`: `id,title,url?,status?,assignee?,labels?,start?,dueWithTime?,duration?,isAllDay?,description?,color?`
- `PluginIssue`: `id,title,body?,url?,state?,lastUpdated?,assignee?,labels?,comments?,points?`（`points` → task 的 `issuePoints`）
- `PluginHttp`: `get/post/put/patch/delete` + **`request(method, ...)` 以支持 `PROPFIND`/`REPORT`**（CalDAV 需要），`PluginHttpOptions.responseType: 'json'|'text'`（XML/iCal）、`timeout`

`IssueProviderManifestConfig`（manifest 里的 `issueProvider` 块）：`pollIntervalMs`、`icon`、`humanReadableName?`、`issueStrings?{singular,plural}`、`useAgendaView?`（日历式日程视图）、`defaultAutoAddToBacklog?`、`issueProviderKey?`（**只为迁移内置 provider 保留**，新插件由宿主赋 `plugin:<plugin-id>`）、`allowPrivateNetwork?`。最后一条原文：「Default is false — **SSRF protections block private IPs and localhost**」，只有像自建 CalDAV 这种场景才申请开启。

## 4. 官方「新增一个集成」流程（`docs/add-new-integration.md`，7 节）

1. **建包**：`packages/plugin-dev/<provider-name>/`，含 `package.json`、`tsconfig.json`(extends `../tsconfig.base.json`)、`i18n/`、`src/{manifest.json,plugin.ts,icon.svg}`、`*.spec.ts`；build 脚本统一 `"build": "node ../scripts/build-with-esbuild.js"` → 产出 `dist/plugin.js` 并复制 manifest/`config-schema.json`/icon/i18n。公共重复逻辑（auth headers、connection test、`t()`、done/text 字段映射、sync value picking）从 **`issue-provider-kit`** 按相对路径 import——「they are bundled into the plugin, **not part of the public plugin API**」。硬约束：「**Do not add the provider to core issue-provider unions, defaults, forms, or Angular services.**」
2. **注册**：`PluginAPI.registerIssueProvider(def)`，且「Implement the exact current type rather than copying a method list into the plugin」。
3. **凭据**：见 TL;DR 第 5 条。附加红线：「**Never log tokens, authorization headers, response bodies containing user content, or issue titles.**」
4. **映射**：远端 id 一律 `String`；时间戳显式转换并测时区/全天；只返回契约需要的字段；`fieldMappings` 只为「safe, reversible semantics」定义；create/update/delete **尽量幂等**；「**Handle rate limits, pagination, deleted states, and partial API responses**」；provider 专有数据留在插件内，不扩核心模型。
5. **打包**：加进 `packages/plugin-dev/scripts/build-all.js` → 产物复制到 `src/assets/bundled-plugins/<dir>` → 在 `bundled-plugins.const.ts` 同补 `BUNDLED_PLUGIN_PATHS` 与 `BUNDLED_PLUGIN_IDS` + 给目录加 `package.json`（release 构建会跳过没有的）→ 每个插件目录都是 `packages/plugin-dev` 的 workspace，必须提交共享 `package-lock.json` 否则 `npm ci` 全挂 → 只写英文源串、走插件 i18n → **「Update the issue-provider comparison in `docs/wiki/` in the same change」**（对比文档和代码同 PR 更新，防文档漂移）。社区上传插件「do not need core registration」。
6. **验证**：包内 `npm run typecheck / npm test / npm run build`，再仓库级 `npm run plugins:build`，最后**在 web、Electron 和每个声明的原生平台手工**验证配置、连接测试、搜索/导入、轮询、以及任何开启的写回。缺测试时明确要补的 5 类：response mapping、authentication failures、pagination、dates、write-back conversions。
7. **Legacy core providers**：内置那 5 家仍实现 `IssueServiceInterface`；「Do not follow that path for a new integration without an explicit architecture decision explaining why the plugin contract is insufficient.」

## 5. 轮询、限流与错误处理

- **节奏声明位**：manifest `issueProvider.pollIntervalMs`（示例 600000）/ 核心 `pollInterval`（0=关）。具体怎么被 `issue.service.ts` 消费（是否错峰、是否仅前台）**未取一手**，见「待核实 1」。
- **请求次数控制**：靠契约的复数刷新方法（`getFreshDataForIssueTasks` / `getByIds`）而不是靠调用方自觉。
- **共享错误出口** `src/app/features/issue/handle-issue-provider-http-error.ts`（72 行，全文已读）：
  - `handleIssueProviderHttpError$(issueProviderKey, snackService, error)`，日志**只记元数据**：`issueProviderKey / status / errorBodyName / isClientError / hasErrorBody / hasMessage / hasStatusText / hasUrl`——没有响应体、没有标题。
  - 这一行很重要：`// eslint-disable-next-line local-rules/no-user-content-in-logs -- grandfathered log baseline (2026-09), not yet triaged` → 项目有**自定义 ESLint 规则禁止用户内容进日志**，并对历史遗留做了显式「豁免基线」登记。
  - 用户提示分 3 类：`ErrorEvent` → 网络错误文案 + provider 名；`error.error.message` → `providerName: message`；有 `status` → 通用文案 + `Unknown error ${status}`。
  - **URL 掩码**（原文注释）：「Angular bakes the request URL into `message`; **it can carry a token** and the handled error is logged whole, so mask it the way the provider dialog does.」实现是把 `error.url` 从 message 里替换成 `…`。
  - 重抛 `{ [HANDLED_ERROR_PROP_STR]: ... }`，用全局标记防止上层重复报错。
  - **这个文件里没有 429 退避逻辑**——限流处理按第 4 节第 4 条下放到各 provider。是否所有 provider 都实现了退避、是否有全局队列，**未核实**（见待核实 2），不要当成「SP 有统一退避」。
- **证书**：`cert-trust.service.ts` + Jira 的 `jira-electron-bridge.service.ts` 说明「自建实例 + 自签证书」是真实痛点，被专门做了核心能力。

## 6. 同步与冲突（`ARCHITECTURE-DECISIONS.md`，已读全文对应段）

- **ADR#10「Vector Clocks over Server-Side Entity Versioning」**：坚持客户端持有因果历史（`MAX_VECTOR_CLOCK_SIZE = 20`）；服务端实体版本化的设计**已完成但决定不建**；SuperSync 服务端只做冲突检测（`packages/super-sync-server/src/sync/conflict.ts` 的 `detectConflict`）。理由：文件型 provider（WebDAV/Dropbox/local file）没有服务端，必须保留 clock 路径。→ 这是「兼容无后端同步」倒逼的架构选择，代价是每台客户端都要带 clock。
- **ADR#4**：`user_sync_state.lastSeq` 行锁 + 串行 `processOperation`；批量上传引擎**从未在生产启用，2026-08 已删除**（#9508）；对比数据 25-op 批量 ~10 SQL vs 串行 ~127。
- **ADR#9「Calendar Writes Live in Plugins, Behind Per-Provider Opt-In」**：SP 永不是日历权威；内置 iCal/CalDAV feeds（`src/app/features/schedule/ical/`）只 poll+parse；内置 provider 不实现 `timeBlock`；插件 provider 只在 `isAutoTimeBlock` 开启时写；work session 只存本地 `LS.WORK_SESSION_LOG` 不同步；日历事件**不是 op-log 实体**，转任务用派生稳定 id（`generate-calendar-task-id.ts`）；但 provider **配置**参与同步（`src/app/op-log/core/entity-registry.ts` 的 `ISSUE_PROVIDER`）；manifesto 原文「opt-in, quiet by default」；vendor OAuth/throttling 全留在 `packages/plugin-dev/`，坏 provider 退化为只读。
- **ADR#3「Sync Package Boundary Direction」**：`src/app` 组装、`@sp/sync-providers` 内置 provider、`@sp/sync-core` 框架无关原语，**由 ESLint 强制包边界**（`eslint.config.js` + `eslint-local-rules/`）。
- 加密：SuperSync 侧有 E2EE 相关文档（`docs/sync-and-op-log/supersync-encryption-architecture.md`、`docs/supersync-encryption-at-rest-decision.md`），本地 secret 则明确**未加密 at rest**（见 §4 第 3 步）——两者是不同边界，别混。

---

## 对「个人跨平台任务面板」自建的直接可借鉴点（含代价）

| SP 的做法 | 你该怎么用 | 代价 / 差异 |
|---|---|---|
| 一份 provider 契约 + 全部能力可选化（`getByIds?`/`getNewIssuesForBacklog?`/`updateIssue?`/`timeBlock?`） | 第一行代码就定契约：`enabled / testConnection / pollIntervalMs / search / getById / getByIds / listAssignedToMe / toTaskPatch / mapping`。**assignee 过滤必须是一等成员**（四家里只有 GitLab 有原生跨项目 `issues?assignee_username`，GitHub 靠 `is:issue is:open assignee:@me` 搜索，Gitee 只能遍历仓库/通知——契约必须容得下「实现不出来」） | 早期只有 2 家时这层抽象看起来纯属多余，且可选项组合会让测试矩阵爆炸（SP 用每家 `*.spec.ts` + 5 类必测场景来还这笔债） |
| 返回 `Partial<Task>` 补丁而非整对象 | 你的 `refresh()` 也返回 changes patch，宿主统一 merge | 需要一开始就定义「谁拥有哪个字段」，否则 patch 互相覆盖 |
| `getByIds` 批量 + provider 自己差集（`allExistingIssueIds` 传进去） | 每轮每平台 1 次请求；backlog 导入用「宿主传已有 id」而不是服务端游标 | 前置条件是平台支持批量查询（Jira 有 JQL 一次多 id；Gitee 没有，只能仓库粒度） |
| 轮询周期是 **provider 常量**（600000）而非用户设置 | 别让每个用户调 interval；按平台成本给常量，用户只能开/关 | 用户会抱怨「不够快」；SP 的解法是同时提供手动刷新 |
| `doneStates`/`deletedStates` + 「state 未设就不改完成态」 | 把「远端状态 → 本地是否完成」做成**数据**而不是代码分支 | 每平台默认值都要实测（GitHub `closed`、Jira 各 workflow 自定义 status、飞书任务状态、Gitee `progress`） |
| `fieldMappings.defaultDirection` 默认 `off`/`pullOnly`，写回全可选 | 首版**只做只读聚合 + 一个平台的写回**（建议 GitHub 评论/关闭，或 Jira transition）；双向同步等第 3 版 | 会丢掉「面板里直接改状态」这个卖点；SP 官网对写回的告警（失败不自动重试）说明这块是投诉源 |
| secret per-device、不进同步、明确「unencrypted at rest」 | **你反过来**：Web 多租户必须服务端持 per-user refresh token → 需要 at-rest 加密 + 每租户 scope 收窄 + 可撤销入口 | 于是 SP 的「让用户填 classic PAT」这条路对 Jira **不能用**：Atlassian 政策禁止收集用户 token（见 `platform-limits-and-landing-form.md`），Jira 侧只能 3LO；GitHub 侧可以照抄（PAT），但更好的是 GitHub App |
| `allowPrivateNetwork` 默认 false，SSRF 拦私网/localhost，开需要审批 | 你做服务端代理，**这条是必抄项**：出网前解析并拒绝 RFC1918/loopback/link-local/云元数据 IP，自建 Jira/GitLab 走显式 allowlist + 人工审批 | 会挡掉一部分「公司内网 Jira」用户；但不做的后果是站点成为内网跳板，属真实风险不是理论风险 |
| 插件 id = 存储前缀，改名孤立用户数据；内置 id 保留防撞 | 从第一天把 `providerType` 字符串、持久化 key、同步实体名当**不可变 API** 对待，写进文档 | 早期你会想改名重构；SP 的答案是「不能改，别改」 |
| `dataSharing: [{recipient, userServer, data:[credentials,userText]}]` 在连接时展示给用户 | 每个 provider 声明「把哪些数据交给谁」，在授权页显示，并由测试强制（bundled 必须声明） | 你要逐平台核对字段，写错比不写更糟；但对国内合规沟通很有用 |
| 对比文档（`docs/wiki/3.07-Issue-Integration-Comparison.md`）与代码**同 PR 更新** | 维护一张「能力 × 平台」矩阵，加平台时必须改它 | 每加一个 provider 多一天文档工时 |
| `no-user-content-in-logs` 自定义 lint 规则 + 豁免基线 | 日志白名单化：只记 `provider/status/hasErrorBody`；把 URL 里的 token 掩掉 | 排障信息变少；SP 用「豁免基线 + 逐步 triage」来落地，而不是一次改完 |

**立场**：SP 用 9 年、约 2.4 万 star 换到的最硬一条经验是——**这类产品的复杂度全在「状态语义」和「凭据策略」上，不在 UI 上**。契约只有 200 行，但 `doneStates` 的默认值、`timeTrackingDialogDefaultTime` 这类 well-known config key、classic-vs-fine-grained PAT 的取舍，都是踩出来的。所以自建时应该把工程预算放在「每平台的能力矩阵 + 只读聚合 + 一家写回」，而不是放在看板交互上。
**代价**：SP 是 local-first 单用户客户端，你的目标是多租户 Web。**它的答案里大概有 60% 能直接搬（契约、映射、批量、错误出口、SSRF、id 不可变），40% 要重写（凭据托管、同步、调度触发）**——尤其它完全没有「服务端定时任务」「集中配额」这两块，而这恰是你受 Qoder Sites / Atlassian Global Pool 约束最紧的地方。

## 待核实（附自证配方）

1. **轮询如何被调度**（是否错峰 / 是否只在可见时轮询 / 手动 refresh 走哪条路径）。`issue.service.ts` 有 41 KB，本轮未读正文。配方：对该文件 Grep `pollInterval|setInterval|interval|visibility|refreshIssues`（`https://github.com/super-productivity/super-productivity/blob/master/src/app/features/issue/issue.service.ts`）。
2. **各 provider 的 429/Retry-After 处理**。共享错误处理器里没有，指引只写「handle rate limits」。配方：在 `packages/plugin-dev/github-issue-provider`、`gitlab-issue-provider`、`jira` 内 Grep `429|Retry-After|secondary|backoff|retry`。
3. **`issue-provider-kit` 到底导出哪些 helper**（§4 只说了用途类别，未看清单）。配方：读 `packages/plugin-dev/issue-provider-kit/index.ts`。
4. **SuperSync 是否可自建 / 是否收费、以及和 op-log 的调用面**。`packages/super-sync-server/` 与 `docker-compose.supersync.yaml` 的存在已核实，正文未读。配方：读 `packages/super-sync-server/README.md` + `docs/sync-and-op-log/supersync-scenarios.md`(15 KB)。
5. **GitLab/GitHub 插件是否有「全局分配给我」查询**（前一份笔记关心的是这个）。配方：读 `packages/plugin-dev/github-issue-provider/src/plugin.ts` 里的 `searchIssues`/`getNewIssuesForBacklog` 实际查询串（GitHub 若是 `search/issues?q=is:issue+assignee:@me` 即为跨仓库）。
6. **加密的两条线各自边界**（SuperSync E2EE vs 本地 secret 明文 at rest）。配方：读 `docs/supersync-encryption-at-rest-decision.md`、`docs/long-term-plans/secure-storage.md`(45 KB)。
7. **Gitee 若照此插件机制实现**：`packages/plugin-dev/` 无 gitee（只有 **gitea**，两者不同产品）。要自建就按 §4 的 6 文件包结构 + manifest `pollIntervalMs` 做，社区插件无需核心注册。

## 来源清单

### 一手（本会话内直接读取原文；同一 commit `2b3f78e…`，branch `master`）

- `src/app/features/issue/issue-service-interface.ts`（60 行，1,640 B）——核心 provider 契约全文；两次独立通道交叉验证（`api.github.com/git/blobs/<sha>` base64 + blob 页 `rawLines`），内容一致。
- `packages/plugin-api/src/issue-provider-types.ts`（331 行 / 315 sloc，11.9 KB）——插件 provider 契约全文（§3 全部字段与注释原文）。
- `docs/add-new-integration.md`（32 项 docs 目录中的 11 KB 文档）——§4 全部 7 节；含 §3 凭据、映射守则、bundling 步骤、验证清单、Legacy core providers 段。缓存 `webfetch-3205f436…md`（495 行）。
- `src/app/plugins/bundled-plugins.const.ts`（73 行 / 71 sloc，3.09 KB）——bundled 插件清单、id 不可变注释、保留 id 防撞说明、`DEV_ONLY` 集合。缓存 `webfetch-a431a23d…md`。
- `src/app/features/issue/handle-issue-provider-http-error.ts`（72 行 / 69 sloc，2.79 KB）——§5 错误处理全文。缓存 `webfetch-00320a5d…md`。
- `docs/github-access-token-instructions.md`（11 行 / 8 sloc，533 B）——GitHub = classic PAT + `repo` scope 全文；末尾指向 `docs/gitlab-access-token-instructions.md`。缓存 `webfetch-74a20252…md`。
- `ARCHITECTURE-DECISIONS.md`（825 行 / 234,410 单元，全文缓存 `webfetch-04ab64c6…md`）——ADR#3（671–703 段引用的包边界）、ADR#4、ADR#9（598–646）、ADR#10（647–670）。
- GitHub 结构列举（`api.github.com/repos/.../git/trees/master:<path>` 紧凑端点）——`src/app/features/issue`、`.../providers`(recursive)、`src/app/plugins`、`packages`、`packages/plugin-api/src`、`packages/plugin-dev`、`docs`(recursive)；据此确定「内置 5 家 / 插件 9 家 / 无 gitee / 文件字节数」。缓存 `webfetch-40f8235d…md`、`webfetch-c72e3c91…md`、`webfetch-9e04c2f6…md`、`webfetch-9cfdf58b…md`、`webfetch-e9bc25f9…md`、`webfetch-be134a57…md`、`webfetch-1a4ec7e8…md`。

### 非一手 / 传输通道说明

- 本轮**未引用任何二手解读**（无博客、无评测、无 super-productivity.com 营销页）。
- 抓取通道即 GitHub 页面内嵌 JSON（`rawLines` 为源码逐行原文、`richText` 为 markdown 渲染原文），属第一方内容、但经页面包装；`raw.githubusercontent.com`、`cdn.jsdelivr.net/gh/…`、`cdn.statically.io/gh/…` 在本环境均不可达（fetch failed），故未能对比 `.raw` 直链。若你日后本地 clone，可用 `git log -1 --format=%H` 对齐 commit `2b3f78edbf0721f0842daa097e47247fe245852f` 后逐条复核。
- 尚未读但已确认存在的仓库内一手文档（下一步优先）：`docs/plugin-development.md`(51 KB)、`docs/repository-map.md`(13 KB)、`docs/wiki/3.07-Issue-Integration-Comparison.md`(28 KB)、`docs/hardening-earns-its-place.md`(8 KB)、`docs/sync-and-op-log/operation-log-architecture.md`(117 KB)。

### 与前两份笔记的关系

- `personal-cross-platform-issue-dashboard.md` 已记录的「GitLab 自 v20 起改为 bundled plugin」「仓库迁至 `super-productivity` 组织」在本轮得到源码级确认，并进一步确认「GitHub / Gitea / Azure DevOps 等也同在 `packages/plugin-dev/`」。
- `platform-limits-and-landing-form.md` 的「轮询成本模型」应按本轮口径修正一处：**每轮请求数 ≈ 每 provider 1 次批量请求**（`getByIds` 语义），而不是「每 task 1 次」；该笔记里 Jira/飞书预算若按逐任务估，是保守偏高。
