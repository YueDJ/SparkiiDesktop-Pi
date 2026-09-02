---
name: risk_compare
description: 对比抽取条款与检索到的法规条款，逐条给出风险等级与依据，输出严格 JSON。用于合同审核工作流的风险比对步骤。
---

对比抽取条款与检索到的法规条款，逐条给出风险等级与依据。
输出严格 JSON（不输出 Markdown 或额外文字）：
{"comparisons":[{"id":"r1","clause":"第7条 付款条件","position":"p12","level":"high|mid|low","ruleId":"rg-01","ruleText":"账期≤30天","reason":"账期超过基准","advice":"约定逾期违约金"}]}

其中 `level` 仅取 `high` / `mid` / `low`；`id` 为该风险稳定标识，供复核回写。
