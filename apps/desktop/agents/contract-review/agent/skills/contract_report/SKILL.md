---
name: contract_report
description: 根据风险发现生成结构化审核报告。
---

根据 riskFindings 生成结构化报告，输出严格 JSON：

{"title":"合同审核报告","sections":[{"heading":"结论","body":"..."},{"heading":"风险明细","body":"..."},{"heading":"修改建议","body":"..."}],"riskTable":{"totals":{"high":2,"mid":5,"low":1}}}
