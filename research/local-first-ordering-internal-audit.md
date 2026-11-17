---
question: 仓库内口径审计——「手动排序是否走本地优先」这件事，现有文档 / spec / ticket / 代码里已经写下与尚未写下的是什么
date: 2026-11-17
method: 只读仓库取证。所有引文用 Read 逐字取回并标 file:line；三条 ticket 原文用 gh CLI 从 issue tracker 直接取回，未改写
status: 已逐条取到一手（仓库文件 + issue #9/#10/#13 的 body 原文）。仍未取到——#13/#10 是否存在仓库外补充评论、以及 main 上是否已有他人开的本地优先讨论——见「待核实」
scope_note: 本文件不做决策，只把现状摊开。结论冲突点的严重度是取证者判的，不是仓库已认的
---

# 手动排序 · 本地优先的仓库内口径审计

> 取证基线（命令原话输出，repo `C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f`）：
>
> ```
> $ git rev-parse --abbrev-ref HEAD
> ticket/T07-drag-order
> $ git log --oneline -1
> adbab0a fix: 双轴 review 第一轮——措辞回到代码真做的事，标记等看过才落
> $ git log --oneline -1 origin/main
> 25b1da9 Merge pull request #30 from jing-gou/docs/bycode-wording
> ```
>
> `git status --short` 空输出（工作树干净）。**手动排序的全部实现只存在于 `ticket/T07-drag-order`，尚未合入 main**：`git ls-tree --name-only origin/main:docs/adr` 只到 `0006-dedup-predicate-injection.md`，`origin/main:src/panel` 只有 `App.tsx / main.tsx / styles.css`（无 `manual-order.ts`）。`origin/main..HEAD` 是 4 个 commit。
>
> `docs/adr/` 实际文件：0001–0007 七份，**不存在 ADR-0008**（本文件也不新建）。
>
> 〔**主会话核对 2026-11-17**〕这句写完之后，同一个 PR 的第二个 commit `86b6c78` 确实新建了 `docs/adr/0008-manual-order-storage-location.md`——「不新建」约束的是这份审计自己的交付物，不是「0008 这个号永久留空」。0008 的状态是 **Proposed**：它只把 §C1–C3 那三处正面义务与两条路摊平，**没有替 owner 拍板存放位置**。另外 0008 引用的 `ADR-0007` 与 `src/panel/manual-order.ts` 都还在待批的 PR #31 上，main 上 `docs/adr/` 因此是 0001–0006 直接跳到 0008。

## 结论摘要（TL;DR）

1. **#9 的 AC 对「存在哪里」完全沉默**：它写的是「拖拽后顺序持久化，刷新页面仍在」——「刷新页面」是浏览器内的事件，localStorage 就够。所以本地优先不违反 #9，但 #9 也**没有批准**本地优先。
2. **真正与本地存放正面相撞的是 #13 AC#4 与 #10 AC#5**，两句都是正面义务而不是「不做某事」：`30 天未访问自动清除，且覆盖排序记录`、`清除数据后加权消失（不留隐式记忆）`。现在这份 `localStorage` 设计让这两句在各自 ticket 落地当天变红。
3. **`src/` 里没有任何清除排序的代码路径**。`grep -rn "撤销\|清除\|reset\|clear" src` 唯一命中是 `src/panel/styles.css:51` 的 `counter-reset: card;`（CSS 计数器，无关）。访客想让顺序回到规则序，只有「清空站点数据」这一条浏览器侧动作。
4. **upstream 从未讨论过这件事**：`DECISIONS.md` 里 `同步 / 浏览器 / 本地存储 / 设备 / IndexedDB` 全部命中都与排序存放无关；`跨设备同步` 这个词在仓库里只出现两次——`docs/PRD.md:159`（Out of Scope）与 `docs/adr/0007-manual-order-injection.md:16`。**存放位置这个决策没进过决策树。**
5. **Out of Scope 那句能当「本地优先不欠功能」的依据，不能当「本地优先免删除义务」的依据**。「不做跨设备同步协议」推不出「排序记录不进服务端」，前者是砍功能、后者涉及数据边界，两句之间隔着的正是 #13/#10 那三条正面 AC。
6. **有一条假设已经被现实推翻**：`ADR-0005:24` 与 `tests/today-list.test.ts:308` 都写「#9 会把跨轮快照落盘」，而 #9 落盘的是 id 字符串数组（`src/panel/manual-order.ts:41-43`），一个 `Task` 都不存。「快照存全八键」这条契约因此没有主人。
7. **文档债集中在一处**：ADR-0007:16 自己记下了「两处要合上口径」，但这句话只活在 ADR 与 `.scratch/pr-body-t07.md:49` 里，**没有回到 `DECISIONS.md` / PRD**，也没有落成 #13 或 #10 票面上的一句交接。按 `AGENTS.md` 的写法则更糟：它既没归进 PR 正文的「刻意没处理」，也没变成 ticket 的交接句。

