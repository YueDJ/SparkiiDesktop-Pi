# DeepSeek V4.1 Flash Capability Warning Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the false compatibility warning for `deepseek-flash` without weakening compatibility checks for genuinely incompatible models.

**Architecture:** Keep the existing Main-process model capability table and `findCompatibleModels` flow. Add the current model ID explicitly and replace the image-vs-tools fallback with capability composition.

**Tech Stack:** TypeScript, Electron Main IPC, Vitest.

**Spec:** The root-cause analysis below is the complete bug specification.

## Root Cause

Pi reports DeepSeek V4.1 Flash as `deepseek-flash` with image support. Main only knows `deepseek-v4-flash`, so the generic fallback returns `chat + vision`, omitting `toolCall`. General requires `chat + toolCall`, causing a false warning.

## Decision

Make two production changes:

1. Add `deepseek-flash` to `MODEL_CAPABILITY_DEFAULTS`.
2. Make the generic fallback compose vision with the existing `chat + toolCall` baseline.

Do not add a new module, dependency, UI change, or warning-copy change. The renderer already trusts `compatibleModels`; once Main returns the correct result, the warning disappears.

## Task 1: Add One Integration Regression Test

**Files:**
- Modify: `apps/desktop/test/ipc.test.ts`

**Test cases in one fixture:**
- `deepseek-flash`: compatible.
- Unknown image-capable `future-vision-chat`: compatible through the composed fallback.
- Explicit vision-only `deepseek-vision`: incompatible.

- [ ] **Step 1: Add the failing test**

Add near the existing `getModelOptions` tests:

```ts
it('classifies current DeepSeek models with orthogonal capabilities', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ipc-model-capabilities-'));
  dirs.push(dataDir);
  const piAgentDir = join(dataDir, 'pi-agent');
  await mkdir(piAgentDir, { recursive: true });

  await makeRuntime({
    dataDir,
    piAgentDir,
    client: {
      send: async (command: any) => command.type === 'list_models'
        ? {
            success: true,
            data: [
              { modelId: 'deepseek-flash', supportsImages: true },
              { modelId: 'future-vision-chat', supportsImages: true },
              { modelId: 'deepseek-vision', supportsImages: true },
            ],
          }
        : { success: true },
    },
    agentOf: () => ({
      id: 'general',
      tools: [],
      dir: join(dataDir, 'profiles', 'general'),
      systemPrompt: 'test',
      manifest: {
        id: 'general',
        version: '1.0.0',
        surface: { type: 'chat' },
        capabilities: { tools: [] },
        modelRequirements: { requires: ['chat', 'toolCall'] },
      },
    }),
  });

  const handlers = await registeredHandlers();
  const result = await handlers.get('sparkii:getModelOptions')!(null, 'general') as {
    compatibleModels: string[];
    incompatibleModels: string[];
  };

  expect(result.compatibleModels).toEqual([
    'deepseek-flash',
    'future-vision-chat',
  ]);
  expect(result.incompatibleModels).toEqual(['deepseek-vision']);
});
```

- [ ] **Step 2: Verify RED**

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/ipc.test.ts -t "orthogonal capabilities"
```

Expected: FAIL because both image-capable unknown models omit `toolCall`.

## Task 2: Apply the Minimal Fix

**Files:**
- Modify: `apps/desktop/electron/main/ipc.ts`

- [ ] **Step 1: Add the current model ID**

Add to `MODEL_CAPABILITY_DEFAULTS`:

```ts
'deepseek-flash': ['chat', 'vision', 'toolCall'],
```

Keep the existing `deepseek-v4-flash` entry unchanged for compatibility.

- [ ] **Step 2: Fix the fallback**

Replace:

```ts
capabilities: MODEL_CAPABILITY_DEFAULTS[m.modelId]
  ?? (m.supportsImages ? ['chat', 'vision'] : ['chat', 'toolCall']) as ModelCapability[],
```

with:

```ts
capabilities: MODEL_CAPABILITY_DEFAULTS[m.modelId]
  ?? ([
    'chat',
    'toolCall',
    ...(m.supportsImages ? ['vision' as const] : []),
  ] as ModelCapability[]),
```

`deepseek-vision` remains explicitly `chat + vision`, so it is still rejected by the general agent.

- [ ] **Step 3: Verify GREEN**

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/ipc.test.ts -t "orthogonal capabilities|getModelOptions"
```

Expected: PASS.

## Task 3: Verify No Regression

- [ ] **Step 1: Run the directly affected suites**

```powershell
.\node_modules\.bin\vitest.cmd run apps/desktop/test/ipc.test.ts apps/desktop/test/standard-chat.test.tsx
```

- [ ] **Step 2: Run both TypeScript checks**

```powershell
node .\node_modules\.pnpm\typescript@6.0.3\node_modules\typescript\lib\tsc.js --noEmit -p apps/desktop/tsconfig.json
node .\node_modules\.pnpm\typescript@6.0.3\node_modules\typescript\lib\tsc.js --noEmit -p apps/desktop/tsconfig.electron.json
```

## Acceptance Criteria

- `deepseek-flash` appears in general-agent `compatibleModels`.
- The renderer no longer shows the compatibility warning for DeepSeek V4.1 Flash.
- `deepseek-v4-flash` behavior is unchanged.
- Unknown image-capable models do not lose `toolCall`.
- Explicit `deepseek-vision` remains incompatible with tool-requiring agents.
- No new production module or UI change is introduced.
