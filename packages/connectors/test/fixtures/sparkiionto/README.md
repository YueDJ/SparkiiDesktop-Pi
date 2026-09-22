# SparkiiOnto 契约 fixture（实测）

来源：WSL `~/sparkiionto-deploy/evidence/`，由 `sparkiionto-wsl/03-contract-test.sh` 对
**真实运行的产品服务**（`sparkii_onto.api.server`，修订 `origin/main` = `01cbaa78`，
地址 `http://127.0.0.1:9380`）发起请求后原样落盘。

- `*.body`：响应体；`*.headers`：响应头（含原文下载的 `content-type` / `content-disposition`）。
- `retrieval-422-*.body`：三条参数负例（漏字段 / 多字段 / `page_size=21`）现场生成的 422。
- **`login.body` / `login.headers` 已刻意删除**：它们含一次性会话 token，不该进仓库。
- 这里是**测试用假服务响应**，不含任何生产凭据；id/时间戳是本地联调实例的值。

引用这些 fixture 的测试：`packages/connectors/test/sparkiionto-client.test.ts`。