## 1. 三条 ticket 的 AC 原句，以及哪几句直接撞上「排序记录存本地、不进服务端」

以下 body 由 `export HTTPS_PROXY=http://localhost:7890 && "C:/Program Files/GitHub CLI/gh.exe" issue view <n> --repo jing-gou/triage360 --json number,title,body -q .body` 逐字取回，**未改写、未修正引号**。

### #9 `T07: 拖拽排序与首次排序说明` — AC 全文

```
- [ ] 拖拽后顺序持久化，刷新页面仍在
- [ ] 手动顺序优先于规则打分结果
- [ ] 首次主动排序触发一次说明弹窗，之后不再重复
- [ ] 弹窗文案具体到"学的是什么"，不是"我们会学习你的偏好"
```

Notes 全文：`拖拽交互与视觉按 spec 走手工验收 + 截图，不写自动化测试。`

**与存放位置的关系**：AC#1 的措辞是「刷新页面仍在」，不是「换设备仍在」「重新登录后仍在」。这一句既没有要求服务端，也没有豁免服务端——它是这份审计里唯一一个**真正中性**的条款。AC#4 反过来对弹窗说话，而弹窗现在承诺的正是本地性（见 §3 的 C4）。

### #10 `T08: 学习闭环最小版` — AC 全文

```
- [ ] 记录 `provider + issue_id + 时间 + 用户放置的位置`
- [ ] seam 1 断言：连续把某 repo 置顶后，该 repo 的新条目权重上升并改变输出顺序
- [ ] 理由文案可出现"因为你连续把 X 排在前面"这类引用
- [ ] 自陈表增加"记录排序行为"一行；30 天自动清除覆盖这些记录
- [ ] 清除数据后加权消失（不留隐式记忆）
```

**直接相关的句子（逐字）**：
- `自陈表增加"记录排序行为"一行；30 天自动清除覆盖这些记录` — 自陈表与「30 天自动清除」都是服务端概念（`DECISIONS.md:59` 的自陈屏在「点连接之前」、`DECISIONS.md:60` 的 30 天清除挂在删除义务下）。**「覆盖这些记录」的「这些」在 #10 里指的是 AC#1 那份行为日志**，字面上不含顺序数组本身。
- `清除数据后加权消失（不留隐式记忆）` — 括号那半句是这份审计里**最锋利的一句**。它没有说「服务端不留隐式记忆」，说的是「不留」。顺序数组恰好是偏好的结晶形态：清掉日志、留下顺序，界面上仍是「你历史偏好的那几条在前面」。
- `记录 \`provider + issue_id + 时间 + 用户放置的位置\`` — 记录形状里带「时间」，而 `manual-order.ts` 存的 `string[]` 没有时间维度（`ADR-0007:20` 明确拒绝在 localStorage 建这个形状）。所以 #10 一旦落地必然引入**第二份**存储，与现有那份并存。

### #13 `T11: 加密落库与删除义务` — AC 全文

```
- [ ] token AES-256-GCM 加密存储，密钥同机；密钥不进仓库
- [ ] 自陈屏在点"连接"之前出现，需显式同意才跳 OAuth；不做常驻入口
- [ ] 撤销 = 物理删除该租户 token 与全部数据（当场验证一次删除结果）
- [ ] 30 天未访问自动清除，且覆盖排序记录
- [ ] 日志与错误上报中不出现 token、授权头、含正文的响应体；URL 打码
- [ ] 正文、评论、diff、代码不入库（检查存储内容形态）
- [ ] 对外措辞精确到"数据库文件泄露不导致凭据泄露"，并明写挡不住服务器被完全控制
```

**直接相关的句子（逐字）**：
- `30 天未访问自动清除，且覆盖排序记录` — 全文里唯一**指名「排序记录」**的一句，且把它放进了服务端定时任务的射程。「未访问」这个判据只有服务端才有（浏览器不知道访客什么时候「没来」）。这一句与 `src/panel/manual-order.ts:4` 的「服务端没有它的副本」是字面矛盾。
- `撤销 = 物理删除该租户 token 与全部数据（当场验证一次删除结果）` — 两个刺：「**全部**数据」没有写排除项；「当场验证一次删除结果」意味着删除动作与验证都在服务端侧观察，前端 localStorage 既删不掉也验不了。
- `自陈屏在点"连接"之前出现，需显式同意才跳 OAuth；不做常驻入口` — 这一句决定了「排序记录存本地」这件事在界面上的**唯一对外陈述位置**。因为不做常驻入口，弹窗（`App.tsx:183-205`）那句本地承诺就成了访客能看到的、关于排序存放位置的**仅有**说明——而它只在首次拖拽后出现一次。
- 注意：#13 的 AC 里**没有一句**写「今日清单快照落库」。把 #13 当成「服务端快照票」是 `ADR-0006:11` 的措辞（`#13（快照存储）`），票面本身只覆盖 token、自陈、删除、日志、字段边界、对外措辞七项。

