# triage360

60 秒知道今天做什么：把 GitHub / Gitee / Jira / 飞书上派给自己的任务收敛成一张今日清单。

动手前先读 `DECISIONS.md`；它是本仓库所有 spec、ticket 与实现决策的 upstream。v1 的 spec 在 issue #1（仓库留档：`docs/PRD.md`）。

## 写代码

用 `tdd` skill 驱动每个 slice：测试先在一个**待求行为**上变 **red**，实现到 **green**，再 refactor。seams 只有两条，见 issue #1 的 Testing Decisions。

seam 测试一律放 `tests/` 下、命名 `*.test.ts`，不要 colocate 进 `src/`：`ci` 只跑这个 glob，放错位置等于没跑。

## 变更落地

代码与文档都走 **review gate**：新建 branch → commit → `gh pr create`（PR 正文由 `pr` skill 撰写）→ 用户审阅并批准之后才合并。main 的写入只发生在合并这一步。

双轴 review **两轮封顶**（数的是我自己派出的 review 轮次，review gate 照旧）：第二轮 findings 折完即开 PR。不影响档位与顺序的细节归进 PR 正文「刻意没处理」那一行，或落成对应 ticket 的一句交接——归档即终点，推进下一张 ticket 才是工作面。

其下还有一道**机械门禁**：required check 名为 `ci`——它是 job 名，不是 workflow 显示名。改完 `.github/branch-protection.json` 要跑 `scripts/apply-branch-protection.sh` 才生效，文件躺在仓库里不会自己上锁；脚本末尾会断言线上与文件一致。合并只能从 GitHub 侧发生（`gh pr merge`）：本地 `git merge` 再 push main 会撞 GH006，因为那个合并 commit 上从没跑过 `ci`。

## Agent skills

### Issue tracker

Issues 和 specs 存放在 `jing-gou/triage360` 的 GitHub Issues，全部通过 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

保留五个 canonical label，名称与 role 相同（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根目录的 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.
