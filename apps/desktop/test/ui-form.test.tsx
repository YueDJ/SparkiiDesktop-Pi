import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TextField, TextArea, Select, SelectMenu, Switch, Tabs, EmptyState, Toolbar, Divider } from '@sparkii/ui';

describe('ui form and layout primitives', () => {
  it('renders text, textarea and select controls', () => {
    render(<><TextField data-testid="t" placeholder="输入" /><TextArea data-testid="a" /><Select data-testid="s"><option value="x">X</option></Select></>);
    expect(screen.getByTestId('t').className).toContain('ui-field');
    expect(screen.getByTestId('a').className).toContain('ui-textarea');
    expect(screen.getByTestId('s').className).toContain('ui-select');
  });

  it('select menu portals onto body and reports the chosen value', () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        data-testid="menu-select"
        aria-label="范围"
        value="90"
        options={[
          { value: '30', label: '30 天' },
          { value: '90', label: '90 天' },
        ]}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByTestId('menu-select') as HTMLButtonElement;
    expect(trigger.className).toContain('ui-select');
    expect(trigger.value).toBe('90');
    fireEvent.click(trigger);
    const menu = document.body.querySelector('.ui-menu.ui-menu--fixed') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('menuitem', { name: '30 天' }));
    expect(onChange).toHaveBeenCalledWith('30');
    expect(document.body.querySelector('.ui-menu--fixed')).toBeNull();
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
