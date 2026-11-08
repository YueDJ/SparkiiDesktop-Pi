# 更新源目录模板（Sparkii 自动升级 · 静态托管）

本目录是**发布树的结构模板**，供运维在服务器上搭建 `/sparkii-updates/` 时对照。
真正的文件由 `publish-release.mjs` 生成后上传；本目录内的 `*.example` 只是**示例值、非签名文件**，
用于说明字段形态，**绝不能被客户端当作真实清单使用**。

> 文中所有地址一律用占位符：`http://<YOUR_HOST>/sparkii-updates/`、`<YOUR_IP>`、`<YOUR_PORT>`。
> **绝不出现真实服务器 IP / 域名 / token。**

## 目录结构（设计稿 §6.1）

```text
/sparkii-updates/
├── channel.json                  # 唯一逻辑指针（配套 channel.json.sig）
├── channel.json.sig              # 指针签名
└── releases/
    └── <version>/                # 例：0.3.0
        ├── release.json          # 唯一权威清单（schema 2，含全部策略字段）
        ├── release.json.sig      # 清单签名
        ├── Sparkii-<version>-win-x64.exe
        ├── Sparkii-<version>-win-x64.exe.blockmap   # 可选，仅任务 0 实测 / P2 差分准备；本期不启用差分
        └── release-manifest.json # 沿用现有 schema 1，人工交付 / 构建审计
```

## 每个文件的用途

| 文件 | 用途 | 缓存策略 |
| --- | --- | --- |
| `channel.json` | **单一逻辑指针**：`sequence` / `targetVersion` / `manifestPath` / `manifestSha256` / `signaturePath` / `publishedAt`。`sequence` 的唯一权威来源，全局单调、只增不减 | **不缓存**：`Cache-Control: no-store` |
| `channel.json.sig` | 指针签名（`{"kid","signature"}`，Ed25519 base64，签名输入含 `kid`，覆盖 `channel.json` 原始字节） | 不缓存 / 短 TTL |
| `releases/<version>/release.json` | **唯一权威清单**（schema 2）：`sha512` / `bytes` / `expiresAt` / `nonce` / `sequence` / `requires` / `releaseNotes` 等 | ETag + 长缓存（内容寻址，版本目录不可变） |
| `releases/<version>/release.json.sig` | 清单签名，覆盖 `release.json` 原始字节 | ETag + 长缓存 |
| `releases/<version>/Sparkii-*.exe` | 安装包本体 | ETag + 长缓存 |
| `releases/<version>/*.exe.blockmap` | 可选；本期**不启用差分**（D6），仅复制留存供评估 / P2 | ETag + 长缓存 |
| `releases/<version>/release-manifest.json` | 人工交付 / 构建审计（schema 1，`unsigned: true`，`sha256` 与包体一致） | ETag + 长缓存 |

## 硬约束

- **服务器不上传 `latest.yml`，也不单独签它**。`latest.yml` 由客户端从已验签 `release.json` **本地派生**
  （设计稿 §5.2 定案 A / §6.1），从而消除「两份清单各自合法但混搭」的竞态。
- **禁止目录列表（autoindex / directory browsing 一律关闭）**：客户端只读已知路径，不依赖目录枚举；
  关闭列表也避免暴露历史版本清单供攻击者挑选重放。
- **`channel.json` 必须 `Cache-Control: no-store`**：指针切换不能被 CDN / 浏览器缓存延迟；其余文件
  （内容在版本目录内不可变）可放心用 ETag + 长缓存。
- **单一逻辑指针 = 两个物理文件**：`channel.json` 与 `channel.json.sig` 上传之间存在毫秒级非原子窗口，
  由客户端 **fail closed** 覆盖——任一文件缺失、签名不匹配、`manifestSha256` 与实收字节不符，
  一律当作「无更新」并静默退避，绝不放行未验签内容（§8.2）。发布时**最后**才切这两个文件。
- `.sig` 文件会被仓库根 `.gitignore` 的 `*.sig` 规则忽略，因此模板里的签名示例用 `*.sig.example` 后缀，
  避免被吞掉；服务端真实 `.sig` 由发布 CLI 生成上传，不进 Git。

## 静态服务器示例片段（占位地址，按需改写）

Nginx（与现有 RAG 服务共存，挂在 80 端口同一 server 下）：

```nginx
# 占位：把 <YOUR_HOST> 换成实际主机；示例只为说明 location，不含真实 IP。
server {
    listen 80;
    server_name <YOUR_HOST>;

    # 现有 RAG 业务保持原样，本段只新增更新源静态目录。
    location /sparkii-updates/ {
        alias /srv/sparkii-updates/;
        autoindex off;                 # 禁止目录列表
        sendfile on;

        # 指针：禁缓存，切换立即生效
        location = /sparkii-updates/channel.json {
            alias /srv/sparkii-updates/channel.json;
            add_header Cache-Control "no-store, no-cache, must-revalidate" always;
            default_type application/json;
        }
        location = /sparkii-updates/channel.json.sig {
            alias /srv/sparkii-updates/channel.json.sig;
            add_header Cache-Control "no-store, no-cache, must-revalidate" always;
            default_type application/json;
        }

        # 版本目录不可变：ETag + 长缓存
        location /sparkii-updates/releases/ {
            alias /srv/sparkii-updates/releases/;
            etag on;
            add_header Cache-Control "public, max-age=31536000, immutable" always;
        }
    }
}
```

IIS / 其它静态服务器等价做法：把某只读目录映射成 `/sparkii-updates/` 虚拟目录，关闭目录浏览，
对 `channel.json` / `channel.json.sig` 设置 `no-store`，其余文件开启 ETag 与长缓存即可。
Web 服务器类型不影响协议——发布脚本只负责把文件放进这个目录。

> 完整发布 SOP、密钥管理、泄露带外预案与紧急撤回见 `docs/operations/update-service.md`。
