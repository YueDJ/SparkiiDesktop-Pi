import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Composer, type ComposerProps } from '../src/workbench/Composer.js';

afterEach(cleanup);

function makeProps(over: Partial<ComposerProps> = {}): ComposerProps {
  return {
    busy: false,
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    defaultModel: 'deepseek-v4-flash',
    model: null,
    onModelChange: vi.fn(),
    thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    thinkingLevel: null,
    onThinkingLevelChange: vi.fn(),
    workspacePath: 'C:/ws/SparkiiXyZ9202608251710',
    workspaceKind: 'auto',
    onChooseWorkspace: vi.fn(),
    onClearWorkspace: vi.fn(),
    onSend: vi.fn(),
    onStop: vi.fn(),
    ...over,
  };
}

describe('Composer', () => {
  it('sends on Ctrl+Enter and clears the input', () => {
    const props = makeProps();
    render(<Composer {...props} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(props.onSend).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('shows stop instead of send while busy', () => {
    const props = makeProps({ busy: true });
    render(<Composer {...props} />);
    fireEvent.click(screen.getByTestId('composer-send'));
    expect(props.onStop).toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('model effort trigger shows default model and drills into model list', () => {
    const props = makeProps();
    render(<Composer {...props} />);
    expect(screen.getByTestId('model-effort-trigger').textContent).toContain('deepseek-v4-flash');
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    fireEvent.click(screen.getByText('模型'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-v4-pro' }));
    expect(props.onModelChange).toHaveBeenCalledWith('deepseek-v4-pro');
  });

  it('thinking menu emits level changes', () => {
    const props = makeProps();
    render(<Composer {...props} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    fireEvent.click(screen.getByText('思考强度'));
    fireEvent.click(screen.getByRole('menuitem', { name: '高' }));
    expect(props.onThinkingLevelChange).toHaveBeenCalledWith('high');
  });

  it('workspace row shows path, choose and clear actions', () => {
    const props = makeProps({ workspaceKind: 'user' });
    render(<Composer {...props} />);
    expect(screen.getByTestId('workspace-path').textContent).toContain('SparkiiXyZ9');
    fireEvent.click(screen.getByText('选择文件夹'));
    expect(props.onChooseWorkspace).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('workspace-clear'));
    expect(props.onClearWorkspace).toHaveBeenCalled();
  });
});
