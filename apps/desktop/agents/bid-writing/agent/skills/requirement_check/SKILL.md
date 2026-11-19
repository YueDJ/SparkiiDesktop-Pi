---
name: requirement_check
description: 核对标书正文是否覆盖甲方招标文件的全部要求点，输出覆盖矩阵（要求点/对应章节/是否覆盖/证据）。用于提交前自检。
---

对照甲方招标文件的每条要求，核对标书正文是否覆盖，输出严格 JSON：
{"checks":[{"requirement":"投标人须具备XX资质","chapter":"5","covered":true,"evidence":"资质证明第2段"},{"requirement":"...","chapter":null,"covered":false,"evidence":""}]}

规则：
- 每条要求必须给出证据片段（来自正文或资料），不得凭空判断 covered=true；
- 未覆盖的要求单列，方便补写；
- 不修改正文，只输出核对结果。
