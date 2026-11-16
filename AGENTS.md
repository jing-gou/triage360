# triage360

60 秒知道今天做什么：把 GitHub / Gitee / Jira / 飞书上派给自己的任务收敛成一张今日清单。Qoder Sites 参赛作品，2026-11-30 提交。

动手前先读 `DECISIONS.md`；它是本仓库所有 spec、ticket 与实现决策的 upstream。参赛版 v1 的 spec 在 issue #1（仓库留档：`docs/PRD.md`）。

## Agent skills

### Issue tracker

Issues 和 specs 存放在 `jing-gou/triage360` 的 GitHub Issues，全部通过 `gh` CLI 操作。See `docs/agents/issue-tracker.md`.

### Triage labels

保留五个 canonical label，名称与 role 相同（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根目录的 `GLOSSARY.md` + `docs/adr/`。See `docs/agents/domain.md`.
