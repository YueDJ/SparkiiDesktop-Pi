import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ChatComposer, type ChatComposerProps } from '@sparkii/ui';

afterEach(cleanup);

function composerProps(over: Partial<ChatComposerProps> = {}): ChatComposerProps {
  return {
    busy: false,
    workspacePath: 'C:/ws',
    onChooseWorkspace: vi.fn(),
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

describe('ChatComposer toolbarExtra', () => {
  it('renders toolbarExtra as the first left-toolbar child', () => {
    render(<ChatComposer {...composerProps()} toolbarExtra={<span data-testid="extra">库</span>} />);
    const left = document.querySelector('.ui-composer-toolbar-left');
    expect(left?.firstElementChild?.getAttribute('data-testid')).toBe('extra');
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
