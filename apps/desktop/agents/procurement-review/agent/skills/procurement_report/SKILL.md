---
name: procurement_report
description: 根据 review 发现生成结构化采购审核报告草稿。
---

输入只有 `review`（上一步 `procurement_write_findings` 的 JSON 文本或已解析对象）。不要等待或写入人的采纳状态；线性引擎在复核之前就会跑完这一步。

根据 `review.findings` 生成结构化报告草稿，输出严格 JSON。不要调用导出或写文件工具，报告文档由用户在复核后导出：

{"title":"财务采购审核报告","sections":[{"heading":"结论","body":"..."},{"heading":"修改建议","body":"..."}],"findings":[{"id":"r1","title":"烟煤可覆盖约 10 个月","level":"high","dim":"qty"}]}
