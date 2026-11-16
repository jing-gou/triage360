# GLOSSARY

产品与代码共用这套词。命名冲突时以本文件为准，改名字比留下两个词便宜。

- **今日清单（Today List）** — 一次构建得到的有序任务集合，带生成时间。seam 1 的输出。
- **任务卡（Card）** — 今日清单里一条任务在界面上的呈现。
- **构建器（`buildTodayList`）** — seam 1。输入只有 providers、注入的取数通道、注入的时钟、范围；除此之外没有第二种信息来源。
- **provider** — 一个平台的适配器，实现七法契约：`search` / `getByIds` / `normalize` / `doneStates` / `deletedStates` / `pollIntervalMs` / `scopeDescriptor`。
- **假 provider** — 按真实平台形状构造请求并解析响应、数据来自字面量的 provider。T09 起被真实接入顶替，接口不变。
- **范围（Scope）** — 清单查什么。v1 只有「派给谁」。
- **取数通道（`Http`）** — 注入给 provider 的请求函数。错误信息只暴露 URL 路径，query 可能带凭据。
- **任务（Task）** — `normalize` 的输出，跨平台共用的最小形状。定稿在 T03。
