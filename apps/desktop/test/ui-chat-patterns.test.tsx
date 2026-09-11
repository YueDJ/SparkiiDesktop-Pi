import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ModelEffortControl, ChatComposer, type ChatComposerProps } from '@sparkii/ui';

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

  it('opens the menu downward when placement is bottom', () => {
    render(<ModelEffortControl model="deepseek-v4-pro" defaultModel="deepseek-v4-flash" models={['deepseek-v4-pro']} thinkingLevel="high" thinkingLevels={['low','high']} placement="bottom" onModelChange={vi.fn()} onThinkingLevelChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('model-effort-trigger'));
    const menu = document.querySelector('.ui-menu--fixed') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu?.style.top).toBeTruthy();
    expect(menu?.style.bottom).toBe('');
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
    render(<ChatComposer busy={false} workspacePath="C:/ws" onChooseWorkspace={vi.fn()} onOpenWorkspace={vi.fn()} modelProps={{ model: null, defaultModel: null, models: [], thinkingLevel: null, thinkingLevels: [], onModelChange: vi.fn(), onThinkingLevelChange: vi.fn() }} onSend={onSend} onStop={onStop} />);
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'hi' } });
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hi', []);
  });
});

function typeDraft(input: HTMLElement, value: string, cursor = value.length) {
  fireEvent.change(input, { target: { value, selectionStart: cursor, selectionEnd: cursor } });
  (input as HTMLTextAreaElement).setSelectionRange(cursor, cursor);
  fireEvent.select(input);
}

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

const twoSkills = [
  { name: 'brainstorming', description: 'Brainstorm ideas' },
  { name: 'using-superpowers', description: 'Use skills first' },
];

describe('ChatComposer skill slash', () => {
  it('does not open a menu when skills are omitted or null', () => {
    const omitted = render(<ChatComposer {...composerProps()} />);
    typeDraft(screen.getByTestId('composer-input'), '/');
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    omitted.unmount();
    render(<ChatComposer {...composerProps({ skills: null })} />);
    typeDraft(screen.getByTestId('composer-input'), '/');
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
  });

  it('shows the empty-library state when skills is an empty list', () => {
    render(<ChatComposer {...composerProps({ skills: [] })} />);
    typeDraft(screen.getByTestId('composer-input'), '/');
    expect(screen.getByTestId('composer-skill-menu').textContent).toContain('还没有安装技能');
  });

  it('lists, filters, and inserts a destName without sending', () => {
    const onSend = vi.fn();
    render(<ChatComposer {...composerProps({ skills: twoSkills, onSend })} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    typeDraft(input, '/');
    expect(screen.getAllByTestId('composer-skill-menu-item').map((el) => el.textContent)).toEqual([
      'brainstormingBrainstorm ideas',
      'using-superpowersUse skills first',
    ]);
    typeDraft(input, '/bra');
    expect(screen.getAllByTestId('composer-skill-menu-item')).toHaveLength(1);
    expect(screen.getByText('brainstorming')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('/brainstorming ');
    expect(screen.getByTestId('composer-skill-chip').textContent).toContain('brainstorming');
  });

  it('keeps the menu open with no-match copy and closes on Escape', () => {
    render(<ChatComposer {...composerProps({ skills: twoSkills })} />);
    const input = screen.getByTestId('composer-input');
    typeDraft(input, '/zzzz');
    expect(screen.getByTestId('composer-skill-menu').textContent).toContain('没有匹配的技能');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe('/zzzz');
  });

  it('inserts from a mouse click', async () => {
    render(<ChatComposer {...composerProps({ skills: twoSkills })} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    typeDraft(input, '/');
    fireEvent.click(screen.getByText('using-superpowers'));
    expect(input.value).toBe('/using-superpowers ');
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('shows a removable leading chip only for listed destName tokens', () => {
    render(<ChatComposer {...composerProps({ skills: [{ name: 'brainstorming', description: 'x' }] })} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    typeDraft(input, '/brainstorming 做对比');
    expect(screen.getByTestId('composer-skill-chip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('composer-skill-chip-remove'));
    expect(input.value).toBe('做对比');
    typeDraft(input, '/tmp');
    expect(screen.queryByTestId('composer-skill-chip')).toBeNull();
    typeDraft(input, '/skill:brainstorming');
    expect(screen.queryByTestId('composer-skill-chip')).toBeNull();
  });

  it('lists underscore names and inserts them without a chip', () => {
    render(<ChatComposer {...composerProps({
      skills: [{ name: 'contract_risk_review', description: 'Review risk' }],
    })} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    typeDraft(input, '/');
    expect(screen.getByText('contract_risk_review')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('/contract_risk_review ');
    expect(screen.queryByTestId('composer-skill-chip')).toBeNull();
  });

  it('opens after whitespace but not mid-word, and can insert an underscore name mid-sentence', () => {
    render(<ChatComposer {...composerProps({
      skills: [
        { name: 'brainstorming', description: 'ideas' },
        { name: 'contract_risk_review', description: 'Review risk' },
      ],
    })} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    typeDraft(input, '请看/bra');
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    typeDraft(input, '请 /bra');
    expect(screen.getByTestId('composer-skill-menu')).toBeTruthy();
    typeDraft(input, '/contract_r');
    expect(screen.getByText('contract_risk_review')).toBeTruthy();
    typeDraft(input, '请 /contract_r');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('请 /contract_risk_review ');
    expect(screen.queryByTestId('composer-skill-chip')).toBeNull();
  });

  it('inserts with Tab, closes on outside click, and follows the caret not the tail', () => {
    render(<ChatComposer {...composerProps({ skills: twoSkills })} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    typeDraft(input, '/bra');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/brainstorming ');
    typeDraft(input, '/');
    expect(screen.getByTestId('composer-skill-menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
    const mid = '上\n/bra\n下';
    typeDraft(input, mid, 6);
    expect(screen.getByTestId('composer-skill-menu')).toBeTruthy();
    typeDraft(input, mid, mid.length);
    expect(screen.queryByTestId('composer-skill-menu')).toBeNull();
  });
});
