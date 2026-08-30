import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { ChatWorkbench } from '../src/workbench/ChatWorkbench.js';
import { ErrorProvider, createMemoryErrorStore } from '@sparkii/ui';

// vitest runs without `globals: true`, so RTL's auto-cleanup is inactive;
// clean up between tests to avoid cross-test DOM leakage.
afterEach(cleanup);

function makeApi(promptImpl: () => Promise<unknown> = () => Promise.resolve({ ok: true })) {
  const channels: Record<string, (p: any) => void> = {};
  const api = {
    on: vi.fn((channel: string, cb: any) => { channels[channel] = cb; return () => {}; }),
    prompt: vi.fn(promptImpl),
  };
  return { api: api as any, channels };
}

describe('ChatWorkbench', () => {
  it('echoes the user draft immediately and does not duplicate runtime user echo', () => {
    const { api, channels } = makeApi();
    render(<ChatWorkbench api={api} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('发送'));
    expect(api.prompt).toHaveBeenCalledWith('hello');
    expect(screen.getByText('user: hello')).toBeTruthy();
    act(() => channels['chat-event']({ type: 'message', role: 'user', text: 'hello' }));
    expect(screen.getAllByText('user: hello')).toHaveLength(1);
    act(() => channels['chat-event']({ type: 'message', role: 'assistant', delta: 'Hi' }));
    expect(screen.getByText('assistant: Hi')).toBeTruthy();
  });

  it('shows an error when prompt rejects', async () => {
    const { api } = makeApi(() => Promise.reject(new Error('prompt timeout')));
    render(<ErrorProvider store={createMemoryErrorStore()}><ChatWorkbench api={api} /></ErrorProvider>);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText(/prompt timeout/)).toBeTruthy();
  });
});
