# 领域文档

Engineering skills 探索 codebase 时，应如何消费这个 repo 的 domain documentation。

本 repo 是 **single-context**：一个 `GLOSSARY.md` + 一个 `docs/adr/`。

## 探索前先读取这些

- repo 根目录的 **`GLOSSARY.md`**
- **`docs/adr/`**：读取与你即将处理区域相关的 ADRs

另外，本 repo 在写代码之前已经有一份完整的决策共识 **`DECISIONS.md`**（六段结论 + Q1–Q48 决策台账 + 两周排期与 kill 时点 + 一手事实出处）。它不是领域词汇表，而是**任何 spec、ticket、实现决策的 upstream**：与 `DECISIONS.md` 冲突的做法要么先改它、要么在 ADR 里显式记录为什么偏离。`§4 被推翻或修订过的前提` 一节记录了已经死掉的假设，不要回潮。

如果 `GLOSSARY.md` 或 `docs/adr/` 不存在，**静默继续**。不要标记缺失；不要提前建议创建。`/domain-modeling` skill（经由 `/grill-with-docs` 和 `/improve-codebase-architecture` 调用）会在 terms 或 decisions 实际被解决时懒创建它们。

## 文件结构

```
/
├── DECISIONS.md                        ← 决策共识（upstream）
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── 0001-issue-provider-contract.md
│   │   └── 0002-backend-on-own-server.md
│   └── agents/
└── research/                           ← 一手调研笔记（带出处）
```

## 使用 glossary 的词汇

当你的输出命名某个 domain concept 时（issue title、refactor proposal、hypothesis、test name），使用 `GLOSSARY.md` 中定义的 term。不要漂移到 glossary 明确避免的 synonyms。

如果你需要的概念还不在 glossary 中，这是一个信号：要么你正在发明项目没有使用的语言（重新考虑），要么确实存在缺口（为 `/domain-modeling` 记录）。

## 标记 ADR 冲突

如果你的输出与现有 ADR 矛盾，明确指出，而不是静默覆盖：

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
