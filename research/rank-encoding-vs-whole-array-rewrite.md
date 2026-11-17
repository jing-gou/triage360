---
question: triage360（纯前端 Vite+React+TS「今日清单」，四家只读源聚合，无后端）—— 手动排序是否本地优先：「整份可见 id 数组重写」vs「每条卡片一个 rank 字段」两种数据形状各自的一手代价证据
date: 2026-11-17
method: 仅采用一手来源（Atlassian 官方文档原文、GitHub GraphQL introspection 实测返回、算法原始作者页面/论文）；每条 claim 背一个本轮真实取到的 URL + 关键原句；取不到一手的写成「未核实 + owner 可自证的复现配方」，不写成「不存在」
status: GitHub Projects V2 部分已用 introspection 实测**推翻**上一轮的「没有顺序字段」结论（准确表述见 3.1）；Linear 亦已用无凭据 introspection 取到一手字段描述；Demaine 原始页面归属已核实、正文未取得（见第 2 节）
related: [platform-limits-and-landing-form.md, personal-cross-platform-issue-dashboard.md]
---

# rank 字段 vs 整份数组重写：两种「把手动顺序存下来」的数据形状

阅读日期：2026-11-17。本节只收集证据，不替 owner 下结论。

## 结论摘要（TL;DR）

1. **上一轮「GitHub Projects V2 没有暴露顺序字段」的说法被本轮 introspection 推翻了一半，也说对了一半。** schema 里确实有顺序概念：`ProjectV2ItemOrderField` 的唯一取值是 `POSITION`（一手描述 "Order project v2 items by the their position in the project"），且有专门的写入变更 `updateProjectV2ItemPosition(projectId!, itemId!, afterId?)`；但 `ProjectV2Item` 的 11 个字段里**没有任何可读的位置字段**，edge 只有 `cursor`/`node`。→ GitHub 给的是**「锚点式」形状**：一次变更只指定「把这一项放到 afterId 之后」，既不传整份数组，也不把 rank 字符串暴露给客户端。（命令与原样 JSON 见 3.1）
2. **Linear 一手把 owner 的「备选」形状完整实现了，并且在字段描述里自己写出了它的失效模式。** `Issue.sortOrder: Float!` 可读可写，官方描述逐字："The issue's position in manually sorted lists, with lower values first. **Use a value between two neighboring issues to place it between them; Linear may adjust positions to avoid collisions.**" —— 「取邻居中值」+「服务端会自行再调整以避免碰撞」这两点写在同一个描述里；另有 `IssueCreateInput.preserveSortOrderOnCreate`（"Keep the supplied sortOrder instead of placing the issue first in its status. Defaults to false."）说明连「新建时保住给定位置」都需要一个独立开关。（见 3.2）
3. **rank 形状真正的代价不是「写几条」，而是官方写死的字符阈值会直接停功能。** Atlassian 一手：128 字符 → 排到 12 小时后 rebalance、160 → 立即 rebalance、**≥254 → "Jira will only stop the ranking operations that yield values having the length of 254 characters or more"**，列宽 `varchar(255)`；而它给出的补救措施是一手承认的全量改写："Balancing fields will distribute rank values evenly across specific buckets"、"Running a balance is similar to running a re-index of JIRA"、"Current balancing can take quite a long time on larger instances"（JSWSERVER-13163）。**注意：「插到中间只改写 1 条记录」这句话官方没有原句**，一手只能证到逐行改写 + 全量 rebalance（已列入待核实 1）。
4. **两种形状的冲突面单位不同，且一手都留下了伤疤。** 数组形状的冲突单位是整份数组（一手侧证：GitHub 官方压根不接受数组作为写入形状——`AddProjectV2ItemByIdInput` 没有位置参数）；rank 形状的冲突单位是单条记录，但 Atlassian 一手里有并发失败原句 "Other users may be ranking the issues that you are trying to rank. Please try again later."、碰撞重试 `New rank[…] already exists, retrying balance oepration`、集群锁、以及 rank 特有的 collation 失败模式（"This may cause JIRA Agile to attempt to insert duplicates of the same rank"，JSWSERVER-11178）。陈旧项维度上 rank 形状自带状态（GitHub `isArchived`/`archivedStates`、Linear `trashed` + `includeArchived` 均一手）。
5. **Demaine 原始出处：站点归属已核实、算法正文未取得。** `lexorank.demaine.com` 确为 Erik Demaine 本人的算法说明页（三个互不相关的 GitHub 仓库 README 逐字一致："The lexorank algorithm as implemented in JIRA (Atlassian) is described at https://lexorank.demaine.com/ and was designed by Erik Demaine" **[非一手]**），且本轮经 `r.jina.ai` 镜像取到了他个人站点的导航文本（本机直连该页为 403）。但**页面正文里「作者自陈的缺点」那几段本轮未取得**（镜像只渲染出导航/出版项，`r.jina.ai/https://lexorank.demaine.com/` 二次请求失败，archive.org 超时），CrossRef `query=lexorank` → `"total-results":0`。**通道被拒不等于内容不存在**：故本节「作者自陈缺点」实际交付的是 Atlassian（实现方与文档所有者）的原句，配方见待核实 5。

