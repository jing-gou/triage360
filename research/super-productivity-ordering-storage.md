---
question: Super Productivity 的手动排序实际存在哪里、用什么存储、两台设备同步时顺序会发生什么、同步后重新应用顺序是一等能力还是已知缺陷
date: 2026-11-17
method: 一手 = 浅克 `super-productivity/super-productivity` 到 `%TEMP%/sp-clone`，逐行读**源码原文**与仓库内文档；issue 正文/评论用 `gh api` 直接取。所有 file:line 为本轮 `grep -n` / `sed -n` 实测行号
status: 已逐行核实——Task 模型无排序字段、三套排序编码（anchor move / whole-list replace / panel taskIds）、`reorder-conflict.util.ts`(569 行)、`docs/sync-and-op-log/order-and-membership-options.md`(377 行)、ADR#2/#8、AGENTS.md sync rule 5/13/15、IndexedDB `SUP_OPS` 与 localStorage 分工、issue #8462(OPEN)/#11414(OPEN)/#11388/#10377/#10420/#11479。仍未取一手——`section-conflict-commutativity.util.ts` 正文、`conflict-resolution.service.ts` 的 reorder 分支、WebDAV 文件型 provider 的实际 resolve 路径——列入「待核实」
related: [super-productivity-implementation.md, personal-cross-platform-issue-dashboard.md, platform-limits-and-landing-form.md]
---

# Super Productivity 的手动排序：存储、同步与重新应用（源码级）

> 取证基线：本轮 commit **`2b3f78edbf0721f0842daa097e47247fe245852f`**（`master`，Sat Nov 14 11:45:14 2026 +0100，`feat(boards): show deadline on board task cards (#11059)`）——与前一份笔记同一 commit。克隆位置 `%TEMP%/sp-clone`，`git clone --depth 1` 走 `HTTPS_PROXY=http://localhost:7890`。所有相对路径以此为根。

## 结论摘要（TL;DR）

1. **没有 per-task rank 字段。顺序一律是「容器上的一条有序 id 数组」。** `Task` 的权威定义在 `packages/plugin-api/src/types.ts:391-430`，全部字段里没有 `order` / `rank` / `sort` / `position`；`src/app/features/tasks/task.model.ts:185` 只是 `export type Task = Readonly<TaskCopy>`。顺序住在**父实体**上：`project.taskIds` / `project.backlogTaskIds`（`src/app/features/project/project.model.ts:26-27`）、`section.taskIds`（`src/app/features/section/section.model.ts:10`）、`task.subTaskIds`（`types.ts:403`）、`note.todayOrder`、`boardPanel.taskIds`（`boards.model.ts:78`）。唯一带「排序」语义的 per-task 字段是 `priority`，那是属性不是位置。
2. **拖拽落点用 anchor 表达，不是索引。** 核心 helper `moveItemAfterAnchor(itemId, afterItemId, currentList)`（`src/app/features/work-context/store/work-context-meta.helper.ts:18-48`）：先 filter 掉自己，再 `splice(anchorIndex + 1, 0, itemId)`。锚点被并发删除时有显式两条兜底（见 §2 原文）——**它从不接受「第 N 位」这个数字**，这是它能安全重放的前提。
3. **持久化 = IndexedDB 里的 append-only op-log，重启靠「快照 + 增量重放」恢复顺序。** 库名 `SUP_OPS`、`DB_VERSION = 11`（`src/app/op-log/persistence/db-keys.const.ts:11,23`）。localStorage 只放**设备本地 UI 状态**，而「视图排序方式」恰好在 localStorage 那侧（§3）。SQLite 替代方案已被维护者 **Parked**。
4. **一次「手动拖拽」就是一次同步事件，且编码不统一，分三种：** (a) `moveTaskInTodayList` = **单实体** anchor move，op 声明 TAG/PROJECT 自己（`work-context-meta.actions.ts:14-32`）；(b) `updateSectionOrder` / `sortBoards` = **多实体 bulk**，payload 是整条 id 数组且 `entityIds` 声明全表（`section.actions.ts:47-58`、`boards.actions.ts:71-80`）；(c) `updatePanelCfgTaskIds` = 整表 replace 但 `opType: Update` 且把 **panel id 当 BOARD 实体 id**（`boards.actions.ts:58-69`，这个错配是 OPEN issue #11414 的正文）。
5. **同步后的顺序是「一半一等、一半记账在册的已知残留」。** 一等部分：`src/app/op-log/sync/reorder-conflict.util.ts`（569 行）+ `section-conflict-commutativity.util.ts`（20,654 B）专门为 reorder 写了可交换性证明、被拒 op 的「按当前状态重发」和 rebase。残留部分：它自己的设计文档 `docs/sync-and-op-log/order-and-membership-options.md` 第一句 TL;DR——**「List divergence is the largest remaining fuzz class: 71 of 120 seeds. Most of it is order only, and no user report shows harm from it, so under rule 15 the recommended outcome is to build nothing now」**（`:10-11`）。
6. **官方把「顺序分歧」写进了不准修的门槛。** `AGENTS.md:98` sync rule 15 要求 sync fix 必须有 harm 证据，`docs/sync-and-op-log/contributor-sync-model.md:299-302` 原文：**「Order-only differences, and disagreement that the next sync repairs, do not qualify.」** 也就是说：顺序在两台设备上不一样，在这个项目里是**可接受的最终状态**，不是 bug。
7. **#8462 到本轮仍 OPEN，且维护者 2026-11-07 亲自定性为 by design。** `@johannesjo` 评论原文（见 §5）：视图定制器里选的 sort 是 per-device 的，要跨设备一致必须 **Save as default**（它会把 sort 落到 list 的 `taskIds` 上，于是同步）；而「把 sort mode 常驻存在 list 上」尚不支持，该 issue 已改标 feature request。
8. **它已经实现了 owner 关心的「读侧重新应用」，但只在 boards/views 那一处**：`orderPanelTasks()`（`src/app/features/boards/board-panel/panel-rules.ts:122-146`）= **先按存的 `taskIds` 排，没被列出的成员追加在后面**；`isManualOrder = computed(() => !this.sortKey())`（`board-panel.component.ts:407`）——**`sortBy` 缺省即手动**。这正是它文档里的 option (B)（derived membership + read-side order），只是没推广到 project/tag 列表。

