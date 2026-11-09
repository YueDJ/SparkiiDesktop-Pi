/**
 * 唯一构建配置载体（设计稿 §5.4 / §10，M-new-2 闭合）。
 * 由 apps/desktop/electron-builder.yml 的全部键原样迁入；原 yml 已删除。
 *
 * ESM（.mjs）：可被 `node --check` 与 `import()` 直接加载。
 */

/**
 * 构建期占位常量：仅用于让 electron-builder 生成 latest.yml / .blockmap /
 * app-update.yml（含 provider / url / updaterCacheDirName）。
 * 永不用于运行时网络请求：运行时 setFeedURL 指向本地派生 feed，真正的
 * 服务器地址由 verifier 从 settings.update.baseUrl 读取（§5.2 / §5.4）。
 * 与客户端 __SPARKII_UPDATE_URL__ 彻底解耦；不含真实服务器 IP。
 */
export const PLACEHOLDER_UPDATE_URL = 'http://localhost/sparkii-updates/';

const APP_ID = 'com.sparkii.desktop';

export default {
  appId: APP_ID,
  productName: 'Sparkii',
  copyright: 'Copyright © 2026 深圳宇岳向上科技有限公司',
  artifactName: 'Sparkii-${version}-win-${arch}.${ext}',
  // 默认行为与 electron-builder.yml 完全一致（output: out）。
  // 【附加的可选覆盖】仅 CI / 验证时把 SPARKII_OUT_DIR 指向一个全新空目录，
  // 绕过本机环境对「批量删除既有 out/win-unpacked」的保护，避免为验证而删除任何既有产物。
  // 未设置该环境变量时默认仍为 'out'，不写入任何额外文件、不删除任何目录。
  directories: { output: process.env.SPARKII_OUT_DIR ?? 'out' },
  files: ['dist/**', 'dist-electron/**', 'dist-electron/pi-runtime/**', 'package.json'],
  asar: true,
  extraResources: [
    { from: 'native/windows-sandbox/bin', to: 'windows-sandbox' },
    { from: '../../apps/desktop/agents', to: 'agents' },
    { from: 'runtime/portable-git.7z.exe', to: 'runtime/portable-git.7z.exe' },
    {
      from: 'runtime/document-parse/sparkii-document-parse.7z.exe',
      to: 'runtime/document-parse/sparkii-document-parse.7z.exe',
    },
    { from: 'runtime/document-parse/checksums.json', to: 'runtime/document-parse/checksums.json' },
    { from: 'runtime/tools/fd.exe', to: 'runtime/tools/fd.exe' },
    { from: 'runtime/tools/rg.exe', to: 'runtime/tools/rg.exe' },
    { from: 'runtime/tools/licenses', to: 'runtime/tools/licenses' },
    // §7.7 步骤 7：安装由 detached watchdog 在应用完全退出后执行。
    // B1：watchdog 必须是独立镜像（镜像名 ≠ Sparkii.exe）且运行时部署到 $INSTDIR 之外，
    // 否则 NSIS 的 CHECK_APP_RUNNING 两个 kill 点都会命中它、旧卸载器的 un.atomicRMDir
    // 也会撞它的文件句柄。载体由 scripts/build-watchdog-sea.mjs 构建（Node SEA）。
    { from: 'build/watchdog/sparkii-update-watchdog.exe', to: 'scripts/sparkii-update-watchdog.exe' },
  ],
  win: {
    icon: 'build/icon.ico',
    target: ['nsis'],
    // §0.7 P0-4 / §5.5：这是构建配置开关，其产物效果是 app-update.yml 不含
    // publisherName（不会写入同名键），NsisUpdater.verifySignature() 因此跳过验签。
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    include: 'build/installer.nsh',
    // 卸载注册表键必须等于 appId：客户端按 Uninstall\<appId> 解析安装目录（§0.7 P0-2），
    // 缺省的 UUID.v5(appId) 会让客户端永远查不到 ⇒ INSTALL_BLOCKED。
    guid: APP_ID,
  },
  extraMetadata: { name: 'sparkii-desktop', main: 'dist-electron/main/index.js' },
  // publish: generic 让 builder 产出 latest.yml / .blockmap / app-update.yml。
  // 【注意】`--publish never` 只禁上传、不禁生成（§5.1）；out/latest.yml 不上传服务器，
  // 客户端按 §5.2 从已验签清单本地派生 latest.yml（§6.1 服务器不上传 latest.yml）。
  // .blockmap 仅为任务 0 评估 / P2 准备，本期恒定不启用差分
  // （disableDifferentialDownload = true，release.json 不带差分 URL）。
  publish: { provider: 'generic', url: PLACEHOLDER_UPDATE_URL },
};
