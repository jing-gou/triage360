# triage360

60 秒知道今天做什么：把 GitHub / Gitee / Jira / 飞书 上派给你的任务收敛成一张今日清单。

- 决策共识：[DECISIONS.md](DECISIONS.md)
- PRD：[docs/PRD.md](docs/PRD.md)（同步为 issue #1）
- 术语：[GLOSSARY.md](GLOSSARY.md) · 架构决策：[docs/adr/](docs/adr/)
- 调研笔记：[research/](research/)

开发中，仓库先行公开以保留过程记录。

## 本地跑起来

```bash
npm install
npm run dev      # 面板：http://localhost:5173
npm test         # seam 1 的用例
```

## 接上真实的 GitHub 会话

面板默认跑字面量样例。要换成你自己派到的 issue，需要先起后端（`server/`），它保管 OAuth token，浏览器只拿到一个不透明会话号。

1. `cp .env.example .env`，填 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`，并把 `APP_BASE_URL`、`FRONTEND_URL` 改成实际地址。GitHub OAuth App 的回调地址填 `<APP_BASE_URL>/cb/github`。
   - 2026-08-03 之前建的 OAuth App，回调地址的通配匹配默认是开着的。#11 要求关掉，去 App 设置里取消。
2. `npm run build:server && npm start`。`GET /health` 返回 `{"ok":true}` 只说明进程活着；回调能不能用要看 `/auth/github` 有没有 302 到 GitHub。
3. 面板构建时带上后端地址：`VITE_API_BASE_URL=https://api.example.com npm run build`。没有这个变量，面板不出现「连接 GitHub」，也不发任何跨源请求。

上线到自有服务器的步骤见 issue #39。
