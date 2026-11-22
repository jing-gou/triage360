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
npm test         # 两个 seam 的用例
```

## 接上真实的 GitHub 会话

面板默认跑字面量样例。要换成你自己派到的 issue，需要先起后端（`server/`），它保管 OAuth token，浏览器只拿到一个不透明会话号。

1. `cp .env.example .env`，填 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`，并把 `APP_BASE_URL`、`FRONTEND_URL` 改成实际地址。GitHub OAuth App 的回调地址填 `<APP_BASE_URL>/cb/github`。要连 Gitee 就连同 `GITEE_CLIENT_ID` / `GITEE_CLIENT_SECRET` 一起填，应用回调地址填 `<APP_BASE_URL>/cb/gitee`；只填一半服务端会拒绝启动。卡片上的「为什么」要模型措辞时再填 `DEEPSEEK_API_KEY`；留空这一条照常可用，只是回落到规则理由。
   - 2026-08-03 之前建的 OAuth App，回调地址的通配匹配默认是开着的。#11 要求关掉，去 App 设置里取消。
2. `npm run build:server && npm start`。`GET /health` 返回 `{"ok":true,"gitee":…,"demo":…}` 只说明进程活着与哪几条链路配好了；回调能不能用要看 `/auth/github`（或 `/auth/gitee`）有没有 302 到平台授权页。
   - 会话落在 `DATA_DIR`（默认 `.data/`，已在 `.gitignore`）：`store.json` 是加密后的租户记录，`store.key` 是密钥，首次启动自动生成。两份都别进版本库，也别拷给别人；删目录等于全员重新授权。
   - 配了 `DEMO_LOGIN` 时，服务端按这个登录名找回演示租户，每 `DEMO_REFRESH_MINUTES`（默认 15）分钟取一次数并写 `demo.json`；`GET /api/demo/items` 公开只读，首次访客不需要授权。`POST /api/demo/reset`（Bearer = `DEMO_RESET_TOKEN`）立刻重取一次。
3. 面板构建时带上后端地址：`VITE_API_BASE_URL=https://api.example.com npm run build`。没有这个变量，面板不出现「连接」，也不发任何跨源请求；有它但访客还没授权时，面板先展示服务端那份演示快照，取不到才退回样例。

上线到自有服务器的步骤见下一节。

## 部署到自有服务器

线上是「一个 systemd 进程 + 一份 nginx 反代」，进程只听回环口，TLS 归反代（#39 的 AC#2）：

1. 服务器上放 `/etc/triage360/deploy.env`（`chmod 600`，root 可读）：`APP_BASE_URL`、`FRONTEND_URL`、`GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`，可选 `HOST` / `PORT`（默认 `127.0.0.1:8787`）、`DATA_DIR`（默认 `/var/lib/triage360`，归服务账号所有、700）、`DEEPSEEK_API_KEY`（不给就回落规则理由）、`GITEE_CLIENT_ID` / `GITEE_CLIENT_SECRET`（成对）与 `DEMO_LOGIN` / `DEMO_REFRESH_MINUTES` / `DEMO_RESET_TOKEN`。
2. root 执行 `scripts/deploy.sh`。它依次做：建系统用户、`/srv/triage360` 与数据目录 → 把检出刷到 `origin/main` → `npm ci` + `build:server` → 由 deploy.env 生成 `.env`（root 600；Gitee / 演示 / DeepSeek 有值才多写对应行）→ 写 systemd unit 并重启 → 首次建 vhost、certbot 补证书 → 断言只监听回环口且 `https://<域名>/health` 返回 200。
3. 重复执行就是重新部署：代码、`.env`、unit 都是「内容变了才写」，vhost 建过就不再覆盖（443 那段归 certbot 维护）。

排障入口：`journalctl -u triage360 -n 50`。启动行打印监听地址与回调基地址；回调只记结果（rejected / session created），不记 state、code 与身份；措辞通道记 `[reason] ok in Nms` 与失败类型，不记卡片内容。
