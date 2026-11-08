import { describe, expect, it, vi } from 'vitest';
import { installDocumentParseQuitHook } from '../electron/main/document-parse-quit.js';

describe('installDocumentParseQuitHook', () => {
  it('prevents the first before-quit and does not beginQuit twice', async () => {
    const beginQuit = vi.fn(async () => {});
    const quit = vi.fn();
    const listeners: Array<(e: { preventDefault: () => void }) => void> = [];
    const app = {
      on: (_event: string, listener: (e: { preventDefault: () => void }) => void) => {
        listeners.push(listener);
      },
      quit,
    };
    installDocumentParseQuitHook(app, () => ({ beginQuit }));
    expect(listeners).toHaveLength(1);

    const preventDefault = vi.fn();
    listeners[0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(beginQuit).toHaveBeenCalledTimes(1);

    listeners[0]({ preventDefault: vi.fn() });
    expect(beginQuit).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });

  it('bypasses the hook when shouldBypass() is true (no preventDefault, no beginQuit, no quit)', () => {
    const beginQuit = vi.fn(async () => {});
    const quit = vi.fn();
    const listeners: Array<(e: { preventDefault: () => void }) => void> = [];
    const app = {
      on: (_event: string, listener: (e: { preventDefault: () => void }) => void) => {
        listeners.push(listener);
      },
      quit,
    };
    const shouldBypass = vi.fn(() => true);
    installDocumentParseQuitHook(app, () => ({ beginQuit }), shouldBypass);
    expect(listeners).toHaveLength(1);

    const preventDefault = vi.fn();
    listeners[0]({ preventDefault });
    expect(shouldBypass).toHaveBeenCalledTimes(1);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(beginQuit).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('keeps the original beginQuit flow when shouldBypass() is false', async () => {
    const beginQuit = vi.fn(async () => {});
    const quit = vi.fn();
    const listeners: Array<(e: { preventDefault: () => void }) => void> = [];
    const app = {
      on: (_event: string, listener: (e: { preventDefault: () => void }) => void) => {
        listeners.push(listener);
      },
      quit,
    };
    installDocumentParseQuitHook(app, () => ({ beginQuit }), () => false);

    const preventDefault = vi.fn();
    listeners[0]({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(beginQuit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });

  it('does not swallow a later quit after a bypassed before-quit', async () => {
    const beginQuit = vi.fn(async () => {});
    const quit = vi.fn();
    const listeners: Array<(e: { preventDefault: () => void }) => void> = [];
    const app = {
      on: (_event: string, listener: (e: { preventDefault: () => void }) => void) => {
        listeners.push(listener);
      },
      quit,
    };
    let bypass = true;
    installDocumentParseQuitHook(app, () => ({ beginQuit }), () => bypass);

    const first = { preventDefault: vi.fn() };
    listeners[0](first); // isUpdating 放行
    expect(first.preventDefault).not.toHaveBeenCalled();
    expect(beginQuit).not.toHaveBeenCalled();

    bypass = false;
    const second = { preventDefault: vi.fn() };
    listeners[0](second); // 之后普通退出仍走原流程
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(beginQuit).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  });
});
