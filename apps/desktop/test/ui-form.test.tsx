import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TextField, TextArea, Select, SelectMenu, Switch, Tabs, EmptyState, Toolbar, Divider } from '@sparkii/ui';

afterEach(cleanup);

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
        className="extra"
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
    expect(trigger.className).toContain('extra');
    expect(trigger.value).toBe('90');
    fireEvent.click(trigger);
    const menu = document.body.querySelector('.ui-menu.ui-menu--fixed') as HTMLElement | null;
    expect(menu).toBeTruthy();
    expect(menu?.parentElement).toBe(document.body);
    fireEvent.click(screen.getByRole('menuitem', { name: '30 天' }));
    expect(onChange).toHaveBeenCalledWith('30');
    expect(document.body.querySelector('.ui-menu--fixed')).toBeNull();
  });

  it('keeps field chrome unless variant is plain', () => {
    const { rerender } = render(
      <SelectMenu data-testid="menu-select" value="a" options={[{ value: 'a', label: 'A' }]} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('menu-select').className).toContain('ui-select');
    rerender(
      <SelectMenu data-testid="menu-select" variant="plain" className="range" value="a" options={[{ value: 'a', label: 'A' }]} onChange={vi.fn()} />,
    );
    const trigger = screen.getByTestId('menu-select');
    expect(trigger.classList.contains('range')).toBe(true);
    expect(trigger.classList.contains('ui-select')).toBe(false);
    expect(trigger.classList.contains('ui-select-menu-trigger')).toBe(true);
  });

  it('shows disabled options without selecting them', () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        data-testid="menu-select"
        value="a"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
          { value: 'c', label: 'C' },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('menu-select'));
    const blocked = screen.getByRole('menuitem', { name: 'B' });
    expect(blocked).toHaveProperty('disabled', true);
    fireEvent.click(blocked);
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement?.textContent).toContain('A');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('C');
    expect(document.body.querySelector('.ui-menu--fixed')).toBeTruthy();
  });

  it('focuses the current value and moves with arrows, then closes on Escape', () => {
    render(
      <SelectMenu
        data-testid="menu-select"
        value="b"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('menu-select'));
    expect(document.activeElement?.textContent).toContain('B');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('C');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('B');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
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
