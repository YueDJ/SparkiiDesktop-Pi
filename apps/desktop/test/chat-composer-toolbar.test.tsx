import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatComposer, type ChatComposerProps } from '@sparkii/ui';

afterEach(cleanup);

function composerProps(over: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    busy: false,
    workspacePath: 'C:/ws',
    onChooseWorkspace: vi.fn(),
    onOpenWorkspace: vi.fn(),
    modelProps: {
      model: null,
      defaultModel: null,
      models: [],
      thinkingLevel: null,
      thinkingLevels: [],
      onModelChange: vi.fn(),
      onThinkingLevelChange: vi.fn(),
    },
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
}

describe('ChatComposer toolbar', () => {
  it('uses the shared icon-button layout for upload', () => {
    render(<ChatComposer {...composerProps()} />);
    const upload = screen.getByRole('button', { name: '上传文件' });
    expect(upload.classList.contains('ui-btn')).toBe(true);
    expect(upload.classList.contains('ui-icon-btn')).toBe(true);
  });

  it('orders upload, workspace, then toolbarExtra', () => {
    render(<ChatComposer {...composerProps()} toolbarExtra={<span data-testid="extra">库</span>} />);
    const left = document.querySelector('.ui-composer-toolbar-left');
    expect(left?.children[0]).toBe(screen.getByRole('button', { name: '上传文件' }));
    expect(left?.children[1].querySelector('[data-testid="composer-workspace"]')).toBeTruthy();
    expect(left?.children[2]).toBe(screen.getByTestId('extra'));
  });

  it('hides workspace when hideWorkspace is set', () => {
    render(<ChatComposer {...composerProps()} hideWorkspace />);
    expect(screen.queryByTestId('composer-workspace')).toBeNull();
  });

  it('disables the workspace button until a path is present', () => {
    const onChooseWorkspace = vi.fn();
    render(<ChatComposer {...composerProps({ workspacePath: null, onChooseWorkspace })} />);
    const button = screen.getByTestId('composer-workspace') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onChooseWorkspace).not.toHaveBeenCalled();
  });
});
