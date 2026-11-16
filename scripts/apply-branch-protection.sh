#!/usr/bin/env bash
# 把 .github/branch-protection.json 投递到 main，并断言线上与文件一致。
# 规则的唯一事实来源是那个文件：本脚本不内联任何设置，PUT 是整体的，文件里没写的旋钮会被重置回 GitHub 默认值。
#
# review gate 仍然由人遵守：required_pull_request_reviews 留 null。GitHub 上作者不能 approve 自己的 PR，
# 把 required_approving_review_count 设成 1 会让这个 solo 仓库在不撤 protection 的前提下合不动任何东西。
#
# 顺序：先让 ci.yml 进 main，再跑本脚本。pull_request 事件用的是 head 分支里的 workflow 文件，
# 所以不带 .github/ 的分支永远交不出 "ci" 这个 check，PR 会停在 Expected，而 enforce_admins=true
# 之下连 admin 都绕不过。真锁死了就撤：
#   gh api -X DELETE "repos/$(gh repo view --json nameWithOwner -q .nameWithOwner)/branches/main/protection"
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
protection="repos/${repo}/branches/main/protection"

gh api -X PUT "$protection" --input .github/branch-protection.json >/dev/null

# 断言而不是回读给人看：PUT 是整体的，「文件 == 线上」必须可检查，否则 AC「以文件形式进仓库」只剩一句承诺。
# 比较项只取语义字段（strict / context 列表 / enforce_admins），线上多出来的 url、app_id 不参与。
want=$(node -e 'const f=JSON.parse(require("fs").readFileSync(".github/branch-protection.json","utf8"));const r=f.required_status_checks;console.log(JSON.stringify([r.strict,r.checks.map((c)=>c.context).sort(),f.enforce_admins]))')
got=$(gh api "$protection" --jq '[.required_status_checks.strict, ([.required_status_checks.checks[].context] | sort), .enforce_admins.enabled]')
if [ "$want" != "$got" ]; then
  echo "线上 protection 与文件不一致：want $want got $got" >&2
  exit 1
fi
echo "main 已对齐 .github/branch-protection.json：$got"
