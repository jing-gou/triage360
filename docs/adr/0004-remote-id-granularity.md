# ADR-0004 · 远端 id 的唯一性粒度由各 provider 自己决定

**决策**：任务 id 仍是 `providerId:remoteId`（`makeTaskId` / `remoteIdOf` 是唯一的编解码处），但 `remoteId` 的粒度由平台决定：Jira 用全局 issue id，飞书用 task_guid，**GitHub 与 Gitee 用 `owner/repo#number`**。`providerId` 是**永久键**，取平台名（`github` / `gitee` / `jira` / `feishu`），真连顶替假 provider 时不改；样例与真连的差别只由界面标注表达，不进 id。

**原因**：Gitee 的 issue number 只在仓库内唯一，而「指派给我」要遍历仓库（官方没有跨仓库端点，见 `research/platform-limits-and-landing-form.md` 的 Gitee 节）。两个仓库的 313 号如果不带仓库名，会被 `search` 与 `getByIds` 认成同一条——跨平台合并（T05）会把它们合成一张卡，而按 id 刷新会取回错误的条目。GitHub 的 issue number 同样只在仓库内唯一：样例 provider 只盯一个仓库，所以裸编号够用；T09 真连之后 `assignee:@me` 是跨仓库搜索，两个仓库的同号会撞上，于是真 provider 也带仓库段（示例 provider 的 fixture 仍是裸编号，它只有一家仓库，切到真连时清单本来就整份换掉）。仓库名从 issue 自己的 `html_url`（或 `repository_url`）里取，因为按 id 补取要知道该打哪个仓库的单条端点。逐条取回而非批量：Gitee、飞书与真连后的 GitHub 都没有按 id 批量端点，所以这几家的 `getByIds` 一次调用发 N 个请求（调用次数仍是每轮一次，见 ADR-0002；样例 GitHub provider 的 `?ids=` 是替身自造的批量形状）；这是平台代价，不是契约例外。`providerId` 之所以要一起定死：它是 `Task.id` 的前半段，而 id 一旦落库就成了 `previous` 的匹配键——T09 / T15 把 `github-fake` 改成 `github` 会让上一轮全部条目对不上，等于凭空制造一次数据迁移。

**界面上不打印远端 id**：Gitee 那段是 `jing-gou/triage360#313`，整条打印会把一行元信息撑满，而只打印尾段的 `#313` 要在 `makeTaskId` / `remoteIdOf` 之外再解析一次编码。编号在卡片链接的 URL 里本来就看得见；以后真要单独展示，从 `url` 尾段取，不加第七个字段。

**被放弃的选项**：给 `Task` 加第七个字段 `repo`（把一家平台的粒度问题写进全局形状，`docs/PRD.md:101` 的界面与规划层只认归一化形状这条就破了）；这里被拒的是 **`repo` 这一个字段**，不是「第七个字段」这件事本身——同一个位置后来给了 `dueAt`，因为逾期与今日到期是四家共有的语义（US#23），而仓库编号只有 Gitee 一家需要。第 8 键 `duePrecision` 走的是同一条判据：只写日期的截止每家都可能有，它是「原值写到哪一层精度」这个跨平台事实，不是 Jira 的字段泄漏。用 Gitee 的全局 issue `id` 字段（该字段是否存在未实测，T15 真连时若实测可用可以换，代价是已落库的 id 全部对不上——所以 `previous` 里的 id 一旦写进存储就不该再造；T04 之后这个代价又大了一点：`id` 是清单末位的破平键，换 id 除了让上一轮对不上，还会改变用户看到的顺序）；把样例程度编进 id（`-fake` / `-sample` 后缀）——它看着诚实，但真连时要么改名（破上面的永久键）要么让真 provider 顶着一个说假话的名字。
