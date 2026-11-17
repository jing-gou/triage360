# ADR-0010 · 面板拿 fragment 交付的会话标识访问后端，不用 cookie

**决策**：`/cb/github` 换到 token 后，服务端建一条会话（`Map<会话标识, {token, login}>`），302 到 `FRONTEND_URL/#session=<标识>`。面板把这个标识读一次、写进 `sessionStorage`，随即 `history.replaceState` 抹掉 fragment；之后每次取数带 `Authorization: Bearer <标识>`。GitHub 的 token 只在服务端内存里，永不下发前端。

**原因**：面板托管在 Qoder Sites、后端在自有域名（`DECISIONS.md:41`），两边是跨站。跨站 cookie 在现代浏览器里默认被拦（Safari 的全量拦截、Chrome 的第三方 cookie 限制），cookie 方案会在部分访客那里静默失效——表现是「授权走完了，面板还是样例」，且无法从界面上分辨。fragment 不进 `Referer`、不进服务端访问日志、也不留在浏览器历史里（读完即抹）；`Authorization` 头只需在 CORS 预检里放行它一个，服务端 `Access-Control-Allow-Origin` 固定为面板源。会话标识是随机的 32 字节，与 token 无任何可推导关系。

**被放弃的选项**：`SameSite=None` 的 cookie（跨站默认被拦，且要把会话绑到「浏览器带不带 cookie」这种没有 UI 的状态上）；把 GitHub token 直接放 `localStorage`（XSS 一次就拿到长期凭据，服务端也没法撤销）；把会话标识放 query（进 `Referer` 与反代/访问日志，正是 fragment 要避开的两处）；签名 cookie 里直接装 token（等于把凭据交给浏览器）。

**已知缺口，刻意留着**：`state` 存在服务端一张表里，没有绑到某个浏览器（没有 cookie 可绑）。登录 CSRF 的后果是把**攻击者自己的**任务页塞给受害者看，碰不到受害者的任何数据；这是单租户个人面板，接受。另外会话只在进程内存里：重启等于全员重新授权，持久化、加密与删除义务在 #13，那时这张表才会换成一个会落盘的东西。
