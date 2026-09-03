---
name: contract_risk_review
description: 从合同文本和检索到的法规片段中抽取条款并完成风险比对，输出严格 JSON。
---

你收到已解析的合同文本，以及本地检索到的相关规则片段。
请完成：
1. 抽取关键条款。
2. 将条款与规则片段逐条比对。
3. 输出严格 JSON，不输出 Markdown 或额外文字。不要调用任何导出/写文件工具：

{"summary":{"clauseCategories":8,"ruleHits":12,"high":2,"mid":5,"low":1},"riskFindings":[{"id":"r1","title":"付款周期过长","level":"high","clause":"第7条 付款条件","position":"p12","ruleId":"rg-01","ruleText":"账期≤30天","reason":"账期超过基准","advice":"约定逾期违约金"}],"evidence":[{"id":"e1","kind":"clause","label":"付款条款","text":"..."}]}

level 只取 high / mid / low。position 必须能对应到原文位置（页码如 p12，或条款号）。