---

## 1. 顺序到底存在哪：一张实测清单

一手依据：`docs/sync-and-op-log/order-and-membership-options.md:98-112`（它自己给的 inventory 表）+ 逐个 `grep` 回源码核对。表里的「Declared」是 op-log `getOpEntityIds` 看得见的声明实体；**未声明的写入永远不会被判为冲突**。

| 有序列表 | 定义位置 [一手] | 成员关系 | 顺序编码 |
|---|---|---|---|
| `project.taskIds` | `project.model.ts:26` | **Stored**（视图直接读这条表） | anchor move（`project.reducer.ts:117`） |
| `project.backlogTaskIds` | `project.model.ts:27` | **Stored**，无 child fact | anchor move（`project.reducer.ts:133,317`） |
| `section.taskIds` | `section.model.ts:10` | **Stored**，无 child fact | 整表 replace（`section.actions.ts:47`）+ anchor（`addTaskToSection:71`） |
| TODAY `tag.taskIds` | `features/tag/tag.const.ts` | **Derived**（成员来自 `dueWithTime ?? dueDay`）；ADR#2 明文「`taskIds` 只存顺序不存成员」 | anchor move |
| 普通 `tag.taskIds` | `work-context.model.ts:69` | Derived（`task.tagIds`） | anchor move |
| `task.subTaskIds` | `types.ts:403` | **Stored**（`task.parentId` 也在） | 整表（`task.reducer.ts:136 reorderSubTask`） |
| `note.todayOrder` / `project.noteIds` | `note.model.ts` / `project.model.ts` | Stored | 整表 replace |
| `boardPanel.taskIds` | `boards.model.ts:78` | Derived（面板过滤器）；顺序 only | 整表 replace（`boards.actions.ts:58`） |
| `planner.days[day]` | `planner.reducer.ts:119` | Stored（未来天） | **index-based** `moveItemInArray` |
| adapter `ids`（task/note/counter/issueProvider/section/project/tag） | 各 `*.reducer.ts`（**无 `sortComparer`**） | Order only | 整表 / append |

决定性原文（`order-and-membership-options.md:111`，adapter `ids` 那行）：

> `Order only. Habits, issue providers and sections display this order. `task.ids` order reaches lists built from all tasks (overdue, deadlines; not measured here), and `Object.keys(entities)` order decides where an _unlisted_ Today or tag member goes.`

→ 注意最后半句：**未被任何列表点名的成员，位置由 JS 对象的键插入顺序决定**，而那是每台设备自己的历史。这就是 §4 分歧机制之一。

`moveItemAfterAnchor` 全文（`src/app/features/work-context/store/work-context-meta.helper.ts:18-48`）[一手]：