## 2. `DECISIONS.md` 相关表述（逐字，带行号）

**本地规划层**

- `DECISIONS.md:22` — 「外部 issue 一律**只读**，其上盖一层本地规划（今日清单 + 拖拽排序），**不做任何回写**。v1 = GitHub + Jira；v2 = 飞书任务（文档 / 表格 / 审批仅作为 PRD 拓展项）。更新机制 = 可见标签页轮询 + 手动 refresh，v1 无推送。30% 精力投在首次上手体验的打磨上。」
- `DECISIONS.md:96` — 「| Q2 | 是否回写外部平台 | C：外部只读 + 本地规划层 | |」
- `DECISIONS.md:105` — 「| Q11 | 规划层深度 | a：今日清单 + 排序，无回写 | |」
- `DECISIONS.md:150`（阶段 1 内容）— 「三条回调骨架 + GitHub `public_repo` 端到端 + 规划层（今日清单 / 拖拽 / `doneStates`）+ 演示账号 12 条精选 | **一键演示能讲完整故事**（凭据可临时放本地）」

> 「本地规划」在这三处指的是**不回写外部平台**（规划层盖在只读镜像之上），不是「数据落在浏览器本地」。这是本次审计里最容易读混的一处：`DECISIONS.md:22` 的「本地」和 `manual-order.ts:4` 的「本地」不是同一个词。

**隐私自陈表**

- `DECISIONS.md:59` — 「自陈屏：点"连接"之前先显示一张表（存什么 / 不存什么 / 谁可见 / 怎么清），用户点"我知悉并同意"再跳 OAuth。**只出现在连接前，不做常驻入口**。」
- `DECISIONS.md:123` — 「| Q29 | 授权前自陈屏 | **B：连接前一屏**，不做常驻 | 未选 C |」
- `DECISIONS.md:139` — 「| Q45 | token 静态加密 | **B：AES-256-GCM，密钥同机**，边界写进自陈屏 | |」

**30 天清除**

- `DECISIONS.md:60` — 「删除义务：撤销授权即**物理删除**该租户全部数据；连续 30 天未访问自动清除。**不做数据导出**（对首次上手体验几乎无加分，却要处理镜像序列化）。」
- `DECISIONS.md:119` — 「| Q25 | 义务边界 | **B：撤销即物理删除 + 30 天自动清除**，不做导出 | |」
- `DECISIONS.md:151`（阶段 2 完成标志）— 「凭据加密存储、自陈屏、`X-OAuth-Scopes` 检测显示、撤销即物理删除、30 天清除 | §0.4 每句承诺都有对应代码」

**学习闭环与其连带义务**（唯一一处把「排序记录」与「30 天清除」写在同一句的 upstream 文本）

- `DECISIONS.md:75` — 「**学习闭环做最小可实现版**（修订了早期"不声称学习"的约定）：记录 `provider + issue_id + 时间 + 用户放置的位置`，下次打分时按"历史上你反复把某 repo / 某类 label 排到前面"线性加权；用户**首次主动排序后弹窗**说明它现在学的是什么，AI 理由文案里可出现"因为你上周连续 3 次把 X 仓库的缺陷置顶"。三处连带义务：自陈表加一行"记录排序行为"、30 天自动清除覆盖它、约一天工作量。」

**跨设备同步**

- **`DECISIONS.md` 里不存在这个议题。** `grep -n "同步\|浏览器\|本地存储\|设备\|IndexedDB" DECISIONS.md` 的命中只有：`:34`（GitHub CORS 的浏览器可行性）、`:70` 与 `:140`（「同步返回」= 同步调用，非数据同步）、`:177` 与 `:189`（浏览器换不到 token / JS 渲染页需浏览器读取）。
- 仓库内关于跨设备同步的唯一两处文字：`docs/PRD.md:159`「- 数据导出、跨设备同步协议、离线模式」与 `docs/adr/0007-manual-order-injection.md:16` 末句「跨设备同步本身在 spec 的 Out of Scope 里。」

## 3. 代码 ↔ 文档 冲突点清单（按严重度）

### C1 · 最高 — #13 AC#4 在落地当天即为红

