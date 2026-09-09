import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
});
