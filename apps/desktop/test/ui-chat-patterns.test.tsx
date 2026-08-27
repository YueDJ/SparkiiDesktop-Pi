import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ModelEffortControl, ChatComposer } from '@sparkii/ui';

afterEach(cleanup);

describe('ui chat patterns', () => {
  it('model effort control shows one combined trigger', () => {
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro']} thinkingLevel="high" thinkingLevels={['low','high']} onModelChange={vi.fn()} onThinkingLevelChange={vi.fn()} />);
    expect(screen.getByTestId('model-effort-trigger').textContent).toContain('deepseek-v4-pro');
    expect(screen.getByTestId('model-effort-trigger').textContent).toContain('高');
  });

  it('model effort menu has two rows with chevrons', () => {
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro']} thinkingLevel="high" thinkingLevels={['low','high']} onModelChange={vi.fn()} onThinkingLevelChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    expect(screen.getByText('模型')).toBeTruthy();
    expect(screen.getByText('思考强度')).toBeTruthy();
    expect(screen.getAllByText('›').length).toBe(2);
  });

  it('model row drills into the model list and selects one', () => {
    const onModelChange = vi.fn();
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro', 'deepseek-v4-flash']} thinkingLevel="high" thinkingLevels={['low','high']} onModelChange={onModelChange} onThinkingLevelChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    fireEvent.click(screen.getByText('模型'));
    expect(screen.getByText('默认（跟随配置）')).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: 'deepseek-v4-flash' }));
    expect(onModelChange).toHaveBeenCalledWith('deepseek-v4-flash');
  });

  it('thinking row drills into levels and selects one', () => {
    const onThinkingLevelChange = vi.fn();
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro']} thinkingLevel="high" thinkingLevels={['low','high']} onModelChange={vi.fn()} onThinkingLevelChange={onThinkingLevelChange} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    fireEvent.click(screen.getByText('思考强度'));
    fireEvent.click(screen.getByText('低'));
    expect(onThinkingLevelChange).toHaveBeenCalledWith('low');
  });

  it('chat composer sends and stops', () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(<ChatComposer busy={false} workspacePath="C:/ws" workspaceKind="auto" onChooseWorkspace={vi.fn()} onClearWorkspace={vi.fn()} modelProps={{ model: null, defaultModel: null, models: [], thinkingLevel: null, thinkingLevels: [], onModelChange: vi.fn(), onThinkingLevelChange: vi.fn() }} onSend={onSend} onStop={onStop} />);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', ctrlKey: true });
    expect(onSend).toHaveBeenCalledWith('hi');
  });
});