- 冲突两侧：`#13`「30 天未访问自动清除，且覆盖排序记录」 ↔ `src/panel/manual-order.ts:4`「只存在这台浏览器的 localStorage：服务端没有它的副本，清空站点数据它就没了。」
- 为什么是硬冲突而不是措辞问题：`ORDER_KEY = "triage360:manual-order:v1"`（`manual-order.ts:11`）没有任何 TTL 字段、没有 `savedAt`、没有启动时的过期检查（`loadManualOrder()`，`manual-order.ts:32-39` 只做 `JSON.parse` 与 `typeof` 过滤）。服务端删完自己那一份之后，这条记录在访客机器上无限期存活。
- **界面 / 文案要跟着改的句子**（保持本地优先，即「明确把边界写成服务端 only」这一支）：
  - `src/panel/App.tsx:199`「这份顺序存在这台浏览器的本地存储里——换浏览器或清空站点数据，顺序回到规则打分。」→ 需补一句「撤销授权与 30 天清除都不覆盖它」。
  - `docs/adr/0007-manual-order-injection.md:16` 整条 bullet 需从「待合口径」改成「已定口径」。
  - `GLOSSARY.md:10` 末句「落盘在浏览器本地，界面负责读写。」→ 需加「服务端删除义务不覆盖它」。
  - `docs/PRD.md:39`（US#12）与 `docs/PRD.md:68`（US#35「排序行为被记录、被清除、被 30 天过期覆盖, so that 偏好数据和我其余数据同命」）→ US#35 那句「和我其余数据同命」是本地优先最直接的受害者，必须改写或加限定。
  - 自陈屏尚不存在（`grep -rn "自陈" src` → 0 命中），所以 #13 那张「存什么 / 不存什么 / 谁可见 / 怎么清」表（`DECISIONS.md:59`）**必须在「怎么清」那一栏新写一行本地例外**——这一行现在还没有宿主文件。

### C2 · 高 — #10 AC#5「不留隐式记忆」被顺序数组本身打破

- 冲突两侧：`#10`「清除数据后加权消失（不留隐式记忆）」↔ `manual-order.ts:41-43` 的 `saveManualOrder` + `src/core/today-list.ts:108-120` 的 `applyManualOrder`。
- 机理：`applyManualOrder` 把 `manualOrder` 里的卡一律提前（`today-list.ts:113-119`）。这份数组就是加权结果的固化形态——清掉 #10 的行为日志后，`RANK` 侧的线性权重确实归零了，但屏幕上仍然是「访客历史上反复置顶的那些条目」在前面，且顺序不再由规则产生。AC#5 的「隐式」二字正是为这种「看起来还记着」写的。
- 加重项：`ADR-0007:5` 决定了「界面一次落盘写的是**整份可见顺序**」，所以一次拖拽之后**全部**卡片都进了手动区（`ADR-0007:14`「一次拖拽之后，规则只对新条目说话」）。要让清除日志真的「不留隐式记忆」，同一次动作必须连带清掉整份顺序——那是一个比「删日志」大得多的破坏半径。
- 界面要改：`App.tsx:195-197`「记下来的只有这些：每条的标识，和你把它放在第几位。标题、正文、评论都不在里面。它现在还只记顺序，不会猜你想先做哪一类任务。」→ #10 落地后「不会猜你想先做哪一类任务」立刻变假话；若同时加「清除即重置顺序」，`from/to` 那两行的语义也要重写。

### C3 · 中高 — #13 AC#3 的「全部数据」与「当场验证一次删除结果」

- 「全部数据」字面无排除项；「当场验证」要求删除与验证在同一侧可观察。localStorage 从服务端既不可写也不可枚举。
- 两种解法都要动文案：(a) 撤销流程多下发一条「让前端清除」的指令 → `manual-order.ts` 需要一个新的清除入口（现在整个 `src/` 没有，见 TL;DR 3），且这条指令在未打开页面时不生效，仍然不是「当场」；(b) 把范围限定成「服务端有的那些」→ 回到 C1 的改文案清单，并与 `PRD.md:68` 的「同命」正面冲突。

### C4 · 中 — #9 AC 沉默 + Out of Scope 被当成依据使用

- `ADR-0007:16` 末句「跨设备同步本身在 spec 的 Out of Scope 里」把一个「不做功能」的条款放在了「存放位置」论证的位置上。详细分析见 §4：它论证的是「本地优先不欠一个同步协议」，而**没有**论证「排序记录可以不受服务端删除义务覆盖」。这两件事之间隔的就是 C1/C2/C3。
- 同一条 bullet 里「#13 落库时要一并把顺序挪进服务端存储」这个选项，与 `ADR-0007:20`「落到服务端存储（今天没有可写的服务端：#11 才是第一条真连、#13 才是第一次落库，现在定 schema 等于替它们决定形状）」不是矛盾（一个是今天、一个是 #13 落地时），但**读起来像矛盾**，而 ADR 是 `ADR-0005:16` 自认的「仓库里唯一的持久判据」。这句话要重写。

