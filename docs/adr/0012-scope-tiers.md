# ADR-0012 · 公私两档授权：两次独立授权、两枚 token 并存、实际 scope 以响应头为准

**决策**：GitHub 拆两档——`public`（`public_repo`）与 `private`（`repo`），各走一次独立 OAuth 授权，各得一枚 token，同时并存于同一条租户记录（`grants.public` / `grants.private`），第二次授权不覆盖第一档。首次连接走 `GET /auth/github?tier=public`；第二档与重新授权走 `POST /api/auth-url`（Bearer 会话标识，返回授权页地址），回调用 `PendingAuth.sessionId` 把授权挂回同一租户。取数优先 `private`——`repo` 是 `public_repo` 的超集；某一档被上游判 401 只删那一档、退另一档，两档都不可用才删租户。实际授予的 scope 只有一个真值来源：GitHub 响应头 `X-OAuth-Scopes`。回调时经 `/user` 取一次，之后每次 `/api/items` 取数顺路重读并落库。应有 scope 按档写在服务端（`EXPECTED_SCOPES`），`missingScopes` 算差集且认 `repo` 满足公开档。`/api/items` 回 `auth: { grants: { [tier]: { scopes, missing } }, used, expected }`。provider 契约的 `scopeDescriptor` 返回 `{ range, auth }`，其中 `auth` 是 `tiered`（带各档标签）或 `uniform`（带一行说明）；界面只按 `kind` 渲染，不认平台名。

**原因**：官方文档 *Creating multiple tokens for OAuth apps* 明确支持同一 OAuth app 持有多枚 token，两档两次授权正是这个形态。只想要公开仓库的人不必交出私有仓库的读权——单 token 升到 `repo` 就把这份窄授权抹掉了，也没法分别撤销。显示「我以为它有的」会撒谎：授权页允许把 scope 改小，用户也可以事后编辑授权；只有当前响应头是当下真值，所以每次取数都用它覆盖库里的旧值。`missing` 在服务端算而不是界面算：`repo ⊇ public_repo` 这条口径只该有一处，放界面会和别处的判断分叉。粒度差异是平台事实，塞进 `descriptor` 才能让 Gitee / Jira / 飞书的卡片不出现这个开关，界面也就没有散落的 `if`。

**被放弃的选项**：单 token 授权一次 `repo`、界面假装有两档（窄授权不存在，也无法分别撤销）；前端拼 scope 字符串（面板不该知道授权策略，也不该碰凭据参数）；只显示回调那一刻的授予（用户改小之后看不见，正是 AC#3 要抓的静默少显示）；`missing` 在界面按 `EXPECTED` 现算（两份口径）；界面按 `providerId === "github"` 分支（AC 明确禁止，且每接一家平台都要再改一遍界面）；取消私有档授权时连带删公开档（两档互不覆盖是这张票的前提）。

**已知缺口，刻意留着**：刷新只覆盖本轮取数用到的那一档——私有档可用时不会用公开档，所以公开档被改小要等它真正被用到才可见（多打一次请求换边缘可见性不值得）。`X-OAuth-Scopes` 缺失时按空数组处理，界面写「GitHub 未报告 scope」，不猜。授权时用户在授权页取消勾选、回调照样成功、scope 变小：界面靠 `missing` 指出，不阻止连接。Gitee / Jira 的真实接入不在本票，`uniform` 只兑现「不出现该开关、改为一行说明」。GitHub 应用授权页的直链需要 `client_id`，面板手里没有，文案只写到「到 GitHub 已授权应用页调小 scope」，不给链接。
