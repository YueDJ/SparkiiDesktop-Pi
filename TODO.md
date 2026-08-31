# TODO

## 数据存储位置（已确定）

- 默认数据目录：`%LOCALAPPDATA%\SparkiiDesktop\data`，由 `apps/desktop/electron/main/paths.ts`
  的 `defaultDataDir()` 解析（不再使用 `userData/data` 的 Roaming 路径）。
- 目录名采用 `SparkiiDesktop` 以避免与本地另一个名为 `Sparkii` 的应用数据目录冲突。
- `SPARKII_DATA_DIR` 仅作显式覆盖，用于开发 / CI / 便携 / 企业指定目录；
  持久化数据不得指向 `%TEMP%`。
- 不做 `%TEMP%\sparkii-dev-data` 迁移：开发环境与生产环境本就应隔离，各自独立。
- 数据暂按当前 Windows 用户平铺，`dataDirFor(userId)` 作为未来多用户隔离的预留接口。
