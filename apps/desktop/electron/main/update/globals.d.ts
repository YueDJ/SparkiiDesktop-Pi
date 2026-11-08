// esbuild `define` 在 build:main 注入；未注入时为 undefined。
// config.ts 必须用 typeof 守卫读取，避免 ReferenceError。
declare const __SPARKII_UPDATE_URL__: string | undefined;
/** 发布公钥清单原文（JSON 文本）。未注入 ⇒ 空表 ⇒ 验签一律失败（fail closed）。 */
declare const __SPARKII_RELEASE_PUBLIC_KEYS__: string | undefined;
