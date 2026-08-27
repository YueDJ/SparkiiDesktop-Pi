import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextField, TextArea, Select, Switch, Tabs, EmptyState, Toolbar, Divider } from '@sparkii/ui';

describe('ui form and layout primitives', () => {
  it('renders text, textarea and select controls', () => {
    render(<><TextField data-testid="t" placeholder="输入" /><TextArea data-testid="a" /><Select data-testid="s"><option value="x">X</option></Select></>);
    expect(screen.getByTestId('t').className).toContain('ui-field');
    expect(screen.getByTestId('a').className).toContain('ui-textarea');
    expect(screen.getByTestId('s').className).toContain('ui-select');
  });

  it('switch reports boolean changes', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} label="本地" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('tabs exposes active tab', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]} active="a" onChange={onChange} />);
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('renders empty state, toolbar and divider', () => {
    render(<><EmptyState title="暂无会话" description="开始一个" /><Toolbar><span>x</span></Toolbar><Divider /></>);
    expect(screen.getByText('暂无会话')).toBeTruthy();
    expect(screen.getByText('x').parentElement?.className).toContain('ui-toolbar');
  });
});
