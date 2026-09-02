# Contract Review V2 — Single-Page Workbench Design

**Status:** Approved for implementation planning
**Date:** 2026-09-02
**Mockup:** `docs/superpowers/mocks/contract-review-v1.html`

## Goal

把合同审核从“5 个后端步骤、每步一页”收敛为“2 个业务步骤 + 1 个人工复核终态”，并改成单页工作台：左侧合同原文、右侧风险发现与报告，顶部固定阶段状态。

## Confirmed Decisions

1. 用户可见 workflow 只有两个步骤：`review` 与 `report`。
2. 文档解析与法规检索保留为隐藏 tool 步骤，不进入用户可见流程。
3. `contract_risk_review` skill 负责条款抽取 + 风险比对，输出结构化 `RiskFinding[]`。
4. `contract_report` skill 负责生成结构化报告。
5. 顶部固定：文件标题、智能体名、模型选择、工作区、上下文、阶段条。
6. 主区可滚动：左侧合同原文，右侧风险发现与报告。
7. 左侧原文与右侧风险面板均可收起，给另一侧更多空间。
8. 风险操作语义：
   - `confirmed` / `ignored` / `escalated` 互斥
   - `comment` 独立，可与其他状态同时存在
   - 再次点击同一状态可撤销
9. 复核结论通过 `workflow_state` 持久化，`合并到报告` 后固化到报告；导出走审批门。
10. 顶部 `复核` 节点承担复核状态提示：
    - 有未处理风险：黄色
    - 已全部处理但未合并：蓝色
    - 已合并到报告：绿色
11. 不新增 popup/toast。报警以纯文本形式展示在模型按钮附近，正常时隐藏。
12. 标题来自上传文件名，不写死。

## Skill Contracts

### `contract_risk_review`

输入：

```json
{
  "document": {
    "text": "...",
    "kind": "pdf",
    "meta": { "fileName": "...", "pageCount": 12 }
  },
  "hits": [
    { "id": "rule-1", "source": "合同法", "text": "...", "score": 0.82 }
  ]
}
```

输出：

```json
{
  "summary": { "clauseCategories": 8, "ruleHits": 12, "high": 2, "mid": 5, "low": 1 },
  "riskFindings": [
    {
      "id": "r1",
      "title": "付款周期过长",
      "level": "high",
      "clause": "第7条 付款条件",
      "position": "p12",
      "ruleId": "rg-01",
      "ruleText": "账期≤30天",
      "reason": "账期超过基准",
      "advice": "约定逾期违约金"
    }
  ],
  "evidence": [
    { "id": "e1", "kind": "clause", "label": "付款条款", "text": "..." }
  ]
}
```

### `contract_report`

输入：

```json
{ "riskFindings": [] }
```

输出：

```json
{
  "title": "合同审核报告",
  "sections": [
    { "heading": "结论", "body": "..." },
    { "heading": "风险明细", "body": "..." },
    { "heading": "修改建议", "body": "..." }
  ],
  "riskTable": { "totals": { "high": 2, "mid": 5, "low": 1 } }
}
```

## UI States

- 空态：居中上传卡，阶段条全部待处理。
- 审核中：`审核` active，右侧骨架态。
- 报告生成中：风险发现已出现，报告加载态。
- 复核：风险发现可操作，报告预览可见。
- 失败：失败步骤高亮，保留已完成结果。
- 历史回放：只读，阶段条与复核状态从 JSONL 恢复。

## Boundaries

- `src/surface/**` 不 import `agents/**`。
- `agent-surface-bindings.ts` 仍是唯一 import agents 的生成物。
- Agent surface 只通过 `AgentSurfaceProps` 与 `@sparkii/ui` 交互。
- 平台层不出现 `agentId === 'contract-review'` 组件级特判。
