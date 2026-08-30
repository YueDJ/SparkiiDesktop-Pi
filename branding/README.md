# Sparkii — Brand Icon

简洁、大方的「火花」图标：圆角方形底 + 蓝色渐变 + 主火花与右上小火花（呼应「Sparkii」的双火花）。可用于桌面应用图标与网站 / Web App 图标。

## 设计说明

- 品牌色沿用 DESIGN.md 的主色 `#2563EB`，从天空蓝 `#4C8DFF` 渐变到深蓝 `#1E40AF`，顶部加一层柔和高光，贴合「现代亲和」的设计语言。
- 圆角 `116/512 ≈ 22.7%`，与产品的「大圆角」基调一致；图形在 16px 仍清晰可辨。
- 主火花为四角星（twinkle），右上小火花呼应名称里的双火花，传达「智能 + 可控」的能量感。

## 文件

| 文件 | 用途 |
| --- | --- |
| `sparkii-icon.svg` | 矢量源文件（圆角底 + 火花） |
| `sparkii-mark.svg` | 透明底火花标记（网站内联 / favicon） |
| `sparkii-icon-{size}.png` | 各尺寸 PNG（16–1024） |
| `sparkii.ico` | Windows 图标（含 16–256px） |
| `generate-icons.cjs` | 从 SVG 重新生成所有位图资源 |

## 重新生成

```bash
NODE_PATH=<node_modules 目录> node branding/generate-icons.cjs
```