### C5 · 中 — 一份已被推翻的假设：「#9 会把跨轮快照落盘」

- `ADR-0005:24`「所以 #9 落盘的快照若只存七键，缺 `duePrecision` 的条目会**静默**落回瞬间支」＋末句「#9 接线时这一条要跟着进票面」。
- `tests/today-list.test.ts:308`「#9 会把跨轮快照落盘，落的就是 `previous` 这一点数据：少存第 8 键，`ruleOf` 不报错」。
- 现实：#9 交付的落盘只有 id 数组（`manual-order.ts:41-43` 存 `JSON.stringify(ids)`；`loadManualOrder()` 返回 `string[]`），`previous` 这条输入根本没被界面接线（`App.tsx:49-59` 的 `buildTodayList` 调用里没有 `previous`；`ADR-0003:5`「`src/panel/App.tsx` 只在挂载时构建一次，从不传 `previous`」）。
- 后果：`GLOSSARY.md:21`「同生同灭由调用方守：跨轮快照少存这第八个键，打分就静默落回按瞬间比（ADR-0005）」这条契约**目前无主**。它写在一份假设「#9 会存 Task[]」的 ADR 里，而 #9 不存 Task；真正要存 Task[] 的是 `ADR-0006:11` 点名的 `#16（第二轮接线）与 #13（快照存储）`。**如果 owner 因为「反正 #9 已经落盘了」而倾向本地优先，那是拿一条已被推翻的假设在做依据。**

### C6 · 低 — ticket 编号陈旧 / 混用

- `ADR-0003:9`「构建器直接读库拿快照（把 seam 1 和凭据保管、T13 的存储层绑死）」与「具体存内存还是存快照，留给 T13 / T14 决定」：tracker 里 `T13` 是 issue **#15**（演示代持租户真实化），加密落库是 `T11` = issue **#13**。凭据存储层显然是 #13/T11。同一份 ADR 的 `:5` 用的是 `#16（T14 …）` 这种「issue#（Txx）」双写格式，`:9` 只写 `T13 / T14`，两种读法给出两个票。
- `src/core/today-list.ts:22`「标题相似度是 #18 的语义匹配要买的东西」、`ADR-0006:5`「那是 #18 要买的语义匹配」、`ADR-0006:10`「#18 之前，界面上『跨平台整合』的价值就卡在这条登记上」：tracker 里 **#18 = T16「83 条对照视图」**，与语义匹配无关；票面最高到 #20（T18 AI 提炼批量摘要），**语义匹配目前没有票**。
- `ADR-0006:11` 写「#16（第二轮接线）」，#16 的标题是「T14: 角标状态与就地快照水印」——`ADR-0003:5` 已解释接线归属记在 #16 名下，这一条站得住，但两处措辞相差很大，跨文件读会误判。
- 与本地优先的关联：`ADR-0007:15` 的「表头换人 ⇒ 那张卡的位置丢」这条代价的触发频率取决于真实 `sameEvent` 什么时候来，而那条票（文档里叫 #18）**在 tracker 里指向一张完全无关的票**。评估本地优先的稳定性代价时拿不到正确的前瞻。

## 4. Out of Scope 原句，以及它能否当作「本地优先」的现成依据

原句（`docs/PRD.md:156-168`，`## Out of Scope` 全节逐字）：

```
- 向任何外部平台**回写**（改状态、加评论、建任务、时间块、工时）
- 数据导出、跨设备同步协议、离线模式
- 独立账号体系（登录即 GitHub 连接）
- 第三方插件式 provider 加载（zip 上传、运行隔离、保留 id 反冒充那一整套）
- Gitee / Jira / 飞书的公开-私有授权粒度开关（平台上不存在该粒度，做出来会是假开关）
- Jira 与飞书的对外真实接入（Jira 仅内部自证；飞书仅样例卡）
- Atlassian Marketplace 上架与第三方集成审核
- 推送通知、webhook、后台常驻任务（除演示租户的定时刷新）
- 上游请求节流与配额预算（Q31 有意不做）
- 移动端与响应式适配
- 任何超出「记录排序 → 线性加权」的偏好建模，以及任何超出已实现范围的能力声称
```

与本题相关的是第 2 行（`PRD.md:159`）、末行（`PRD.md:168`），以及被 `ADR-0007:17` 用过的移动端那行（`PRD.md:167`）。

