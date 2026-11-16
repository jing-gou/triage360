# triage360

60 秒知道今天做什么：把 GitHub / Gitee / Jira / 飞书上派给自己的任务收敛成一张今日清单。

动手前先读 `DECISIONS.md`；它是本仓库所有 spec、ticket 与实现决策的 upstream。v1 的 spec 在 issue #1（仓库留档：`docs/PRD.md`）。

## 写代码

用 `tdd` skill 驱动每个 slice：测试先在一个**待求行为**上变 **red**，实现到 **green**，再 refactor。seams 只有两条，见 issue #1 的 Testing Decisions。

## 变更落地

代码与文档都走 **review gate**：新建 branch → commit → `gh pr create`（PR 正文由 `pr` skill 撰写）→ 用户审阅并批准之后才合并。main 的写入只发生在合并这一步。

其下还有一道**机械门禁**：required check 名为 `ci`。改完 `.github/branch-protection.json` 要跑 `scripts/apply-branch-protection.sh` 才生效——文件躺在仓库里不会自己上锁。

## Agent skills

### Issue tracker

Issues 和 specs 存放在 `jing-gou/triage360` 的 GitHub Issues，全部通过 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

保留五个 canonical label，名称与 role 相同（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根目录的 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.
