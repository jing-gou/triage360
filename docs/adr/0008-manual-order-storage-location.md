# ADR-0008 · 手动顺序的存放位置是 v1 的一个待定决策，不是已决

**状态**：Proposed——本 ADR 只把证据与两条路摊平，**存放位置这一决策属于 owner**，等他选定再把标题与首段改成定稿。在此之前，`ADR-0007` 那份实现照旧有效（它决定了 `manualOrder` 是什么、作用在哪一步，没有决定它住在哪儿）。

**待定的是哪一件事**：访客排出来的那份顺序，v1 是否**只**住在这台浏览器的 `localStorage` 里。今天代码就是这一支（`src/panel/manual-order.ts`），而票面上有一句正面相反的义务，见下面「为什么现在要拍板」。

**为什么现在要拍板**：`research/local-first-ordering-internal-audit.md` 从 tracker 逐字取回两句 AC（本轮我也用 `gh issue view` 复核过原文）：

- `#13`（T11 加密落库与删除义务）AC 第 14 行：「30 天未访问自动清除，**且覆盖排序记录**」，同条第 13 行：「撤销 = 物理删除该租户 token 与**全部数据**（当场验证一次删除结果）」。
- `#10`（T08 学习闭环最小版）AC 第 15 行：「清除数据后加权消失（**不留隐式记忆**）」。

再加 `docs/PRD.md:68` 的 US#35：「排序行为被记录、被清除、被 30 天过期覆盖, so that 偏好数据和我其余数据**同命**」。这三句都是正面义务，不是「不做某事」；`#9` 自己的 AC 对存放位置完全沉默（它只说「刷新页面仍在」，那是浏览器内的事件）。**`DECISIONS.md` 全文没有讨论过存放位置**——那里的「本地规划」（`:22`、Q2 C、Q11 a）说的是**不回写外部平台**，和「数据落在浏览器本地」不是同一个词；「跨设备同步」这个词在仓库里只出现两次（`docs/PRD.md:159` 的 Out of Scope 与 `ADR-0007:16`）。所以本地优先既没被批准也没被否决过，今天的实现是替它做了一次没记录的选择。

**一手证据（四份笔记，均带 file:line 或 URL + 原句）**：

1. **成熟先例接受「顺序在各设备不一样」**。Super Productivity 自己的 sync 设计文档原句：「Order-only differences, and disagreement that the next sync repairs, do not qualify.」（`docs/sync-and-op-log/contributor-sync-model.md:299-302`），`AGENTS.md:98` 的 sync rule 15 要求修复必须有 harm 证据；它的清单文档把顺序分歧写成「71 of 120 seeds… no user report shows harm from it… recommended outcome is to build nothing now」。→ 顺序不一致在做了同步的系统里都被判为**可接受的最终状态**，我们没做同步。
2. **形状的两种写法都真实存在，而业界写侧用锚点**。SBE 没有 per-task rank：顺序住在父实体的有序 id 数组上（`project.taskIds`、`section.taskIds`、`task.subTaskIds`、`note.todayOrder`），重排走 `moveItemAfterAnchor(itemId, afterItemId, currentList)`，**从不接受「第 N 位」这个数字**（`src/app/features/work-context/store/work-context-meta.helper.ts:18-48`）。GitHub Projects V2 同侧：`updateProjectV2ItemPosition(input: {projectId, itemId, afterId})`，`afterId` 的描述原句「The ID of the item to position this item after. If omitted or set to null the item will be moved to top.」，而 `ProjectV2Item` 的 11 个字段里**没有任何可读位置字段**（本轮 `gh api graphql` introspection 实测，命令与输出在 `research/rank-encoding-vs-whole-array-rewrite.md` §3.1）。
3. **per-item rank 的代价是官方写死的阈值会停功能**。Atlassian：rank 存成字符串且「the length of these strings increases」；128 字符排到 12 小时内 rebalance、160 立即 rebalance、**≥254 直接停掉产生这种长度的 ranking 操作**，列宽 `varchar(255)`；补救是它一手承认的全量改写——「Running a balance is similar to running a re-index of JIRA」。Linear 则把 rank 形状做成 `Issue.sortOrder: Float!`，描述里自己写了失效模式：「Use a value between two neighboring issues to place it between them; **Linear may adjust positions to avoid collisions.**」
4. **本地存储的尺寸不是约束，时间与并发性才是**。WHATWG Storage 规格把 localStorage 配额写死 `5 × 2^20`，Chromium 设计文档写 10 MB——**两处无法调和，本轮未核实**，但都远大于我们那份几百字节的 id 数组。`navigator.storage.estimate()` 的 `usage` 大概率不含 localStorage（三条一手支撑 + 探针配方在笔记 §待核实 4）。真正两条硬的：HTML 标准自陈没有跨进程加锁——"authors are encouraged to assume that there is no locking mechanism"，两个窗口同读同写会撞号，结尾用词 "with potentially disastrous effects"；以及 WebKit ITP 的七天条款点名 LocalStorage。
5. **⚠️ 那条 WebKit 结论要打折读**。政策页整句的主语是 trackers：「**Trackers** executing script in the first-party context often make use of first-party storage… Therefore, ITP deletes all cookies created in JavaScript and all other script-writeable storage after 7 days of no user interaction」，同页把「7-day cap」画在 `tracker.example (3p cloaking)` 行下、对「No cloaking」写「No cap」。→ 自有域名是否也吃这条上限**没有一手依据**（已在 `research/browser-local-storage-durability.md` TL;DR 第 3 条就地标注）。任何文案或决策都不许写「Safari 上顺序最多活 7 天」。

