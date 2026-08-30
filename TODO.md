# TODO

## 数据存储位置（后续处理）

- 背景：应用数据目录由 `SPARKII_DATA_DIR` 环境变量或 `<userData>/data` 决定，
  见 `apps/desktop/electron/main/index.ts`。
- 现状：早期使用中数据曾写入 `%TEMP%\sparkii-dev-data`，换启动方式后模型配置与
  对话记录表现为「丢失」（数据仍在 Temp，但应用不再读取）。
- 待办：
  - 固定并文档化默认数据目录（默认走 `userData/data`，即 `AppData\Roaming\Sparkii\data`）。
  - 明确 `SPARKII_DATA_DIR` 的用途约定，避免再指向临时目录。
  - 如需，提供一次性迁移：把 `%TEMP%\sparkii-dev-data` 迁到正式目录。
  - 避免把持久化数据放到 `%TEMP%`（会被系统 / 清理工具回收）。
