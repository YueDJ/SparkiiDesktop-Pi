# Windows 内部试用版发布说明

## 适用范围

当前发布渠道仅面向受控的内部试用用户，产物为 Windows x64 NSIS 安装包。首版不包含代码签名、MSIX 和自动更新。

由于安装包未签名，Windows SmartScreen 可能显示“未知发布者”。安装包不得作为公开下载版本发布。

## 构建环境

- Windows x64；
- Node.js 22 或更高版本；
- pnpm 9 或更高版本；
- 原生模块需要重新编译时，安装 Visual Studio C++ Build Tools。

运行时归档固定放在 `apps/desktop/runtime/`，构建前会校验 Portable Git、文档解析和搜索工具的固定 SHA256。

## 构建

在仓库根目录运行：

```powershell
$env:CI = 'true'
pnpm install --frozen-lockfile
pnpm --dir apps/desktop dist
```

构建机应优先使用根 `package.json` 声明的 pnpm 9.15.0。若机器上的 pnpm 主版本更高，`CI=true` 可让非交互环境完成依赖目录一致性检查，避免构建被 TTY 提示中断。

构建完成后，`apps/desktop/out/` 应包含：

- `Sparkii-<version>-win-x64.exe`；
- `release-manifest.json`；
- `SHA256SUMS.txt`。

旧的 `Sparkii Setup *.exe` 和 `.appx` 文件不属于当前发布格式，不应继续分发。

## 安装与数据位置

- 安装器为 per-user one-click 模式，不要求管理员权限；
- 首次启动会在当前用户目录准备内置运行时；
- 用户数据位于 `%LOCALAPPDATA%\SparkiiDesktop\data`；
- 覆盖安装和卸载不会删除该数据目录。

## 发布检查

对最终安装包执行：

```powershell
$artifact = Get-ChildItem -LiteralPath 'apps/desktop/out' -File |
  Where-Object { $_.Name -like 'Sparkii-*-win-x64.exe' } |
  Select-Object -First 1
$artifact.VersionInfo | Select-Object CompanyName,ProductName,FileVersion,LegalCopyright
Get-AuthenticodeSignature -LiteralPath $artifact.FullName |
  Select-Object Status,StatusMessage
Get-Content -LiteralPath 'apps/desktop/out/release-manifest.json'
```

预期：

- `CompanyName` 为 `深圳宇岳向上科技有限公司`；
- `ProductName` 为 `Sparkii`；
- 签名状态为 `NotSigned`；
- `release-manifest.json` 中的 SHA256 与 `SHA256SUMS.txt` 一致。

在干净的 Windows 10 或 Windows 11 x64 用户环境中至少验证：

1. 普通用户双击安装，不出现管理员权限要求；
2. 首次启动完成运行时准备；
3. 设置中的“关于”显示公司名称和未签名状态；
4. 覆盖安装后用户数据保留；
5. 卸载后 `%LOCALAPPDATA%\SparkiiDesktop\data` 保留；
6. 在目标杀毒软件策略下能够安装和启动。
