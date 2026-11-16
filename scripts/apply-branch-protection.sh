#!/usr/bin/env bash
# 把 .github/branch-protection.json 投递到 main。规则的唯一事实来源是那个文件，本脚本不内联任何设置。
#
# review gate 仍然由人遵守：required_pull_request_reviews 留 null。GitHub 上作者不能 approve 自己的 PR，
# 把 required_approving_review_count 设成 1 会让这个 solo 仓库在不撤 protection 的前提下合不动任何东西。
#
# 回读确认：gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection"
#
# 顺序：先让 ci.yml 进 main，再跑本脚本。pull_request 事件用的是 head 分支里的 workflow 文件，
# 所以不带 .github/ 的分支永远交不出 "ci" 这个 check，PR 会停在 Expected；
# 而 enforce_admins=true 之下连 admin 都绕不过。真锁死了就撤：
#   gh api -X DELETE "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection"
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api -X PUT "repos/${repo}/branches/main/protection" --input .github/branch-protection.json
