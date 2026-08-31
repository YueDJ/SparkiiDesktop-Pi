import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-electron/**',
      '**/coverage/**',
      '**/.superpowers/**',
      '**/*.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 本仓库在 mock/类型收窄处大量使用 any，且 TypeScript 已做类型检查，这里放宽避免噪音。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // 工具脚本使用 CommonJS require，是合法的 Node 用法，不适用 TS 的 no-require-imports 规则。
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