```ts
export const moveItemAfterAnchor = (itemId, afterItemId, currentList) => {
  const listWithoutItem = currentList.filter((id) => id !== itemId);
  if (afterItemId === null) return [itemId, ...listWithoutItem];   // Move to start
  const anchorIndex = listWithoutItem.indexOf(afterItemId);
  if (anchorIndex === -1) {
    // Anchor not found (concurrently deleted).
    if (listWithoutItem.length < currentList.length) {
      // Item already in list — preserve current position (no-op).
      return currentList;   // 返回原引用，让 NgRx selector 判定「没变」
    }
    // Item is new to this list (cross-list move) — append to end as fallback
    return [...listWithoutItem, itemId];
  }
  const result = [...listWithoutItem];
  result.splice(anchorIndex + 1, 0, itemId);
  return result;
};
```

UI 侧还有两个「主动抑制顺序写入」的分支，值得单独记：

- `task-list.component.ts:702-709`：`// The Done list is always ordered by completion date, so reordering within it can't take effect (the view re-sorts on the next emission). Skip the move to avoid emitting a spurious taskIds-reorder op that would sync to other devices.` → **`src === 'DONE' && target === 'DONE'` 直接 return。**
- `task.component.ts:880-883` 同样的守卫，理由一样：`// reorder can't take effect — skip it to avoid emitting a spurious ... op that would sync to other devices.`
- 落点判定后立刻 `this._taskViewCustomizerService.setSort(DEFAULT_OPTIONS.sort)`（`task-list.component.ts:631,637`）——**手动拖拽会把「视图排序」重置回默认**，否则 sort 会把刚定的位置重排掉。这是「手动顺序 vs 自动排序」在 UI 层的互斥表达。

## 2. 拖拽实现：CDK + 三套 dispatch

前端一律 Angular CDK `CdkDragDrop`。全仓 13 个 drop 处理器（`grep -rn "CdkDragDrop"`），任务的在 `src/app/features/tasks/task-list/task-list.component.ts:459` 的 `drop()`：把 CDK 给的 currentIndex 翻译成一个**可见列表 `newIds`**，再由 `_move()`（`:680` 起）算出 `afterTaskId = getAnchorFromDragDrop(taskId, newOrderedIds)` 并 dispatch。**UI 计算整表，但发给 store 的只有 `(taskId, afterTaskId)` 一对。** 目标类型分发：section → `addTaskToSection(target, taskId, afterTaskId, sourceSectionId)`；拖出 section → `removeTaskFromSection(..., workContextAfterTaskId)`；普通列表内 → `moveTaskInTodayList`；拖进子任务列表 → `convertToSubTask({taskId, targetParentId, afterTaskId})`。

`src/app/util/move-item-in-array.ts:3-26` 是纯 index 版（clamp + 位移），只给 planner / notes / habit / issue-panel / section 表头用。

## 3. 存储：IndexedDB 为主，localStorage 只放设备本地，两者分工写死在代码里

- **主数据（含所有顺序）**：IndexedDB `SUP_OPS`，`DB_VERSION = 11`（`db-keys.const.ts:11,23`）。版本注释本身就是取舍记录：`// Versions 8–10 are deliberate downgrade barriers ... Version 11 removes the obsolete User Profiles data store and therefore also prevents older builds from opening the migrated database.`
- **op-log 结构**（同文件 `STORE_NAMES`）：`ops` / `state_cache` / `import_backup` / `vector_clock` / `archive_young` / `archive_old` / `client_id`。**顺序不单独存**，它活在 `ops` 里那些 `OpType.Move` 的 payload 与 `state_cache` 快照中。
- **重启后怎么重新应用**：`operation-log-hydrator.service.ts:63-69` 类注释——`Handles the hydration ... first attempts to load a saved state snapshot, and then replays any subsequent operations from the log ... optimizes startup performance by avoiding a full replay of all historical operations.` 即**快照 + 增量重放**；重放必须确定性，这解释了 §1 为什么 anchor 而非 index。
- **为什么 IndexedDB 而不是 localStorage**：`docs/wiki/3.06-User-Data.md:3` 用户口径「The web app stores data in browser storage (IndexedDB and localStorage) instead」，`:111` 起列 5 个 IDB 库。真正的容量理由在 `src/app/core/draft/local-draft.service.ts:53-60`：`localStorage's quota (~5 MB) is shared with UI state, so one huge note must not be able to fill it and break those writes.`
- **localStorage 那侧恰好装着「视图排序」**（这是 #8462 的根因）：`src/app/features/task-view-customizer/task-view-customizer.service.ts:157-189` —— `_stateByContext` 从 `LS.TASK_VIEW_CUSTOMIZER_BY_CONTEXT` 读，key 是 `` `${activeType}:${activeId}` ``，值 `{sort, group, filter, collapsedGroupIds}`，写回 `lsSetJSON(LS.TASK_VIEW_CUSTOMIZER_BY_CONTEXT, ...)`。它**不进 op-log、不进同步**。同一个 key 在 `storage-keys.const.ts:142` 里和 `BOTTOM_NAV_SLOT`（注释 `Device-local, never synced`）并列。
- **SQLite 换后端 = Parked**：`docs/sync-and-op-log/sqlite-migration.md:3-9`「**Status (2026-09-26): Parked by maintainer decision.** ... IndexedDB remains the live op-log backend on every platform. ... **Reopen only for a confirmed IndexedDB eviction loss not covered by native backups.**」→ 说明「WebView IndexedDB 被系统驱逐」是他们已知并为此做了原生 SQLite 备份（Android `SupKeyValStore`，`3.06-User-Data.md:145`）的风险，而不是没想过。