**能当作依据的部分**：`159` 砍掉的是「跨设备同步协议」这个功能项。它把一项需求整体移出射程——「本地排好的顺序必须能在另一台浏览器/设备上复原」不再是任何人欠的账。因此**本地优先不欠功能**，也不必为了同步去设计冲突合并（`SP` 那条 op-log + vector clock 路线，见 `research/super-productivity-implementation.md` TL;DR 第 7 条，明确不在射程内）。`ADR-0007:16` 末句使用的就是这一层，用得对。

**不能当作依据的部分**：

1. `159` 是「不做 X」，`#13 AC#4`、`#13 AC#3`、`#10 AC#4/#5` 是「必须对 Y 生效」。「不做同步」推不出「数据可以躲在服务端删除动作够不着的地方」——Out of Scope 里没有一句声明**数据存放位置**，也没有一句豁免删除义务。C1/C2/C3 全都发生在 Out of Scope 之外。
2. `PRD.md:168` 那句「任何超出已实现范围的能力声称」反过来是**约束本地优先这一支的措辞**：若保持本地，自陈屏与 §0.4 的承诺就不能沿用「撤销即物理删除该租户全部数据」这种无排除项的写法。`DECISIONS.md:151` 阶段 2 的完成标志正是「§0.4 每句承诺都有对应代码」——本地顺序会让那一句对不上代码。
3. `PRD.md:158` 砍的是「向外部平台回写」，`DECISIONS.md:22` 的「本地规划层」也是同一件事（只读镜像之上盖一层规划）。这两处**容易被误读成本题的「本地优先」**。`GLOSSARY.md:10` 说得比它们精确：「落盘在浏览器本地，界面负责读写」——这是仓库内唯一一处把「本地」用在存储义上的正式术语条目。

**结论**：Out of Scope 是一块**真实的、可引用的免功能依据**，不是一块**数据边界依据**。要把「本地优先」立成正式决定，仍需一条正面 ADR 写明：存哪里、谁清得掉、服务端删除义务对它的边界在哪。`ADR-0007` 记的是「注入点 + 合并之后生效」，存放位置只出现在它的代价 bullet 里。

## 5. 现在这份设计已经欠下的文档债

1. **`ADR-0007:16` 自记的那条**（题面指的就是它）— 「两处要合上口径：#13 落库时要一并把顺序挪进服务端存储，或把「撤销即物理删除」「30 天清除」覆盖的范围写清是「服务端有的那些」，而这条本地顺序由浏览器自己负责。」＋「#13 的自陈屏那一行同样要说实话……#13 改成服务端时记得一起改那里。」**它的交付物是一句口头交接**：`#13` 票面 body（§1 逐字取回）里没有这一句，`#10` 票面也没有。按 `AGENTS.md:17`「不影响档位与顺序的细节归进 PR 正文『刻意没处理』那一行，或落成对应 ticket 的一句交接」——PR 正文那一行做到了（`.scratch/pr-body-t07.md:49`），ticket 交接没做到，而这件事**影响档位与顺序**（C2 直接决定清除之后屏幕长什么样），按 AGENTS.md 自己的分类本不该走「归进 PR 正文即终点」。
2. **存放位置本身没有 ADR。** `docs/adr/` 只有 0001–0007。ADR-0007 的标题是「手动顺序是构建器的注入输入，作用在合并之后」，两件事都在 seam 侧；「localStorage + 无服务端副本」只写在 `manual-order.ts:1-9` 的文件头注释与 `ADR-0007:16` 代价里。owner 今天若定「本地优先」，需要一条正面记录它的新 ADR（下一个空号是 0008）。
3. **`DECISIONS.md` 缺一条 Q49。** 决策树里根本没有「排序记录存哪里」这个议题（§2 已证：`跨设备同步 / 本地存储 / IndexedDB` 零命中），而 `DECISIONS.md:75` 却已经把「30 天自动清除覆盖它」当成已决事实写进连带义务。这是 upstream 与 ADR 的口径分叉，且分叉方向是 ADR 比 upstream 更具体。
4. **`PRD.md:68`（US#35）「排序行为被记录、被清除、被 30 天过期覆盖, so that 偏好数据和我其余数据同命」** — 「同命」这个词在本地优先下不成立，且它是 user story，会被后续 ticket 当验收依据复读。
5. **C5 那两句陈旧假设**（`ADR-0005:24`、`tests/today-list.test.ts:308`）— 需要指名真正拥有 Task[] 快照的那张票（按 `ADR-0006:11` 是 #13 与 #16），否则第 8 键的「同生同灭由调用方守」（`GLOSSARY.md:21`）永远没人接。
6. **`ADR-0007:19` 的不变量没被钉住** — 「界面每次落盘写的是『本轮全部可见卡的 id』，所以一次拖拽顺带把垃圾带走。存储不会长。」这条只活在 ADR 与 `App.tsx:78` 的实现里；`tests/manual-order.test.ts` 测的是 seam 1（构建器），`App.tsx` 无单测（`.scratch/pr-body-t07.md:22` 明说「没有 jsdom/happy-dom 依赖，也没给 `App.tsx` 写单测」）。存储不增长这个结论目前没有门。
7. **`ADR-0007:14` 承诺的「唯一的说明是首次拖拽那一次弹窗」没有备份** — 弹窗文案看过一次即不再出现（`markOrderNoticeSeen()`，`manual-order.ts:49-51`；`hasSeenOrderNotice()` 为真后 `App.tsx:80` 不再 setNotice），而自陈屏「不做常驻入口」（`DECISIONS.md:59`、`#13 AC#2`）。于是「顺序存在本地、清不掉除非清浏览器」这个事实，在产品里是**一次性、不可回看**的陈述。这是 C1 选 (b) 那一支（写清边界）真正的阻力。
8. **编号陈旧**（§C6）— `#18`、`T13 / T14` 两处会让后来人找错票面；其中语义匹配那张票在 tracker 里不存在，直接使 `ADR-0007:15` 的概率评估失去依据。

