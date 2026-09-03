---
name: report
description: 将风险比对结果组织为结构化审核报告章节并调用 report_export 导出 Word 文档。用于合同审核工作流的最终报告步骤。
---

将风险比对结果组织为结构化审核报告章节（结论、修改建议、复核意见）。只输出 JSON，不要调用导出或写文件工具。

报告以严格 JSON 返回：
{"title":"合同审核报告","sections":[{"heading":"结论","body":"..."}],"riskTable":{"totals":{"high":2}}}
其中 `riskTable` 为风险概览汇总，供界面展示。