## 4. 两台设备同步时顺序发生什么

**op 形状**（三种，见 TL;DR#4）。以 `updateSectionOrder`（`src/app/features/section/store/section.actions.ts:47-58`）为最完整的整表形态：

```ts
export const updateSectionOrder = createAction(
  '[Section] Update Section Order',
  (payload: { contextId: string; ids: string[] }) => ({
    ...payload,
    meta: { isPersistent: true, entityType: 'SECTION', entityIds: payload.ids,
            opType: OpType.Move, isBulk: true },
  }),
);
```

**什么算「一次 reorder」**：`src/app/op-log/sync/reorder-conflict.util.ts:141-160` 的 `isContentReorderOperation`——要求 `actionType` 在 `REORDERS` 表里、`opType === OpType.Move`、payload 的 `ids` 是非空字符串数组、**且 `op.entityId === ids[0]` 且声明集与 ids 完全一致**。`:43-46` 的头注释：`Each reorder writes exactly one ordered list per context: project.noteIds ... or note.todayOrder ... simpleCounter.ids, boardCfgs, the context's slots of section.ids, issueProvider.ids.`

**并发 reorder 的实际结果**（三种，按代码路径）：

1. **整表竞争 → 一方整表胜出。** `reorder-conflict.util.ts:236-240` 上方注释：`a competing reorder of the same list: the list as it stands after the remote order (either device's order may win, #10264)`。**不做 merge，不保留双方的相对位置。**
2. **reorder × 单实体编辑 → 有可交换性证明才双方存活。** `:212-218`「The one rule」：`a reorder commutes with a single-entity patch of one of the entities it lists when the patch keeps the entity's identity and writes neither the reordered list nor its membership.` 为此维护了 `LIST_ROUTED_FIELDS`（`:68-73`）把「哪些字段会写进有序列表」当数据登记，并有 spec 穷举每个 model 字段防漏。
3. **证明不出来 → fail-closed 停止同步。** 由 `AGENTS.md:97` rule 14 兜着：`No new crossing may reach the fail-closed stop (UnsupportedMultiEntityConflictError) ... Removing a safety stop alone is not a fix (#10264).` 历史上真停过：#10377（closed 2026-09-30）标题 `Sync stops when two devices reorder the same list, or a reorder crosses a delete (SYNC_MULTI_ENTITY_UNSUPPORTED)`，正文 `:What the user sees` 写「On the next sync, B stops ... **Every later sync stops again** ... the refused op holds back the whole downloaded batch and the cursor never advances」。#10420 是同一形状的第二个。
4. **文件型 provider（WebDAV/Dropbox）没有裁判**：`reorder-conflict.util.ts:317-320` 原文 `File-based providers never reject an upload, so the reorder is reissued at download time on every provider instead of waiting for a server rejection.`

**为什么不能塌成普通 entity LWW**（`docs/sync-and-op-log/section-conflict-replay.md:26-33`）：

> `SECTION actions encode ordered relationships across a section and its Project or Tag work context. Replacing a rejected move, removal, or reorder with a snapshot of one entity loses reducer semantics: a task can remain in two containers, disappear from both, or converge with different ordering on each client.`

**三条已定性的分歧机制**（`order-and-membership-options.md:124-146`，逐条读过真实 trace + op-log dump）：

