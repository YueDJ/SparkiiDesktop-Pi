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
});
