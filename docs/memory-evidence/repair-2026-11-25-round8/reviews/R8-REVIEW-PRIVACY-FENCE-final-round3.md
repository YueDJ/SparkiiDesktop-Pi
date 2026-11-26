# R8-REVIEW-PRIVACY-FENCE 独立架构审查报告

- 审查日期：2026-11-25
- 审查域：R8-REVIEW-PRIVACY-FENCE
- 仓库：`C:/Users/YDJ/Desktop/SparkiiDesktop-Pi`
- 冻结清单：`docs/memory-evidence/repair-2026-11-25-round8/source-sha256.txt`
- 清单 SHA-256：`5a8e91cbbeb23670de30edcfdfb22c36b8dc314112c80d3bb51916553c5cd313`
- 逐项核对：66/66 OK
- 审查方式：独立只读静态读取实现、调用链和回归；未依赖交付方摘要；未修改文件，未运行测试或构建。

## 结论

CHANGES_REQUIRED

Blocking finding count: 4

## B1：Chat 脱敏先于 Pi 原始路径读取

位置：`service.ts:996-1029`、启动恢复 `:149-169`、`runtime.ts:216-227`、`chat-session-store.ts:118-133,169-171`。

privacyDeleteBySession 先登记 Chat 脱敏，再通过 `sessionFileOf()` 取 Pi 路径；生产依赖使用 `chatSessions.get()`，其 `safeRecord()` 会脱敏 `piSessionFile`。secret 命中路径子串时会 rm 错误路径，原 Pi JSONL 永久遗留，甚至可能误删脱敏路径指向的其他文件。启动恢复同样如此。最小修复：提供不脱敏的原始 Pi 路径专用读取；登记前捕获，并覆盖重试/重启；清 journal 前确认原路径不存在；增加 secret 命中路径的正常/重试/重启回归。

## B2：Audit/Gate 未登记物理换行 fragment

位置：`packages/approval/src/audit.ts:265-270`、`gate.ts:159-168`；对照 `privacy-redactions.ts:118-131`。

`PrivacyRedactions` 为 `alpha\nbeta` 额外登记 alpha/beta fragment；Audit/Gate 只登记完整 raw/JSON-escaped 值。历史或未来 carrier 只含 fragment 时不会脱敏，Gate proposal 也不会失效。最小修复：共享 variant 生成，Audit/Gate 与 PrivacyRedactions 一致；Gate 历史和未来 ingress 使用同一集合；增加历史、未来、重启和原始 DB/WAL 回归。

## B3：同进程 truth write-block 后重试不清理 Pi/Chat

位置：`service.ts:958-967,1020-1037`、`store.ts:359-365`、`truth-batch.ts:524-534`。

truth 提交/回滚失败产生 block 后，同进程重试仍先 preflight；`assertAvailable()` 即使 privacy cleanup 中也检查 truth block，因而在 Pi/Chat 清理前抛错。重启特例可清理，但当前进程不能。最小修复：已有 pending journal 且 truth blocked 时，在 preflight 前幂等清理独立 carrier，保留 journal，不放宽 truth fence；增加同进程回滚失败后重试回归。

## B4：privacy journal 临时文件永久明文残留

位置：`service.ts:882-903,913-935,939-955`。

rename 前崩溃留下含明文 journal 的 `.tmp`；启动只扫描 `.json`，之后成功删除也不清理旧 tmp。最小修复：识别本模块 tmp 命名，校验普通文件、非 symlink、nlink=1 后清零删除或纳入验证恢复；异常 fail closed；增加 tmp 崩溃残留回归。

## 已确认符合要求

- registry 仅持久 SHA-256/字符集合，tombstone 严格校验，缺失/dangling/多硬链接 fail closed。
- journal 普通文件、非 symlink、nlink=1、dev:ino:size:mtimeNs 身份校验；清零后删除。
- collision-safe marker 避让全部登记字符/模式并输出复查。
- Logger 保持 CRLF/CR/LF 记录边界、escape、malformed history 和跨记录重建检测。
- 启动先隐私 sink 围栏、再 truth recovery、最后隐私续删。
- preflight 失败不提前修改 truth/journal/carrier。
- Pi pool immutable lease/generation/CAS；privacy teardown 不清理替代 binding。
- `.sparkii` truth reparse/hardlink fence 和白名单存在。
- Chat/Error/Logger/Audit 回归覆盖未来写入、重启和原始 DB/WAL/log 字节，但上述条件未覆盖。

## 非阻塞建议

1. Logger 动态对象键未脱敏；当前生产主要固定 schema 键，建议对非 schema key 做检测。
2. Logger `.redact.tmp` 固定路径未检查 symlink/nlink，建议随机 wx 临时文件。

## 验证范围与限制

已核对清单自身及 66 项源码哈希。未运行构建、类型检查、测试或故障注入；未实机验证 Windows junction、崩溃时序、SQLite 原始字节或 Pi 子进程退出。工作树未提交修改，清单匹配不等于 HEAD 匹配。未修改任何文件或执行 git 写操作。