1. **作者端和接收端插入规则不同**：`tasks:20725000` 上 B 的 `planTasksForToday` 把 t3 放**最前**，服务器判并发后以 `[TASK] LWW Update` 下发，其 `syncTodayTagTaskIds` 放**最后** → B 得 `[t3,t2,t1]`，别人 `[t2,t1,t3]`，`for good`。33 个 Today-order seeds 里 18 个是这个形状。
2. **插入依赖 apply 顺序**：两个并发 add 在不同设备落成不同顺序。
3. **列表不跟随事实（status-blind）**：NOTE 的 LWW Update 改了 `isPinnedToToday` 但不碰 `todayOrder` → 就是 #10379 的那部分，由 PR #10659 修（已 MERGED）。
4. **（第四个只有已发布客户端有）**：`v18.15.0`/`v19.1.0` 把 `updateNoteOrder` 当整表 replace 应用；master 改成保成员（#10298/#10407）**且未发布**——文档给的证据是 `git tag --contains 9498efc77` **is empty**。

**它自己考虑过的四条路**（`:205-252`，比较表 `:269-281`）：(A) 什么都不做；(B) derived membership + 确定性读侧顺序；(C) **`orderKeys?: Record<contextId, string>` fractional-index 存在 child 上**——即 owner 在权衡的那个方案，这里被判为「大改：约 34 个文件要写 key、需要版本 floor、混版不收敛」；(D) RGA-style sequence CRDT——「为一个既没有 seed 也没有用户报告证明的属性（同一 item 的并发移动）付最大代价」。**Recommendation（`:282-302`）：1. Build nothing now (A)；3. Do not start (C) or (D) without the floor (#10397)。** 并且诚实标出「Missing evidence」段（`:364-378`）：**fuzz 里没有 task-move intent，所以并发**显式**移动完全没有数字。**

## 5. 是一等能力还是已知缺陷：它自己仓库里的原文

**用户侧文档说得像一等能力**——`docs/wiki/4.01-The-Today-View.md:17`：

> `The **order** of tasks in the Today View is the order you set. When you rearrange tasks there (for example by drag-and-drop or keyboard shortcuts), that order is saved and used whenever you open the Today view.`

`:26` 的对照表把 Today 和其他视图的顺序都写成「The order you set in that project or tag」。两处都**只说「saved」，没说「synced」**。

**但跨设备这条仍挂着 OPEN issue，且维护者定性为设计如此**——#8462 `🚨 Sort order inside lists does not sync between devices`（OPEN，2026-06-18，`gh api` 实取）。报告者 `@rowschank` 的期望行为原文：`The sorting order is stored as a list property and synchronised to other devices`。

- `@johannesjo [COLLABORATOR] 2026-06-18T09:54:16Z`：`I think this will be fixed with the next release.`
- `@siemieniuk [CONTRIBUTOR] 2026-09-28T16:58:44Z`：`It is partially fixed in 19.1.0. It sorts properly when setting sort option as default for current view. However, setting sorting without saving as default keeps persistance of selected sorting locally, but not globally.`
- `@johannesjo [COLLABORATOR] 2026-11-07T10:58:45Z`（**本轮 commit 前 7 天**）：`This is currently by design: a sort you pick in the view customizer without saving it is a per-device view setting (like group and filter) and stays local. To get the same order on all devices, use **Save as default** — it applies the sort to the list's task order, which syncs. What isn't supported yet is a *persistent* sort mode stored on the list itself (so new or changed tasks stay sorted and the setting syncs). I've re-labeled this as a feature request for that; upvotes help gauge demand.`

**顺序分歧是官方明文的「不修」类别**：`AGENTS.md:98` rule 15 + `docs/sync-and-op-log/contributor-sync-model.md:299-302`：

> `**Data loss, a sync stop, or permanent content divergence** on a path that released clients or default settings take, shown by a reproduction: an E2E, or a fuzz seed that fails on every replay. **Order-only differences, and disagreement that the next sync repairs, do not qualify.**`

同文档 `:283-285` 给了这个门槛存在的原因：`Most sync fix code has come from our own audits, not from users. Of the 45 largest sync fixes between the op-log merge (2026-01-11) and 2026-09-26, 27 (+10.9k production lines) came from audit findings ... and 11 (+4.0k) from user reports.`

**本轮仍 OPEN 的两个直接相关项**（`gh api` 实取，均带 file:line）：

- **#11414**（OPEN，2026-11-02）`Boards/views: concurrent reorders of one section may diverge because the panel id is declared as a BOARD entity` — `Found while reviewing #11388. **Read from code only, not reproduced. Per sync rule 15 this needs a reproduction before any fix.**` 正文点出 `src/app/features/boards/store/boards.actions.ts:58-69`：`A panel id is not a board id.`
- **#11388**（closed 2026-11-02）`Boards/views: manual task order can differ between devices after a concurrent reorder and board edit` — `The bug is in released clients (`updatePanelCfgTaskIds` ships since v12.0.0). It has been confirmed by reading the code, not reproduced yet.`
- **#11479**（OPEN，2026-11-04）`💡 Local REST API: reorder tasks and move subtasks between parents` — 脚本/AI 用户视角：`The API can create, edit, delete and move tasks between projects, but **it cannot change order or parent**`。→ 顺序在它的公开 API 面上也还没一等。
- 另有 **#3422**（closed）`Cannot Reorder Task in TODAY`、**#10836**（closed）`Move up/down and detail-panel top/bottom reorder hidden list for sectioned tasks`。

**已为一等能力付的钱**：`reorder-conflict.util.ts` 569 行 + `section-conflict-commutativity.util.ts` 20,654 B + `section-conflict-replay.md` 369 行「Admission contract」5 条证明（`:57-70`）+ 12 个专门 E2E/integration 文件（`section-conflict-replay.md:12-23` 列了名字，含 `webdav-reorder-competing-and-delete.spec.ts`）。同时 `section.actions.ts:63-68` 的 `FOLLOW-UP` 承认了技术债：

> `FOLLOW-UP: a `task.sectionId` membership model would atomize cross-section moves and obviate most of section-shared.reducer.ts. Needs a migration path for existing data — out of scope.`

**schema 版本与此无关**：`packages/shared-schema/src/schema-version.ts:38` `CURRENT_SCHEMA_VERSION = 4`，ADR#8（`ARCHITECTURE-DECISIONS.md:426-490`）规定顺序这类变化**不该 bump**——`Do not raise CURRENT_SCHEMA_VERSION unless a change is both inexpressible as an additive or derived field and would be _misapplied_ ... by older clients`，且理由很硬：`there is **no desktop auto-updater**（`electron/start-app.ts` 的调用被注释掉）`+`The legacy fleet does not age out on its own`。

---

## 待核实（附自证配方）

1. **`section-conflict-commutativity.util.ts` 正文**——`areCommutingSectionOperations` / `isSectionTaskListWrite` / `projectSectionReplayAgainstState` 的实际判定，本轮只从调用方与 `section-conflict-replay.md` 的 admission 5 条反推。配方：`sed -n '1,200p' src/app/op-log/sync/section-conflict-commutativity.util.ts`（569 行那份的兄弟文件）。
2. **project/tag 列表是否也走「读侧 unlisted 追加」**。§1 已核实 boards 有 `orderPanelTasks`、adapter `ids` 那行的 `Object.keys(entities)` 兜底；但 `computeOrderedTaskIdsForToday` / `computeOrderedTaskIdsForTag` 的正文未逐行读。配方：`grep -n "computeOrderedTaskIdsFor" -A 40 src/app/features/work-context/store/work-context.selectors.ts src/app/features/tag/store/tag.reducer.ts`。**这条直接决定 owner 该抄 boards 那套还是 Today 那套。**
3. **「Save as default」到底改了什么**——#8462 里维护者说它「applies the sort to the list's task order, which syncs」。代码路径应在 `task-view-customizer.service.ts` 的 setAsDefault → `updateTag`/`updateProject` 带 `taskIds`（inventory 表 `:102-103` 列了 `updateTag (sort, plugin)`）。本轮未逐行追。配方：`grep -rn "setAsDefault\|saveAsDefault" src/app/features/task-view-customizer src/app/features/work-context`。
4. **op-log 的重放窗口内，手动顺序会不会被 effect 覆写**。inventory 提到 `repairTodayTagConsistency$` 和 `preventParentAndSubTaskInTodayList$` 会整表 `updateTag` 追加缺失成员（`:222-226`「they would fire after every add or plan」），`tag.effects.ts` 正文未读。配方：`grep -n "repairTodayTagConsistency\|preventParentAndSubTask" -A 25 src/app/features/tag/tag.effects.ts`。
5. **WebDAV/文件型 provider 上顺序的真实表现**：`reorder-conflict.util.ts:317-320` 那句话是代码注释，`order-and-membership-options.md:375-376` 自己承认 `File providers: the harness models SuperSync only ... Unmeasured.`。配方：跑 `e2e/tests/sync/webdav-reorder-competing-and-delete.spec.ts`。
6. **fuzz 数字能否复现**（71/120、42 order-only）。本轮只读文档结论，未跑。配方：`npm ci && npm run test:file src/app/op-log/testing/integration/sync-fuzz/sync-fuzz-signature-report.benchmark.ts`，输出在 `SYNC_FUZZ_REPORT_START`/`_END` 之间；文档 `:352-356` 明说这个命令**预期非零退出**。
7. **「#8462 改标 feature request」的 label 现值**：`gh api .../issues/8462 --jq .labels` 本轮返回**空数组**，与维护者自述「I've re-labeled this」不一致——可能是改标后又摘了，或标签在 project 而非 issue 上。状态（OPEN）与 6 条评论已逐条实取，只有 label 这条存疑。

## 来源清单

### 一手（本会话内真实读到原文；全部同一 commit `2b3f78edbf0721f0842daa097e47247fe245852f`，channel = `%TEMP%/sp-clone` 浅克后本地 `grep`/`sed`/`cat`）

**源码（顺序与模型）**
- `packages/plugin-api/src/types.ts:391-430` —— `Task` 权威定义，全字段无排序键（TL;DR#1 的否证）。
- `src/app/features/tasks/task.model.ts:185`（`Task = Readonly<TaskCopy>`）、`:20-33`（`DropListModelSource`）、`:235-237`（`DEFAULT_TASK.subTaskIds`）。
- `src/app/features/project/project.model.ts:26-27`；`src/app/features/section/section.model.ts:4-10`；`src/app/features/work-context/work-context.model.ts:69`；`src/app/features/boards/boards.model.ts:38,72-90`。
- `src/app/features/work-context/store/work-context-meta.helper.ts:18-48`（`moveItemAfterAnchor` 全文，已粘原文）。
- `src/app/features/work-context/store/work-context-meta.actions.ts:14-32`（`moveTaskInTodayList` 单实体 anchor move）。
- `src/app/features/section/store/section.actions.ts:47-58,63-90,112-135`（`updateSectionOrder` / `addTaskToSection` + `FOLLOW-UP` / `removeTaskFromSection`）；`section.reducer.ts:62-80`。
- `src/app/features/boards/store/boards.actions.ts:58-80`（`updatePanelCfgTaskIds`、`sortBoards`）；`boards.reducer.ts:10-30`（`keepStoredTaskIds` 及其注释）；`board-panel/panel-rules.ts:118-146`（`orderPanelTasks`）；`board-panel/board-panel.component.ts:363,407,450,833,862`（`isManualOrder`）。
- `src/app/features/tasks/task-list/task-list.component.ts:459-712`（`drop()`、`_dropIntoView`、`_move()` 与 `:702-709` DONE→DONE 抑制）；`task/task.component.ts:880-883`。
- `src/app/features/tasks/store/task.reducer.ts:136,474-486,754-777`；`task.actions.ts:69-138`（`moveSubTask*` 全带 `opType: OpType.Move`）；`util/move-valid-ids-to-front.ts` 全文；`src/app/util/move-item-in-array.ts:3-26`。
- `src/app/root-store/meta/task-shared-meta-reducers/section-shared.reducer.ts:100-127,255-272`；`task-batch-update.reducer.ts:296-303`（`case 'reorder'`）；`src/app/root-store/meta/task-shared.actions.ts:513-522`。
- `src/app/features/task-view-customizer/task-view-customizer.service.ts:157-189`（sort 落 localStorage）；`src/app/core/persistence/storage-keys.const.ts:136-142`；`src/app/core/persistence/local-storage.ts:1-19`。

**源码（持久化与同步）**
- `src/app/op-log/sync/reorder-conflict.util.ts` —— **569 行全文读完**；引用 `:43-52`（REORDERS 表与注释）、`:60-73`（LIST_ROUTED_FIELDS）、`:141-160`、`:212-237`、`:317-320`、`:404-430`、`:505-569`（`rebaseKeptReorders`）。
- `src/app/op-log/persistence/db-keys.const.ts:1-40`（`DB_NAME`、`DB_VERSION = 11` 及 downgrade-barrier 注释、`STORE_NAMES`）；`operation-log-hydrator.service.ts:63-69`；`indexed-db-op-log-adapter.ts:1-15`；`schema-migration.service.ts:1-40`。
- `src/app/core/draft/local-draft.service.ts:53-60`（localStorage ~5MB 共享配额）。
- `packages/shared-schema/src/schema-version.ts:1-40`（bump policy 全文注释、`CURRENT_SCHEMA_VERSION = 4`）。

**仓库内文档**
- `docs/sync-and-op-log/order-and-membership-options.md` —— **377 行全文读完**，本轮最关键来源。引用 `:1-19`、`:21-90`（fuzz 测量表）、`:92-118`（inventory 表）、`:120-161`（四条分歧机制）、`:163-192`（rule 15 harm 检索，含 #8462/#7458）、`:194-306`（(A)–(D) 选项与比较表、Recommendation）、`:307-318`（O1–O5 待决）、`:350-378`（复现配方与 Missing evidence）。
- `docs/sync-and-op-log/section-conflict-replay.md:1-70`（owners 清单、"Why generic entity LWW is insufficient"、Admission contract 5 条）。
- `docs/sync-and-op-log/contributor-sync-model.md:281-303`（Fix intake 原文与审计/报告比 27:11）。
- `docs/sync-and-op-log/operation-log-architecture.md:435-445`（多 Tab / Web Locks）、`:1418-1432`（IDB quota 不是回滚路径）、`:1505-1520`（archive 分区不整表重写）。
- `docs/sync-and-op-log/sqlite-migration.md:1-35`（Parked + reopen 条件 + Android 原生备份）。
- `ARCHITECTURE-DECISIONS.md:45-75`（ADR#2，含 `The tag's taskIds field stores only the ordering of tasks, not membership` 与 "Self-healing ordering"）、`:426-490`（ADR#8）。
- `AGENTS.md:84-99`（sync rule 5 / 12 / 13 / 14 / 15 原文）。
- `docs/wiki/3.06-User-Data.md:3,9,111-135,145,155`；`docs/wiki/4.01-The-Today-View.md:17,26`。

**GitHub issue / PR（`gh api` 逐条实取，含 user、author_association、时间戳）**
- #8462 OPEN：title / body 全文 / 6 条评论全文（`@johannesjo`、`@siemieniuk`、`@rowschank` 定性见 §5）。
- #11414 OPEN、#11388 closed、#10377 closed、#10420 closed、#11479 OPEN、#10393 OPEN、#10379 OPEN：state / title / created / closed / comments 计数 + body 前 700 字符。
- PR #10659 `MERGED`（`fix(sync): update Today note order on remote pin/unpin`）。

### 非一手

- 本轮**未引用任何二手解读**：无博客、无评测、无 super-productivity.com 页面。
- `docs/plans/2026-10-30-saved-views.md:15`（`manual order and write-back on drop`）是**计划文档**而非已实现事实，只用来印证 boards 的意图，不作为行为证据。
- issue #11414 / #11388 正文自称 `Read from code only, not reproduced` —— 引用时保留了这个限定：**它们是维护者对代码的陈述，不是复现结论**。

### 传输通道说明

- 源码与文档：`HTTPS_PROXY=http://localhost:7890 git clone --depth 1` 到 `%TEMP%/sp-clone`，之后全部本地 `grep -n` / `sed -n` / `cat` 读取。前一份笔记记录过 `raw.githubusercontent.com` / `cdn.jsdelivr.net` / `cdn.statically.io` 在本机不可达，**本轮用浅克绕过了这个限制，这也是它给的复核配方**：`cd $TEMP/sp-clone && git log -1 --format=%H` 应得 `2b3f78edbf0721f0842daa097e47247fe245852f`；行号若漂移，用 `grep -n '<本轮引用的原文片段>' <file>` 重定位。
- issue：`export HTTPS_PROXY=http://localhost:7890` + `"C:/Program Files/GitHub CLI/gh.exe" api repos/.../issues/<n>`。**评论作者最初用 `--jq '.[].user.login'` 返回 null**（`gh issue view --json comments` 的嵌套路径问题），改用 `gh api .../comments` 才拿到 login 与 `author_association`——owner 复核时直接用 api 端点。
- 未打印任何 token 或 auth 头。
- 与前一份笔记的关系：`super-productivity-implementation.md` 的 TL;DR#7（op-log + vector clock + SuperSync）与 ADR#10 在本轮得到源码级印证，并被**具体化到排序这一维度**；该笔记「待核实 4（SuperSync 与 op-log 的调用面）」在本轮 §4 部分回答——reorder 的调用面就是 `reorder-conflict.util.ts` 的 admission/reissue/rebase 三段。该笔记对 owner 的结论「手动排序走本地优先」目前**有一个它没掌握的支撑证据**（`order-and-membership-options.md` 的 build-nothing + rule 15）和**一个反例**（boards 的 `orderPanelTasks` 读侧合并证明「存一份 hint + 读时应用」在他们代码里已经落地）。
