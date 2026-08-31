# 离线部署说明（Windows）

SparkiiDesktop-Pi 面向可私有化部署场景：应用本体、Pi Agent 运行时、本地模型运行时（Ollama）与模型权重均可在无外网的 Windows 主机上安装运行。

## 离线安装包构成

一个完整的离线包包含三部分：

1. **应用安装包**：electron-builder 产出的 Windows NSIS（`.exe`）与 MSIX（`.appx`）安装包。
   - NSIS：`oneClick: false`，支持自定义安装目录，适合内网手工安装。
   - MSIX/AppX：对接 Intune/SCCM 等企业分发；正式对外分发需企业签名。
2. **Pi 运行时**：`pi` 可执行文件（`--mode rpc`，JSONL over stdio）随应用内置分发；应用通过 `PI_BIN`/`PiProcessSupervisor` 配置定位，无外网依赖。
3. **本地模型运行时（可选）**：Ollama 安装包离线分发，内置到离线包中供用户一并安装。

## 模型权重（按需另发）

- 默认模型路由（见 `profiles/contract-review/manifest.yaml`）：`qwen2.5:7b`，报告任务可降级到 `qwen2.5:7b`。
- 模型权重不随应用包分发，按需另发：在联网机器执行 `ollama pull qwen2.5:7b`，将 `ollama` 模型目录（Windows 默认 `%USERPROFILE%\.ollama\models`）复制到目标主机对应目录，或使用 `ollama` 的离线导入方式。
- 目标主机安装 Ollama 后启动服务（默认 `http://localhost:11434`），应用经 OpenAI 兼容端点访问本地模型，无需出网。

## 配置包（profile）侧载与签名

- 开发模式允许 `allowUnsigned: true` 加载未签名 profile（当前默认）。
- 生产分发建议对 profile 做 Ed25519 签名：加载前校验 `manifest.integrity.sha256` 与签名（`packages/config` 的 `computeIntegrity`/`verifyFiles`），验签失败拒绝加载。
- 更新 profile 时通过应用内签名更新或侧载新版本目录，加载失败回退到上一个已知可用版本。

## 数据目录与用户隔离

- 默认数据目录为 `%LOCALAPPDATA%\SparkiiDesktop\data`（由 `apps/desktop/electron/main/paths.ts` 的 `defaultDataDir()` 解析）；需要时可用 `SPARKII_DATA_DIR` 显式覆盖，仅用于开发、CI、便携或企业指定目录，正常启动不应指向 `%TEMP%`。
- 数据暂按当前 Windows 用户平铺存放；`dataDirFor(userId)` 仅作为未来应用内多用户隔离的预留接口，尚未启用。
- 审计日志使用 SQLite WAL（`audit.db`）落盘并支持导出 JSONL；结构化运行日志写入 `<dataDir>/logs/sparkii.log.jsonl`。
- 敏感数据加密落盘（密钥经 Electron `safeStorage` 加密，Windows 使用 DPAPI/凭据管理器），明文密钥不落盘、不暴露给 Renderer。

## 安装步骤（离线）

1. 安装应用（NSIS 双击安装，或经 Intune/SCCM 推送 MSIX）。
2. 确认 Pi 运行时已随应用放置并可执行。
3. 如需本地模型：安装 Ollama，导入/拷贝模型权重，启动 `ollama serve`。
4. 首次启动使用 `admin` / 初始化密码登录（本地账号，MVP 内置 seed）。
5. 加载 profile（`profiles/contract-review`），上传合同 → 跑流程 → 人工复核 → 导出报告。
