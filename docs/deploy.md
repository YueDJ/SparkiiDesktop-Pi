# 离线部署说明（Windows）

SparkiiDesktop-Pi 面向可私有化部署场景：应用本体、Pi Agent 运行时、本地模型运行时（Ollama）与模型权重均可在无外网的 Windows 主机上安装运行。

## 离线安装包构成

一个完整的离线包包含三部分：

1. **应用安装包**：electron-builder 产出的 Windows x64 NSIS（`.exe`）安装包。
   - 当前使用 per-user one-click 安装，不要求管理员权限。
   - 交付形态**只有 NSIS**：`apps/desktop/electron-builder.config.mjs` 的 `win.target` 为 `['nsis']`，不配置也不产出 MSIX / `.appx`。代码签名（Authenticode）不在本期范围内，安装包为未签名。
   - **自动更新在本期范围内**（L2：发现新版 → 下载 → 安装 → 重启）；MSIX 与代码签名仍不在范围内。设计见 `docs/superpowers/specs/2026-11-06-auto-update-design.md`，构建与发布操作见 `docs/release-windows.md`，服务端运维见 `docs/operations/update-service.md`。
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

## 更新源部署形态（自动更新）

- 更新源**不是一个新服务**：在现有 RAG 服务的 Web 静态目录下挂一个只读静态目录 `/sparkii-updates/`，与 RAG 服务**同一 IP 的 80 端口**共存（设计稿 D3 / D11 / §8.1），**不改动任何 RAG 业务代码**。
- 客户端**只读该目录下的静态文件，永不调用 RAG 业务 API**：RAG 升级、换端口或临时挂掉都不影响更新检查；检查不可达时客户端静默退避、当作「无更新」。
- 更新源地址是运行时可配置项 `settings.update.baseUrl`，构建期默认值由环境变量 `SPARKII_UPDATE_URL` 注入。**留空即关闭自动检查**，因此完全离线 / 无外网的部署不需要任何改动就能保持零外网请求；内网部署把地址指向内网静态目录即可。
- HTTP 与 HTTPS 都支持。**更新的完整性由清单的 Ed25519 内容签名与安装包 sha512 终检保证，不依赖 TLS、也不依赖代码签名**（无证书 ⇒ 构建配置 `win.verifyUpdateCodeSignature: false`，信任完全来自签名）。
- 检查请求**零身份信息**：只有 `GET channel.json` / `.sig` / `release.json` / `.sig` / 安装包，无 query、无自定义 header、无设备 ID、无遥测；可在「设置 → 关于」一键关闭（设计稿 §6.6 / C3）。精确口径：客户端代码不注入任何 header，但 HTTP 栈自身会带平台默认头（实测为 `user-agent: node` + `accept` / `accept-language` / `sec-fetch-mode` / `accept-encoding`），其中**不含设备、账户或会话标识**；实测记录见 `docs/superpowers/specs/2026-11-06-implementation-review.md` §1.4。
- 目录结构、缓存策略（`channel.json` 必须禁缓存、版本目录 ETag + 长缓存）、只读权限与禁止目录列表：**规范以 `docs/operations/update-service.md` 与 `apps/desktop/scripts/update-source-template/README.md` 为准**，本文不重复一份，以免出现互相矛盾的第二个来源。

示例地址一律写占位符 `http://<更新源地址>/sparkii-updates/`；**真实服务器 IP / 域名 / token 不写进仓库与文档**。

## 紧急撤回与私钥泄露预案

前提：本期更新源按设计稿 D3 / D10 以 **HTTP 静态托管**交付（协议本身不提供任何信任）。在这种形态下，**带内下发的「撤销清单」可能被中间人屏蔽，不能只靠它**（设计稿 §8.3）。因此以下主路径均需**带外**执行。

**紧急撤回某个坏版本**（未涉密钥泄露）：

1. 下线该版本：把 `channel.json` 指回上一个**合法且未过期**的版本指针，并把问题版本目录移出可访问路径；范围不可控时直接**下线整个 `/sparkii-updates/` 静态目录**（或置 503）。
2. `sequence` 全局单调、只增不减：撤回**不要**把 `sequence` 往下改。撤回后如需重新发布，必须使用一个**新的、更大的 `sequence`** 并留痕说明原因。
3. **带外通知**客户「暂时不要点升级」（邮件 / 电话 / IM / 公告）。更新源不可达时客户端会静默退避、当作「无更新」，不会误装。

**发布私钥泄露**（更高等级，必须线下执行）：

1. **立即下线更新源**——先止血，阻止攻击者用合法私钥签出「看起来可信」的新清单。
2. **带外人工通知所有客户不要点升级**。
3. 生成**新密钥对**，发布一个**全量重装**的新版本：新公钥内置进该版本客户端，旧公钥从内置列表移除；客户走手动重装，而不是在线升级。
4. 必要时签发撤销清单，但如前所述它在 HTTP 下可能被中间人屏蔽，**只能作为补充手段**。主路径始终是「下线更新源 + 带外通知 + 新公钥全量重装」。

> 操作步骤、密钥保管与 ACL、`kid` 轮换、日志与告警细节见 `docs/operations/update-service.md` §4 / §5；本文只保持口径一致的引用，不重写该手册。

## 安装步骤（离线）

1. 安装应用（NSIS 双击安装）。
2. 确认 Pi 运行时已随应用放置并可执行。
3. 如需本地模型：安装 Ollama，导入/拷贝模型权重，启动 `ollama serve`。
4. 首次启动使用 `admin` / 初始化密码登录（本地账号，MVP 内置 seed）。
5. 加载 profile（`profiles/contract-review`），上传合同 → 跑流程 → 人工复核 → 导出报告。
