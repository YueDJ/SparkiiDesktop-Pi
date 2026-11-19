---
name: diagram
description: 为标书技术方案生成 draw.io 技术图（架构/拓扑/流程/时序）。只输出结构化图 JSON，不输出 XML、SVG、像素坐标或图片。由确定性转换器生成 .drawio 与渲染图。
---

为技术方案生成一张技术图。只输出严格 JSON（不输出 Markdown、注释或额外文字）：

{
  "type": "architecture",
  "title": "系统总体架构",
  "layout": "TB",
  "nodes": [
    { "id": "app", "label": "应用层", "group": "应用层", "items": ["运维门户", "移动应用"], "icon": "app" },
    { "id": "plat", "label": "平台层", "group": "平台层", "items": ["数据汇聚", "服务网关"], "icon": "server" }
  ],
  "edges": [{ "from": "plat", "to": "app", "label": "提供服务" }],
  "style": { "palette": "blue", "language": "zh-CN" }
}

规则：
- type 取 architecture / topology / flowchart / sequence；layout 取 TB 或 LR；
- 不要给像素坐标，节点位置由布局器统一排布；group 相同的节点归为同一分层；
- 中文标签必须准确、精炼；icon 取 draw.io 技术图形库语义名；
- 这是技术结构图，不是文生图；不要输出任何图片或图像描述。