## 待核实（附自证配方）

1. **#13 / #10 是否已在评论里被交接过**。本轮只取 `--json number,title,body`，评论不在射程内；C1 的定性依赖「票面没有这句」。**配方**：`export HTTPS_PROXY=http://localhost:7890 && "C:/Program Files/GitHub CLI/gh.exe" issue view 13 --repo jing-gou/triage360 --json comments -q '.comments[].body'`（#10 同）。
2. **main 是否已有别人开的本地优先讨论 / 其他 issue 提及 localStorage**。本轮只跑了 `--state all --limit 40`（返回 20 条，即全量）与三条 body。**配方**：`export HTTPS_PROXY=http://localhost:7890 && "C:/Program Files/GitHub CLI/gh.exe" search issues --repo jing-gou/triage360 localStorage --json number,title`；再加 `跨设备`、`本地优先`、`local-first` 各一次。
3. **本分支尚未推送 / 未开 PR**。`git branch -a` 显示 `remotes/origin/ticket/T07-drag-order` 存在，但 open issue 里 #9 仍是 `OPEN`，`.scratch/pr-body-t07.md` 正文还是草稿。**配方**：`export HTTPS_PROXY=http://localhost:7890 && "C:/Program Files/GitHub CLI/gh.exe" pr list --repo jing-gou/triage360 --state all --json number,title,headRefName,state`；本环境 `gh` 不在 agent shell 的 PATH，需按上面的绝对路径调用（见用户级记忆）。
4. **`demoSameEvent` 之外有没有真实判据的票**。§C6 断言「语义匹配目前没有票」，依据是 `--state all --limit 40` 的 20 条标题里没有相似度/语义项。**配方**：`export HTTPS_PROXY=http://localhost:7890 && "C:/Program Files/GitHub CLI/gh.exe" issue list --repo jing-gou/triage360 --state all --limit 100 --json number,title -q '.[] | "\(.number)\t\(.title)"'`（确认 limit 未截断），再 `gh search issues --repo jing-gou/triage360 语义` 。
5. **清浏览器站点数据是否真的让顺序回来**（C1 的唯一现存逃生口）。`manual-order.ts:15-21` 的 `read()` 取不到即 `null`，`loadManualOrder()` 回落 `[]`，`buildTodayList` 缺 `manualOrder` 时走 `today-list.ts:109` 的 `return entries`——逻辑上成立，但本轮**未在浏览器实测**（T07 的 DOM 证据在 `.scratch/pr-body-t07.md:29-30`，测的是「把存储改成 `[321, 921]` 再刷新」而非「清空站点数据」）。**配方**：起 `npx vite`，拖一张卡，DevTools → Application → Local Storage 删 `triage360:manual-order:v1` 与 `triage360:order-notice:v1`，刷新看是否回到 `921 → 922 → 322 → 923 → 321` 的规则序，并确认弹窗会再说一遍（`NOTICE_KEY` 已删）。

## 来源清单

### 本仓库文件（全部真实 Read 取到，分支 `ticket/T07-drag-order` @ `adbab0a`）

