#!/usr/bin/env bash
# 把 .github/branch-protection.json 投递到 main。规则的唯一事实来源是那个文件，本脚本不内联任何设置。
#
# review gate 仍然由人遵守：required_pull_request_reviews 留 null。GitHub 上作者不能 approve 自己的 PR，
# 把 required_approving_review_count 设成 1 会让这个 solo 仓库再也合不动任何东西。
#
# 回读确认：gh api "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection"
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api -X PUT "repos/${repo}/branches/main/protection" --input .github/branch-protection.json