---

## 1. Atlassian / Jira：LexoRank 官方文档原句

三份一手页面（阅读日期均为 2026-11-17，全部 WebFetch 取到正文）：
- [Managing LexoRank — Administering Jira applications Data Center 9.16](https://confluence.atlassian.com/display/ADMINJIRASERVER0916/Managing+LexoRank)（页面标注「Last modified on Jul 7, 2022」）
- [Understanding and Managing LexoRank in Jira Server](https://support.atlassian.com/jira/kb/understanding-and-managing-lexorank-in-jira-server/)（Atlassian Support KB，platform 标注「Data Center only」）
- [LexoRank balancing or manual ranking of issues fails in Jira](https://support.atlassian.com/jira/kb/lexorank-balancing-or-manual-ranking-of-issues-fails-in-jira/)（同 KB 空间）

### 1.1 为什么要 rank 字段，而不是「存一份顺序」

原句（Managing LexoRank，Balancing 一节）：

> "Each issue has a unique rank relative to the issues around it. This rank is stored as a string. As the number of issues grows and you perform more ranking operations (for example, changing the order of issues in the Agile backlog), the length of these strings increases."

→ 官方把「顺序」建模成**每条记录自己的一个字符串属性**，且明确它的存在是为了让「相对位置」不依赖一份全局序列。注意后半句：官方文档自己就把「rank 字符串会变长」列为这一形状的第一个代价。

### 1.2 一次插到中间要写几条记录

**Atlassian 这三份文档没有直接写出「一次插入改写 N 条记录」的数字。** 能从一手原文支撑的最强表述是：

> "If the rank's length reaches the first threshold of 128 characters, the rebalancing is scheduled for the next 12 hours. It'll evenly distribute the ranked issues and significantly reduce the rank length. During the rebalancing, all ranking operations execute as usual."
> "Balancing fields will distribute rank values evenly across specific buckets. This will fix the problem specific to the ranking."

以及 KB 里的逐行日志（原文，含 Atlassian 自己的 typo「oepration」）：

```
2014-09-10 15:03:33,052 lexorank-executor-thread-0 DEBUG [service.lexorank.balance.LexoRankBalanceOperation] Balancing rank row [type=ISSUE_RANK_ROW, oldRank=0|1026rk:, newRank=1|hzzzvz:]
2014-09-10 15:03:33,053 ... New rank[1|hzzzvz:] for issue[id=31321] for rank field[id=10890] already exists, retrying balance oepration
2014-09-10 15:03:33,054 ... balance operation timed out
2014-09-10 15:03:33,055 ... Balancing of 1 fields completed with 1 errors
```

→ 可证实的两条：**(a) 常规 rank 操作是按「一行一条」记录的**（`Balancing rank row [ ... oldRank=..., newRank=... ]` 每行一个 issue 一次改写；桶由 `0|` 变 `1|`）；**(b) rebalance 是全量改写**（"distribute rank values evenly across specific buckets" + 逐行日志 + "all ranking operations execute as usual" 说明它是在后台一条条改写）。**「插到中间只写 1 条」这句结论在官方文档里没有原句**，已列入「待核实」。

### 1.3 rank 字符串变长的机制与官方阈值

原句（Managing LexoRank）：

> "Depending on the number of characters in the rank's string, Jira will schedule the rebalancing or start it immediately:
> - If the rank's length reaches the first threshold of **128 characters**, the rebalancing is scheduled for the next 12 hours. It'll evenly distribute the ranked issues and significantly reduce the rank length. During the rebalancing, all ranking operations execute as usual.
> - If the length reaches the second threshold of **160 characters** within 12 hours, the immediate rebalancing is started.
> - If the length reaches or exceeds **254 characters**, Jira will only stop the ranking operations that yield values having the length of 254 characters or more. But other operations that don't meet this criterion won't be affected."

Rank Status 属性原句：

> "Status: OK - the rank length is in a healthy state. Warning - a rebalance has been scheduled. Critical - an immediate rebalance has started, you are approaching a state where rank operations will be disabled."
> "Length: `<current length> / <maximum length>` — Maximum length indicates when rank operations will be disabled."
> "In addition to the preceding properties, the **Rank Status** field indicates which project has the issues with the longest rank. This is useful to diagnose the cause of a rapid increase in the rank's length."

→ 对 triage360 最要紧的一点：**变长不是「性能慢慢下降」，而是有明确的硬上限，越过 254 后官方选择的是「拒绝这类操作」**（"Jira will only stop the ranking operations that yield values having the length of 254 characters or more"）。rank 形状的本质代价 = 「需要再造一个后台全量改写机制来避免功能失效」。

存储上限的一手旁证（同一 KB 的修复 SQL 里出现列定义）：

> `ALTER TABLE "AO_60DB71_LEXORANK" ALTER COLUMN RANK varchar(255) COLLATE Latin1_General_CI_AI NOT NULL;`

→ 列宽 `varchar(255)`，与 254 阈值一致；rank 字符串的完整形态是 `桶|值:`（如 `0|1026rk:`）。

### 1.4 官方自己写明的周期性 rebalance 及其代价

原句：

> "Running a balance is similar to running a re-index of JIRA, there isn't any guarantee it will fix a problem unless the problem is specific to the ranking data."（Understanding and Managing LexoRank in Jira Server）
> "Current balancing can take quite a long time on larger instances, and a fix for this is tracked in JSWSERVER-13163."（同页）
> "It indicates that the balance cluster lock has been taken."（同页，集群锁）
> "A foreground re-index may be running. It is expected that this will disable balancing."（同页）
> "Balancing fields will distribute rank values evenly across specific buckets."（Managing LexoRank）

冲突面（同页 + 平衡失败 KB）：

> "JIRA Agile cannot execute the rank operation at this time. Other users may be ranking the issues that you are trying to rank. Please try again later."
> "The LexoRank balancer job will be unable to complete, some issues may not be able to be ranked, or appear in the incorrect order."

陈旧/损坏形态（Managing LexoRank，Integrity checks）：

> "When the balancing is in progress, the marker rows are moved to another bucket to indicate where the new rank values should be. The only time they should be in different buckets is if the balancing is in progress."
> "Deleting these records will fix this problem but will result in a loss of ranking data for those issues only."
> `SELECT * FROM "AO_60DB71_LEXORANK" WHERE ("RANK" LIKE '%|zzzzzz:' OR "RANK" LIKE '%|000000:') AND "TYPE" not in (0,2);`

依赖数据库排序规则（rank 形状特有的坑，一手原句）：

> "The ranking system uses a lexographically ordered field to determine the ranking order. If the collation includes any non-standard ordering for any alphanumeric characters, then this ranking can be ordered incorrectly when fetched from the database. This may cause JIRA Agile to attempt to insert duplicates of the same rank, or order ranks incorrectly - JSWSERVER-11178 - Unable to rank with any database collation that does not order all alphanumeric characters the same as ASCII."

→ 桶数一手可见为 3（`0|` / `1|` / `2|`，见上面 bucket 计数 SQL 的三段 UNION 与 marker row 合法状态列举）。

---

## 2. LexoRank 算法原始出处作者自己写明的缺点

**站点归属已核实；正文未取得。** 本节修正上一轮「查不到 Demaine 的 lexorank 出处」的悲观判断——**出处是存在的、可定位的**，只是页面正文对我的通道取不到。不写成「不存在」，写成「归属一手半、正文未取得 + 已试过的通道」：

- 归属（三个互不相关的仓库 README 逐字一致，`gh api repos/<owner>/<repo>/readme --jq .content | base64 -d`，2026-11-17）：
  > "The lexorank algorithm as implemented in JIRA (Atlassian) is described at https://lexorank.demaine.com/ and was designed by Erik Demaine" —— `tanjoshua/lexorank`、`Gkuber/lexorank`、`ThomsonTan/lexorank`（**[非一手]**，但对同一 URL 与同一作者的三次独立转述一致）
- 作者本人站点的导航文本本轮**经 `https://r.jina.ai/https://people.csail.mit.edu/demaine/` 镜像取得**（本机直连同页 403）：其中一条即为
  > `[LexoRank](https://lexorank.demaine.com/ "LexoRANK is an algorithm for generating unique lexicographically-sorted strings for database records")`
  → 这是**作者自己站点上的文本，但经第三方 reader 代理转取**，故标 **[非一手-通道]**；且返回体被截断在导航部分，**不能据此断言「正文里没有缺点章节」**。
- 正文未取得（**均为传输层失败，不是内容判定**）：`https://lexorank.demaine.com/` 直连 curl 返回 `000`（TLS/连接层）、`https://people.csail.mit.edu/demaine/` WebFetch 与 curl 均 403（直连与 `HTTPS_PROXY=http://localhost:7890` 同）、`https://web.archive.org/cdx/…` 与 `https://archive.org/wayback/available` 全部超时（exit 28）、`r.jina.ai` 二次请求亦 `000`。
- 论文侧：CrossRef `query=lexorank` → **`"total-results":0`**（实测原样）；arXiv Export API `search_query=all:lexorank` → 无 `<title>` 命中。可证实的表述是「这两个索引里检索不到」，不等于「作者没有相关文献」。

**因此本轮能交付的「算法作者自陈缺点」的一手原句，实际来自 Atlassian（该算法的实现者与文档所有者），见 1.3 / 1.4：字符串变长、128/160/254 三档阈值、balance 类似 re-index 且在大规模实例上「can take quite a long time」、集群锁、并发 rank 冲突、collation 导致重复 rank。** Demaine 正文的 owner 自证配方见「待核实」第 5 项。

---

## 3. GitHub Projects V2 / Linear：官方 schema 到底有没有暴露顺序字段

### 3.1 GitHub Projects V2 —— 实测结论：**有「position」这个概念，但它不是可读的 rank 字段，而是「相对锚点」写入 + 只可排序不可读取**

上一轮记录为「GitHub 没有暴露顺序字段」**且未给证据**。本轮用 `gh api graphql` 做 introspection，结论是**该说法不成立**：schema 里确实存在 `updateProjectV2ItemPosition` 变更与 `ProjectV2ItemOrderField.POSITION` 排序枚举。但同一批实测也显示 **`ProjectV2Item` 类型上没有可读取的位置字段**。下面是命令与原样输出。

环境：`gh` 不在 agent shell 的 PATH，用绝对路径 `"C:/Program Files/GitHub CLI/gh.exe"`；`gh auth status` 显示已登录 github.com（token 不打印）。未设置 `HTTPS_PROXY` 即直连成功，本轮 GraphQL 调用不需要代理。

**命令 3-A —— ProjectV2Item 的全部字段（关键：返回里没有任何位置/rank 字段）**

```bash
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "ProjectV2Item") { name description fields { name type { name kind ofType { name kind ofType { name kind } } } } } }'
```

原样输出（节选，未改写；`description` 为 `"An item within a Project."`）：

```json
{"data":{"__type":{"name":"ProjectV2Item","description":"An item within a Project.","fields":[
  {"name":"content","type":{"name":"ProjectV2ItemContent","kind":"UNION","ofType":null}},
  {"name":"createdAt","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"DateTime","kind":"SCALAR","ofType":null}}},
  {"name":"creator","type":{"name":"Actor","kind":"INTERFACE","ofType":null}},
  {"name":"fieldValueByName","type":{"name":"ProjectV2ItemFieldValue","kind":"UNION","ofType":null}},
  {"name":"fieldValues","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"ProjectV2ItemFieldValueConnection","kind":"OBJECT","ofType":null}}},
  {"name":"fullDatabaseId","type":{"name":"BigInt","kind":"SCALAR","ofType":null}},
  {"name":"id","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"ID","kind":"SCALAR","ofType":null}}},
  {"name":"isArchived","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"Boolean","kind":"SCALAR","ofType":null}}},
  {"name":"project","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"ProjectV2","kind":"OBJECT","ofType":null}}},
  {"name":"type","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"ProjectV2ItemType","kind":"ENUM","ofType":null}}},
  {"name":"updatedAt","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"DateTime","kind":"SCALAR","ofType":null}}}
]}}}
```

11 个字段，逐条核对：无 `position`、无 `rank`、无 `order`。→ **可证实的表述是「GitHub 的 GraphQL schema 没有在 `ProjectV2Item` 上暴露可读的位置字段」，而不是「GitHub 没有顺序」**。

**命令 3-B —— 位置是「可排序但不可读」**

```bash
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "ProjectV2ItemOrderField") { name description enumValues { name description } } }'
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "ProjectV2ItemEdge") { name fields { name type { name kind ofType { name kind } } } } }'
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "ProjectV2ItemConnection") { name fields { name type { name kind ofType { name kind } } } } }'
```

原样输出：

```json
{"data":{"__type":{"name":"ProjectV2ItemOrderField","description":"Properties by which project v2 item connections can be ordered.","enumValues":[{"name":"POSITION","description":"Order project v2 items by the their position in the project"}]}}}
{"data":{"__type":{"name":"ProjectV2ItemEdge","fields":[{"name":"cursor","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"String","kind":"SCALAR"}}},{"name":"node","type":{"name":"ProjectV2Item","kind":"OBJECT","ofType":null}}]}}}
{"data":{"__type":{"name":"ProjectV2ItemConnection","description":"The connection type for ProjectV2Item.","fields":[{"name":"edges",...},{"name":"nodes",...},{"name":"pageInfo",...},{"name":"totalCount",...}]}}}
```

`POSITION` 是该枚举的**唯一**取值（原文含官方 typo「by the their position」）。edge 只有 `cursor`/`node`，connection 只有 `edges`/`nodes`/`pageInfo`/`totalCount`——即位置只能通过**返回顺序**体现，`cursor` 是不透明字符串，官方 schema 未说明它是否编码了位置。

**命令 3-C —— 写入侧是「相对锚点」而不是「rank 字符串」**

```bash
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "Mutation") { fields { name args { name type { name kind ofType { name kind } } } } } }'
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "UpdateProjectV2ItemPositionInput") { name kind description inputFields { name type { name kind ofType { name kind } } } } }'
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "AddProjectV2ItemByIdInput") { name inputFields { name type { name kind ofType { name kind } } } } }'
```

原样输出：

```json
{"data":{"__type":{"name":"UpdateProjectV2ItemPositionInput","kind":"INPUT_OBJECT","description":"Autogenerated input type of UpdateProjectV2ItemPosition","inputFields":[
  {"name":"clientMutationId","type":{"name":"String","kind":"SCALAR","ofType":null}},
  {"name":"projectId","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"ID","kind":"SCALAR","ofType":null}}},
  {"name":"itemId","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"ID","kind":"SCALAR","ofType":null}}},
  {"name":"afterId","type":{"name":"ID","kind":"SCALAR","ofType":null}}
]}}}
```

`AddProjectV2ItemByIdInput` 的 inputFields 只有 `clientMutationId` / `projectId` / `contentId`——**新项加入项目时不接受位置参数**（实测：无 `position`）。

→ 对决策直接有用的一点：GitHub 官方选择的表达形状是 `updateProjectV2ItemPosition(projectId, itemId, afterId?)`——**「把 itemId 放到 afterId 之后」，一次变更只指一个被移动的 item，不传整份数组，也不传 rank 字符串**。schema 里没有出现 LexoRank 式的 rank 字符串标量（`__type(name:"ProjectV2ItemPosition")` 返回 `{"data":{"__type":null}}`，即该类型名不存在，实测原样）。

**命令 3-D —— 排除「position 挂在别的类型上」**

```bash
"C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __type(name: "ProjectV2") { fields { name args { name type { name kind ofType { name kind ofType { name kind } } } } } } }'
```

输出中 `items` 连线的 args 为 `after / before / first / last / orderBy: ProjectV2ItemOrder / archivedStates: [ProjectV2ItemArchivedState!] / query: String`——即过滤与排序入口都在连线上，`ProjectV2` 本身没有位置字段。（另：同一输出确认 `archivedStates` 参数存在，与第 4 节「归档后的陈旧项」维度相关。）

诚实边界：以上全部是 **schema introspection**，不是对某个真实 project 做读写实验；因此「`afterId` 为 null 表示移到顶部」「一次拖拽实际改写服务端几条记录」这类**行为语义**在官方 schema 的 introspection 里取不到，属未核实（配方见「待核实」）。GitHub 公开的 GraphQL schema 文本（`octokit/graphql-schema` 等镜像）**未使用**，避免以镜像代替实测。

### 3.2 Linear —— 实测结论：**schema 里既可读又可写 `sortOrder: Float!`，且官方描述里自己写了「插中间=取邻居中间值」与「Linear 会自行调整位置以避免碰撞」**

上一轮的「未核实」本轮已被实测取代。Linear 的 GraphQL 端点**允许无凭据 introspection**（本轮实测；只发 introspection 查询，未访问任何租户数据）。

**命令 L-A（探测通道）**

```bash
curl -s -X POST https://api.linear.app/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __schema { queryType { name } } }"}'
```

原样输出（`http=200`）：

```json
{"data":{"__schema":{"queryType":{"name":"Query"}}}}
```

**命令 L-B（`Issue` 上所有含 sort/position/order 的字段）**

```bash
curl -s -X POST https://api.linear.app/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name: \"Issue\") { fields { name type { name kind ofType { name kind } } description } } }"}'
```

原样输出（三个字段，逐字）：

```json
{"name":"sortOrder","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"Float","kind":"SCALAR"}}}
"desc": "The issue’s position in manually sorted lists, with lower values first. Use a value between two neighboring issues to place it between them; Linear may adjust positions to avoid collisions."

{"name":"prioritySortOrder","type":{"name":null,"kind":"NON_NULL","ofType":{"name":"Float","kind":"SCALAR"}}}
"desc": "The issue’s position within its priority group, with lower values first. This order is separate from sortOrder, which is used for other manually sorted lists."

{"name":"subIssueSortOrder","type":{"name":"Float","kind":"SCALAR"}}
"desc": "The issue’s position among its parent’s direct sub-issues, with lower values first. Null for top-level issues. This order is independent of the issue’s position in team lists."
```

**命令 L-C（读写两侧都暴露）**

```bash
curl -s -X POST https://api.linear.app/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name: \"IssueUpdateInput\") { inputFields { name } } }"}'
curl -s -X POST https://api.linear.app/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ __type(name: \"IssueCreateInput\") { inputFields { name type { name kind ofType { name kind } } description } } }"}'
```

`IssueUpdateInput` 的 inputFields 里实测含 `sortOrder` / `prioritySortOrder` / `subIssueSortOrder`。`IssueCreateInput` 里另有一个直接对应本决策问题的开关（逐字）：

```json
{"name":"sortOrder","type":{"name":"Float","kind":"SCALAR","ofType":null}}
"desc": "Position in manually sorted lists. Lower values appear first. Set preserveSortOrderOnCreate to keep this position."

{"name":"preserveSortOrderOnCreate","type":{"name":"Boolean","kind":"SCALAR","ofType":null}}
"desc": "Keep the supplied sortOrder instead of placing the issue first in its status. Defaults to false."
```

**命令 L-D（陈旧项维度）**：`Issue.trashed` 描述逐字为 `"Whether the issue is in the trash: true for a trashed issue, null otherwise. Trashed issues are also archived and are scheduled for permanent deletion after the grace period."`；`Issue.archivedAt` 存在；`Query.issues` 的 args 实测为 `['filter','before','after','first','last','includeArchived','orderBy','sort']`。

**三点可直接用于决策的读法**：

1. Linear 选的形状正是 owner 的「备选」——**每条卡片一个可排序数值字段**，而且是 `Float` 而不是字符串；官方描述把插中间定义成 "Use a value between two neighboring issues"（即取邻居中值），并且**在同一句里承认「Linear may adjust positions to avoid collisions」**——这句话就是「中值法会撞精度/碰撞、服务端必须自己再调整」的第一方承认。
2. Linear 与 GitHub 的差别：GitHub 的位置**只能排序不能读**（3.1），Linear 的位置**能读能写**；后者才会把「rank 会退化」这件事暴露给客户端，前者把它封在服务端。
3. 诚实边界：`sort` 参数的元素类型本轮 `__type(name:"Sort")` 与 `__type(name:"IssueSort")` 均返回 `{"data":{"__type":null}}`（即这两个类型名不可解析），**服务端一次请求能否表达「插到中间」在 Linear 侧未证实**；配方见「待核实」。同样未证实的是「调整位置」到底改写几条记录、是否会级联。

---

## 4. 对照表：整份数组重写 vs 单条 rank

**(A)** = 一次拖拽后 `JSON.stringify` 重写整份可见 id 数组（triage360 现状，localStorage）；**(B)** = 每条卡片一个 rank/position 字段。标注：**[一手]** 本文件内有原句/原样输出；**[推断]** 由一手事实推出、官方未陈述；**[未核实]** 见「待核实」。

| 维度 | (A) 整份数组重写 | (B) 单条 rank |
|---|---|---|
| **写放大** | 每次拖拽 Θ(N)，N = **可见**项数而非列表总长（数组存的就是当前可见顺序）**[推断]**；强项是一次写完全量、无需维护不变量 | 设计目标即「不重排整个列表」：Linear 一手把插中间写成给**一条**记录一个邻居中值（"Use a value between two neighboring issues"）**[一手]**；Atlassian 一手最细粒度是逐行日志 `Balancing rank row [oldRank=…, newRank=…]`，即一次改写一行 **[一手]**；但「插中间只写 1 条」**官方无原句 [未核实]** |
| **写放大的隐藏尾巴** | 数组本身即真相，不存在「退化后需重建」**[推断]**；代价是每次必写全量 + 并发写整体覆盖 | 一手承认的周期性全量改写：`"Balancing fields will distribute rank values evenly across specific buckets"`、`"Running a balance is similar to running a re-index of JIRA"`、`"Current balancing can take quite a long time on larger instances"`（JSWSERVER-13163）**[一手]** |
| **长度/容量上限** | 无字符级上限；上限转为**单个 localStorage value 的字节数**，本轮未取一手 **[未核实]** | 官方写死三档 **[一手]**：128→排 12 小时后 rebalance；160（12 小时内）→立即；≥254→`"Jira will only stop the ranking operations that yield values having the length of 254 characters or more"`；列宽 `varchar(255)` 见一手修复 SQL。**越限是「功能被拒绝」而不是「变慢」** |
| **并发 / 多标签页冲突面** | 冲突单位是**整份数组**：后写标签页整体覆盖前写者，含对方无关的排序改动（lost update）**[推断]**。一手侧证：GitHub 官方**不接受**数组作为写入形状——`AddProjectV2ItemByIdInput` 无位置参数，`UpdateProjectV2ItemPositionInput` 只有 `projectId!/itemId!/afterId?` **[一手]** | 冲突单位是**一条记录**，覆盖面小；但一手记录了三类真实冲突：`"…cannot execute the rank operation at this time. Other users may be ranking the issues that you are trying to rank. Please try again later."`、`New rank[…] already exists, retrying balance oepration`（碰撞重试）、`"the balance cluster lock has been taken"` **[一手]**；形状特有失败模式：collation 非 ASCII 序 → `"This may cause JIRA Agile to attempt to insert duplicates of the same rank"` **[一手]** |
| **删除 / 归档后的陈旧项** | 结构性风险：数组里是 id，源端删除/归档后成悬空引用，读时需做差集；过滤条件一变，数组与服务端顺序的对应就要重算 **[推断]**。一手：`"Deleting these records will fix this problem but will result in a loss of ranking data for those issues only."` **[一手]** | 陈旧项**自带状态**，交给服务端过滤：GitHub `ProjectV2Item.isArchived: Boolean!` + `items(archivedStates: [ProjectV2ItemArchivedState!])` **[一手]**；Linear `trashed`（"Trashed issues are also archived and are scheduled for permanent deletion after the grace period."）+ `issues(includeArchived:)` **[一手]** |
| **能否一次请求表达「插到中间」** | **能，且不需要知道邻居**：一次写整份新顺序即可（(A) 唯一强项）**[推断]** | 两家给的形状不同：**GitHub＝锚点式**，`updateProjectV2ItemPosition(projectId, itemId, afterId)` 一次变更表达「放到 afterId 之后」，服务端自算 rank **[一手]**；**Linear＝值式**，客户端自算中值再写 `sortOrder`，官方在服务端描述里承认会再调整 **[一手]**。一手里**未见**「一次请求批量插多条到中间」的表达 **[未核实]** |
| **对本项目的限定** | 无后端 ⇒ (B) 的 rank 计算、防碰撞、rebalance 全得在前端自己做；Atlassian 的阈值体系是围绕多租户数据库设计的，不能直接搬 **[推断]** | 同左；另：(B) 把排序与卡片共址，将来若加多端同步，(A) 的整块覆盖会先出问题 **[推断]** |

---

## 待核实（附自证配方）

1. **「LexoRank 插到中间只改写 1 条」缺官方原句。** 1.2 只证到「逐行改写」与「rebalance 全量改写」。有 Jira DC sandbox 时：对同一 `"AO_60DB71_LEXORANK"` 在拖拽前后各取一次快照比对差异行数（用 1.4 里的三段 `'0|%'/'1|%'/'2|%'` 计数 SQL 亦可）。**无 sandbox 就不要把这条当结论用。**
2. **GitHub `afterId` 的行为语义**（`null` 是否 = 移到顶部、一次拖拽服务端写几条、是否级联）——本轮只做了 introspection，未对真实 project 读写。配方（需自己的 ProjectV2）：
   ```bash
   "C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ projectV2(number: <N>) { items(first: 3, orderBy: {field: POSITION, direction: ASC}) { nodes { id } } } }'   # 读回顺序
   "C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='mutation($p:ID!,$i:ID!,$a:ID){ updateProjectV2ItemPosition(input:{projectId:$p,itemId:$i,afterId:$a}){ item { id } } }' -F p=… -F i=… -F a=…   # 再跑一次上一条比对
   ```
3. **GitHub 全 schema 是否另有隐藏的 rank/position 字段。** 本轮只验证了 `__type(name:"ProjectV2ItemPosition")` → `{"data":{"__type":null}}`；`__type` 精确查询**不构成**「全 schema 无 position 字段」的证明。彻底排查（响应很大，落盘后本地过滤）：
   ```bash
   "C:/Program Files/GitHub CLI/gh.exe" api graphql -f query='{ __schema { types { name kind fields { name } enumValues { name } } } }' > gh-types.json
   ```
   再对 `gh-types.json` 过滤字段名含 `position|rank|order` 的类型。本条本轮**未执行**。
4. **Linear：一次请求能否表达「插到中间」，以及 "may adjust positions" 会改写几条记录。** `sort` 的元素类型本轮解析不出（`__type(name:"Sort")`、`__type(name:"IssueSort")` 均返回 `{"data":{"__type":null}}`）。查允许的排序 key：
   ```bash
   curl -s -X POST https://api.linear.app/graphql -H 'Content-Type: application/json' -d '{"query":"{ __type(name: \"Query\") { fields { name args { name type { name kind ofType { name kind ofType { name kind ofType { name } } } } } } } }"}'
   ```
   行为侧（写几条）需 PAT + 真实 workspace，本轮无凭据。
5. **Demaine 正文（第 2 节的核心缺口）**：已知 `https://lexorank.demaine.com/` 是他的说明页，只差正文。owner 侧配方（按可靠性排序）：
   - 浏览器直接打开 `https://lexorank.demaine.com/` 与 `https://people.csail.mit.edu/demaine/`（403 很可能只针对非浏览器 UA），页内搜 `disadvantage|limitation|rebalance|length`。
   - 命令行镜像：`curl -sL "https://r.jina.ai/https://lexorank.demaine.com/"`（本轮该通道对 mit.edu 成功一次、对 lexorank.demaine.com 失败，值得重试）。
   - 存档：`curl -s "https://web.archive.org/cdx/search/cdx?url=lexorank.demaine.com&output=json"`（本机 exit 28 超时，浏览器里 `web.archive.org/web/*/lexorank.demaine.com` 可直接看列表）。
6. **localStorage 单值字节上限**（形状 (A) 唯一的硬上限）：本轮未取一手，故不断言任何数字；MDN Web Storage 条目亦未抓取。本地实测：控制台里 `localStorage.setItem('t','x'.repeat(5*1024*1024))` 观察是否抛 `QuotaExceededError`；N 条 id 的真实字节数即 `JSON.stringify(ids).length`。

## 来源清单

### 一手（均为 2026-11-17 阅读，URL 为本轮真实取到）
- https://confluence.atlassian.com/display/ADMINJIRASERVER0916/Managing+LexoRank —— rank 存为字符串、字符串随操作变长、128/160/254 三档阈值与 12 小时排程、"Balancing fields will distribute rank values evenly across specific buckets"、Rank Status 语义、marker rows 与 3 个桶、"Last modified on Jul 7, 2022"
- https://support.atlassian.com/jira/kb/understanding-and-managing-lexorank-in-jira-server/ —— "Running a balance is similar to running a re-index of JIRA…"、"Current balancing can take quite a long time on larger instances"（JSWSERVER-13163）、"the balance cluster lock has been taken"、"A foreground re-index may be running. It is expected that this will disable balancing."、"Deleting these records will correct this problem (and also result in a loss of ranking data for those issues only)."、`varchar(255)` 修复 SQL
- https://support.atlassian.com/jira/kb/lexorank-balancing-or-manual-ranking-of-issues-fails-in-jira/ —— "JIRA Agile cannot execute the rank operation at this time. Other users may be ranking the issues that you are trying to rank. Please try again later."、`Balancing rank row [type=ISSUE_RANK_ROW, oldRank=0|1026rk:, newRank=1|hzzzvz:]`、"already exists, retrying balance oepration"、"balance operation timed out"、collation 原句 + JSWSERVER-11178、三段桶计数 SQL
- GitHub GraphQL introspection（`gh api graphql` 原样返回，命令 3-A…3-D）：`ProjectV2Item` 11 个字段无位置字段；`ProjectV2ItemOrderField` 唯一取值 `POSITION`（描述含官方 typo "by the their position"）；`UpdateProjectV2ItemPositionInput{clientMutationId?,projectId!,itemId!,afterId?}`；`AddProjectV2ItemByIdInput` 无位置参数；`ProjectV2.items(…,orderBy:ProjectV2ItemOrder,archivedStates: […],query)`；`isArchived: Boolean!`
- https://api.linear.app/graphql introspection（命令 L-A…L-D）：`Issue.sortOrder: Float!` + "Use a value between two neighboring issues to place it between them; Linear may adjust positions to avoid collisions."；`prioritySortOrder` / `subIssueSortOrder` 描述；`IssueCreateInput.sortOrder` 与 `preserveSortOrderOnCreate`（"Defaults to false."）；`Issue.trashed` 描述；`Query.issues` args 列表；`PaginationOrderBy` 仅 `createdAt`/`updatedAt`
- https://api.crossref.org/works?query=lexorank&rows=3 → `"total-results":0`（本轮实测原样）
- http://export.arxiv.org/api/query?search_query=all:lexorank&max_results=3 → 无 `<title>` 命中（本轮实测）

### 非一手（仅用于「站点归属」，未用于任何算法性质结论）
- `tanjoshua/lexorank`、`Gkuber/lexorank`、`ThomsonTan/lexorank` 三个互不相关仓库的 README（`gh api repos/<owner>/<repo>/readme` 解码）逐字一致："The lexorank algorithm as implemented in JIRA (Atlassian) is described at https://lexorank.demaine.com/ and was designed by Erik Demaine"。**仅用于确认出处 URL 与作者**，其技术表述（"LexoRank algorithm provides an elegant solution to this problem by assigning each item a unique, lexicographically sortable string"）不作证据。`TristanWaddington/lexorank`、`kvandake/lexorank-ts` 的 `gh api …/readme` 本轮未返回内容，仓库名未复核。掘金/CSDN/DeepWiki 等转述一律未采信。
- **搜索结果里出现的疑似镜像/克隆站（`1f750f5c…cdn.pinduplicate.com`、`www.nfnpngl.cn`、`116.62.16.121`）标题声称论文名为 `LexoRank: Lexicographic Ordering for Persistent Lists using String Manipulation`，本轮一律未采信、未抓取**——这些域名与 MIT 无任何可证关系，正文真伪未知。owner 若要用，需自行与 Demaine 官方渠道交叉核对。
- 已失败的通道（写了就不算「不存在」）：`developer.atlassian.com/server/jira/platform/jira-lexoranking/` 404、`developer.atlassian.com/cloud/jira/agile/rest/v3/api-group-backlog/` 404、`confluence.atlassian.com/adminjiraserver0916/managing-lexorank-<推测pageId>.html` 404；`developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-backlog/` 取到正文但全文无 `rankBefore`，故 **Jira Cloud「rank 端点一次影响几条 issue」的官方表述本轮未取得**。

### 传输通道说明
- `gh` 不在 agent shell 的 PATH，统一用绝对路径 `"C:/Program Files/GitHub CLI/gh.exe"`；`gh auth status` 显示已登录 github.com（未使用 `--show-token`，token 未打印）。GitHub GraphQL、`api.linear.app`、CrossRef、arXiv 均**直连成功，未设代理**。`curl -s https://api.github.com/repos/<…>/readme` 返回 `000`（连接层被拒），但同一内容的 `gh api … --jq .content` 可用。
- Demaine 通道（**全部为传输层结果，不含内容判定**）：`people.csail.mit.edu/demaine/` → WebFetch 与 curl 均 **403**（直连、`HTTPS_PROXY=http://localhost:7890` 皆同）；经 `https://r.jina.ai/https://people.csail.mit.edu/demaine/` **成功取到一次**导航文本（故标 [非一手-通道]）；`https://r.jina.ai/https://lexorank.demaine.com/` 后续两次请求（curl `000`、WebFetch "fetch failed"）均失败；`web.archive.org/cdx/…`、`archive.org/wayback/available` → curl **exit 28 超时**；`lexorank.demaine.com`、`www.demaine.com`、`lexorank.org` 直连 → `000`。
- 设置 `HTTPS_PROXY=http://localhost:7890` 后重试 `people.csail.mit.edu` 仍 403，`demaine.com` / `lexorank.org` 返回 `000`（连接/DNS 层失败，非 404）。
- 两处需注意：GitHub GraphQL 结论均来自 **schema introspection**，不是对真实 project 的读写实验（见待核实 2）；Atlassian 两个 support 页面正文嵌在脚本 JSON 里，引文按页面内 `"value":"…"` / `articleBody` 逐字抄出，未翻译未改写。原文拼写错误（"enbles"、"oepration"、"by the their"、"lexographically"）为来源所有，未修正。