- [DECISIONS.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/DECISIONS.md) — 引 `:22`、`:59`、`:60`、`:75`、`:96`、`:105`、`:119`、`:123`、`:139`、`:150`、`:151`；`grep 同步/浏览器/本地存储/设备/IndexedDB` 的命中集合见 §2。
- [docs/PRD.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/docs/PRD.md) — 引 `:39`（US#12）、`:50`（US#20）、`:66`–`:68`（US#33–#35）、`:156`–`:168`（Out of Scope 全节）。
- [GLOSSARY.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/GLOSSARY.md) — 引 `:10`（手动顺序）、`:13`（构建器）、`:21`（`duePrecision` 同生同灭）。
- [docs/adr/0005-scoring-tiers-and-visitor-day.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/docs/adr/0005-scoring-tiers-and-visitor-day.md) — 引 `:16`、`:18`、`:24`、`:40`。
- [docs/adr/0006-dedup-predicate-injection.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/docs/adr/0006-dedup-predicate-injection.md) — 引 `:5`、`:10`、`:11`、`:13`。
- [docs/adr/0007-manual-order-injection.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/docs/adr/0007-manual-order-injection.md) — 引 `:3`、`:5`、`:9`、`:14`–`:19`、`:20`。全节 20 行读完。
- [docs/adr/0003-cross-round-state.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/docs/adr/0003-cross-round-state.md) — 引 `:5`、`:9`、`:11`（题面未列，为核 C5/C6 顺带取）。
- [src/core/today-list.ts](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/src/core/today-list.ts) — `applyManualOrder` 在 `:108-120`，注入声明与注释 `:26-30`，调用点 `:98`，缺省短路 `:109`；另引 `:22`、`:58-61`。
- [src/panel/manual-order.ts](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/src/panel/manual-order.ts) — 文件头 `:1-9`、两个 key `:11-12`、`read`/`write` `:15-30`、`loadManualOrder` `:32-39`、`saveManualOrder` `:41-43`、notice 标记 `:45-51`。
- [src/panel/App.tsx](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/src/panel/App.tsx) — 注入点 `:57-58`、`move()` `:71-81`、`dismissNotice` `:83-86`、弹窗块 `:183-205`（三句 body 分别在 `:190-193`、`:195-198`、`:199`）。
- [tests/manual-order.test.ts](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/tests/manual-order.test.ts) — 5 条断言 `:62-168`；`:93-94` 是「整份落盘」这条代价的注释。
- [tests/today-list.test.ts](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/tests/today-list.test.ts) — 引 `:308-311`（跨轮快照那条注释与用例名）。
- [AGENTS.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/AGENTS.md) — 引 `:17`（PR 正文 / ticket 交接的分流规则）。
- [src/panel/styles.css](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/src/panel/styles.css) — 只用于证明 `grep "撤销\|清除\|reset\|clear" src` 的唯一命中 `:51` 是 CSS 计数器。
- [.scratch/pr-body-t07.md](file:///C:/Users/shuguo/Documents/Qoder/2026-11-16/9bcb939f/.scratch/pr-body-t07.md) — 引 `:22`、`:29-30`、`:49`、`:52`。**注意这是 PR 草稿、非正式留档**（`git ls-tree origin/main` 与 diffstat 里都没有 `.scratch/`），本文件只在「文档债是否已被口头交接」这一点上把它当证据，不当规范依据。

### 一手（GitHub issue tracker，本会话内 `gh.exe` 直接取回）

- issue **#9** `T07: 拖拽排序与首次排序说明` body 全文（§1）——`gh issue view 9 --json number,title,body -q .body`。
- issue **#10** `T08: 学习闭环最小版` body 全文（§1）——同上，`10`。
- issue **#13** `T11: 加密落库与删除义务` body 全文（§1）——同上，`13`。
- `gh issue list --state all --limit 40 --json number,title,state` 全量 20 条（#1–#20，#3–#7 CLOSED）——用于 §C6 与「语义匹配无票」的编号核对。

### 命令原话输出（只读，无工作树改动）

- `git rev-parse --abbrev-ref HEAD` → `ticket/T07-drag-order`
- `git log --oneline -1` → `adbab0a fix: 双轴 review 第一轮——措辞回到代码真做的事，标记等看过才落`
- `git log --oneline -1 origin/main` → `25b1da9 Merge pull request #30 from jing-gou/docs/bycode-wording`
- `git status --short` → 空
- `git log --oneline origin/main..HEAD` → `adbab0a` / `8a1c781 docs: ADR-0007 记下手动顺序为什么是构建器的注入输入` / `b84b88f feat: 任务卡拖拽排序、顺序落本地存储、首次排序说明弹窗` / `81d8b0f feat: 构建器接受注入的手动顺序，作用在合并之后`
- `git diff --stat origin/main...HEAD` → 7 files, 425 insertions(+), 7 deletions(-)
- `git ls-tree --name-only origin/main:docs/adr` → 0001…0006（**无 0007**）；`origin/main:src/panel` → `App.tsx main.tsx styles.css`（**无 manual-order.ts**）
- `git show --stat --oneline HEAD` → `adbab0a`，7 files
