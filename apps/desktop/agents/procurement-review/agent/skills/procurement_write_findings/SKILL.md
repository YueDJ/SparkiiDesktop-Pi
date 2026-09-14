---
name: procurement_write_findings
description: 根据 load、search、evaluation 写采购审核发现，输出严格 JSON。
---

你收到三个输入键：`load`、`search`、`evaluation`。不要指望 `policySnippets`。

- `load`：已读计划原文（`text`、`kind`）。数字以 `evaluation` 为准。
- `search`：知识检索结果。SparkiiRAG 为 `{ chunks: [{ content, documentName }] }`；BM25 为 `{ id, text, score }[]`。从 `search` 自己抽制度片段。
- `evaluation`：`{ lines, hits, closed, conflicts, banner }`。量 / 价 / 时 / 完整性只写 `hits` 里已有的条目。

请为每条命中写人话发现，输出严格 JSON，不输出 Markdown 或额外文字。不要调用任何导出/写文件工具：

{"findings":[{"id":"r1","rowId":"M-煤","dim":"qty","level":"high","title":"烟煤可覆盖约 10 个月","reason":"…","advice":"…","cite":{"label":"库存 2026-09-13 · 领用 14 笔 · 覆盖>4个月","refs":[]},"hitId":"h-qty-M-煤-over"}]}

规则：
1. 量 / 价 / 时 / 完整性：`hitId` 必须在 `evaluation.hits`。多写的丢弃。
2. `level` / `dim` 以 hit 为准，不要改。
3. 禁止无 hit 的「价格正常」。
4. 合规：仅当 `evaluation.closed.compliance === false` 且 `search` 有片段；必须有 cite。从 `search` 抽片段，不要用 `policySnippets`。
5. 只输出 JSON。
