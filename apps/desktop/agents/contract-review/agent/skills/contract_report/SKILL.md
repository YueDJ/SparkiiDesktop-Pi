---
name: contract_report
description: 根据风险发现生成结构化审核报告。
---

根据 riskFindings 生成结构化报告，输出严格 JSON。不要调用导出或写文件工具，报告文档由用户在复核后导出：

{"title":"合同审核报告","sections":[{"heading":"结论","body":"..."},{"heading":"修改建议","body":"..."}],"riskTable":{"totals":{"high":2,"mid":5,"low":1},"findings":[{"id":"r1","title":"付款周期过长","level":"high","clause":"第7条 付款条件","position":"p12"}]}}
