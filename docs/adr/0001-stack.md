# ADR-0001 · 栈：TypeScript 单包 + Vite/React 界面 + Vitest

**决策**：全仓一种语言 TypeScript（Node ≥ 22.12）。界面用 Vite + React，测试运行器用 Vitest。`src/core` 不 import 任何框架，后续自有服务器后端直接 import 同一批模块。后端 Web 框架到 T09（第一个需要 OAuth 回调的 ticket）再定。

**原因**：provider 七法契约与 `Task` 形状要在界面和后端之间共用，跨语言会把这个契约抄两遍；Vite 与 Vitest 共用同一套 ESM/TSX 解析，seam 1 的用例不需要浏览器就能跑完。

**被放弃的选项**：Next.js（后端在自有服务器，Sites 只承载静态界面，用不到 SSR）；pnpm workspaces 双包（两周工期里多一层构建配置，等后端落地再拆）；Jest（与 Vite 的解析规则要额外配 transform）。
