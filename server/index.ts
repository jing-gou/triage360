import { createServer } from "node:http";
import { createHandler } from "./api";
import { loadConfig } from "./config";
import { EncryptedStore } from "./store";

const config = loadConfig(process.env);
const store = new EncryptedStore(config.dataDir, () => Date.now());
// 启动先扫一遍，之后每小时再扫：30 天清除不能只靠「有人来访问」触发——没流量的租户照样要到期消失。
function sweep(): void {
  const removed = store.prune(Date.now());
  if (removed > 0) console.log(`[store] pruned ${removed} inactive tenant(s)`);
}
sweep();
setInterval(sweep, 60 * 60_000).unref();
const handler = createHandler({ config, store, now: () => Date.now() });

const server = createServer((req, res) => {
  handler(req, res).catch(() => {
    // 走到这里的响应可能已经写出去一半；不再二次写头，只把连接结束掉。
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end();
  });
});

server.listen(config.port, config.host, () => {
  // 启动行只报地址与回调基地址：日志里不出现令牌、不出现请求头。
  console.log(`triage360 server listening on ${config.host}:${config.port} (callback base ${config.appBaseUrl})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
