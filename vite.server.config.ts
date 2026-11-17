import { defineConfig } from "vite";

/**
 * 服务端的构建入口单独一份：产物是单个 ESM 文件，node 内建模块留在外部。
 * 与面板的 `vite build` 分开跑，两边的产物（`dist/` 与 `dist-server/`）互不覆盖。
 */
export default defineConfig({
  build: {
    ssr: "server/index.ts",
    outDir: "dist-server",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: {
      output: { entryFileNames: "index.js" },
    },
  },
});
