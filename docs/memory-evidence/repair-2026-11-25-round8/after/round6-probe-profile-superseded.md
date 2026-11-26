# round6 probe profile 证据状态

`round6-probe-profile.txt` 是生产 native probe 性能诊断期间保留的旧输出，其中一个用例因约 800 次子进程探测超过 5000 ms。该文件保留用于说明性能回归，不是最终通过证据。

最终修复没有提高 timeout、添加 skip 或 mock 掉生产安全分支，而是：

- 每次逻辑身份复核使用一次 native probe + 两次 `lstat`；
- 通过生产 API 显式注入 `TruthAttributeProbe`；
- 普通回归使用确定性 probe，保留专门的真实 `SandboxProbe.exe` 集成用例。

取代它的最终证据：

- `after/round6-truth-privacy.txt`：完整三文件串行 127 passed。
- `after/round6-privacy-fences-focused.txt`：相关聚焦 16 passed，111 个名称过滤 skip；完整三文件无 skip。
- `after/round6-typecheck.txt`：workspace typecheck 通过。

详见 `reviews/R8-FIX-round6-truth-privacy.md`。
