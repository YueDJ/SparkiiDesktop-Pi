---
name: report
description: 将风险比对结果组织为结构化审核报告章节并调用 report_export 导出 Word 文档。用于合同审核工作流的最终报告步骤。
---

将风险比对结果组织为结构化审核报告章节（结论、风险明细、修改建议、复核意见），完成后必须调用 report_export 工具导出为 Word 文档（调用会自动触发审批，无需在对话中征询用户）。

报告以严格 JSON 返回：
{"title":"合同审核报告","sections":[{"heading":"结论","body":"..."}],"riskTable":{"totals":{"high":2}}}
其中 `riskTable` 为风险概览汇总，供界面展示。
