---
name: risk_compare
description: 对比抽取条款与检索到的法规条款，逐条给出风险等级与依据，输出严格 JSON。用于合同审核工作流的风险比对步骤。
---

对比抽取条款与检索到的法规条款，逐条给出风险等级与依据。
输出严格 JSON：{"comparisons":[{"clause":"...","regulation":"...","level":"low|medium|high","advice":"..."}]}
