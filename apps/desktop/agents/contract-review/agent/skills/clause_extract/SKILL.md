---
name: clause_extract
description: 从给定合同文本中抽取关键条款（标的、金额、付款、违约责任、争议解决、保密、验收），输出严格 JSON。用于合同审核工作流的条款抽取步骤。
---

从给定合同文本中抽取关键条款（标的、金额、付款、违约责任、争议解决、保密、验收）。
输出严格 JSON（不输出 Markdown 或额外文字）：
{"clauses":{"groups":[{"category":"付款","clauses":[{"text":"第7条 约定账期30天","position":"p12"}]}]}}
其中 `category` 取：标的/金额/付款/违约/责任/终止/保密/验收 等；`position` 为条款在原文中的位置标识。