**两条路**：

- **A · 本地 only，把边界写成话（默认，也是今天的实现）**。#13 落地时把 AC#4 的范围写死成「服务端有的那些」，自陈屏「怎么清」那一栏新增一行本地例外；弹窗（`src/panel/App.tsx`）那句「换浏览器或清空站点数据，顺序回到规则打分」后面补「撤销授权与 30 天清除不覆盖它」；US#35 的「同命」加限定。#10 落地时，「清除数据」这个动作要么连带重置顺序，要么在票面上明写顺序数组不在它的射程内。代价：访客点完「撤销」屏幕上顺序仍在，**这句话必须靠文案说死**，说轻了就是虚假承诺——这正是 `DECISIONS.md:60` 那条删除义务最容易失守的位置。
- **B · 顺序进 #13 的服务端存储**。字面兑现「同命」与「不留隐式记忆」，跨设备顺序一致。代价：#13 之前没人能定这个 schema（`ADR-0007:20` 拒掉的正是「现在定 schema 等于替它们决定形状」）；未登录/离线访客需要本地兜底 ⇒ 两份真相与谁赢的问题；`localStorage` 那份数组要迁移；以及 B 让 #9 的 AC 从「刷新仍在」升级成「换设备仍在」，那是超出票面的能力。

推荐 A，但**推荐本身不构成决定**。两条路都不动 `manualOrder` 的接入点与结果形状：换成 B 时改的是 `src/panel/manual-order.ts` 的读写两端，`src/core/today-list.ts` 的注入契约不变——这正是 `ADR-0007` 把它做成注入输入换来的自由度。

**这条决策不改变的形状议题**：整份数组重写 vs per-item rank 不是今天的问题。v1 一屏 ≤20 条、单访客、没有服务端写路径，整份数组没有写放大可言；业界用 anchor 是为了**重放与并发**，而我们的 `manualOrder` 不重放——每轮从当前可见集合重新求位置，认不出的陈旧 id 自动落空（`ADR-0007` 代价末条）。若日后走 B，`afterId` 那种锚点形状比 index 耐并发，届时再议，别现在改测试。

**已被推翻的前提（写下来防止再被拿来当依据）**：`ADR-0005:24` 与 `tests/today-list.test.ts:308` 都写着「#9 会把跨轮快照落盘」，而 #9 落的是 id 字符串数组、一个 `Task` 都不存，`previous` 至今没被界面接线（`ADR-0003:5`）。⇒「跨轮快照存全八键」这条契约**目前无主**；「反正 #9 已经落盘了」不能用来论证本地优先。

**随附文档债（本轮不修，因为要碰正在审阅的 `App.tsx`）**：仓库里 10+ 处把语义匹配写成 `#18`（`ADR-0006` 四处、`src/core/today-list.ts:22`/`:54`、`src/fakes/samples.ts:35`/`:37`、`src/panel/App.tsx:55`、`GLOSSARY.md:8`），而 tracker 实测 `#18 = T16: 83 条对照视图`——**语义匹配目前没有票**（票号规则：`issue #N = T(N-2)`，N≥3）。另 `ADR-0003:9` 说存储层「留给 T13 / T14 决定」，实测 `T13 = #15 演示代持租户真实化`、加密落库是 `T11 = #13`，那句应指 T11。两处都要等 #31 合并后才能动 `App.tsx` 那一处。
