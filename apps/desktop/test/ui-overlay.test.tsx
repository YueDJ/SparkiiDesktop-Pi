import { useRef, useState, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Drawer, Modal, Menu, MenuItem, MENU_GAP_FALLBACK_PX, MENU_TRIGGER_GAP_FALLBACK_PX, SelectMenu } from '@sparkii/ui';

afterEach(cleanup);

function mockBox(el: Element, box: { top: number; left: number; width: number; height: number }) {
  const rect = {
    x: box.left,
    y: box.top,
    top: box.top,
    left: box.left,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    toJSON() { return this; },
  } as DOMRect;
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(rect);
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: box.width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: box.height });
}

function Harness({
  placement = 'bottom',
  align = 'start',
  children,
}: {
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  children?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(true);
  return (
    <div ref={containerRef} data-testid="menu-anchor">
      <button type="button">trigger</button>
      <Menu open={open} onClose={() => setOpen(false)} containerRef={containerRef} placement={placement} align={align}>
        {children ?? <MenuItem label="全部结果" onSelect={() => setOpen(false)} />}
      </Menu>
    </div>
  );
}

describe('ui overlays and menu', () => {
  it('drawer closes on backdrop and close button', () => {
    const onClose = vi.fn();
    render(<Drawer open title="会话" onClose={onClose}>内容</Drawer>);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('drawer defaults to 420 and can be sm', () => {
    const { rerender } = render(<Drawer open title="运行中心" onClose={() => {}}>内容</Drawer>);
    const panel = screen.getByRole('dialog', { name: '运行中心' });
    expect(panel.className).toContain('ui-drawer');
    expect(panel.className).not.toContain('ui-drawer--sm');
    const close = screen.getByLabelText('关闭');
    expect(close.className).toContain('ui-dismiss');
    expect(close.className).not.toContain('ui-icon-btn');
    expect(close.querySelector('svg')).toBeTruthy();
    rerender(<Drawer open title="账号" size="sm" onClose={() => {}}>内容</Drawer>);
    expect(screen.getByRole('dialog', { name: '账号' }).className).toContain('ui-drawer--sm');
  });

  it('menu item shows hint and calls select', () => {
    const onSelect = vi.fn();
    render(<Menu open onClose={vi.fn()}><MenuItem label="模型" hint="deepseek-v4-pro" onSelect={onSelect} /></Menu>);
    expect(screen.getByText('deepseek-v4-pro')).toBeTruthy();
    fireEvent.click(screen.getByText('模型'));
    expect(onSelect).toHaveBeenCalled();
  });

  it('menu closes on outside pointer down', () => {
    const onClose = vi.fn();
    render(<><button type="button">outside</button><Menu open onClose={onClose}><MenuItem label="模型" onSelect={vi.fn()} /></Menu></>);
    fireEvent.pointerDown(screen.getByText('outside'));
    expect(onClose).toHaveBeenCalled();
  });

  it('modal closes when the mask is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal open title="审批" onClose={onClose}>内容</Modal>);
    const mask = container.querySelector('.ui-modal-mask');
    expect(mask).toBeTruthy();
    fireEvent.click(mask!);
    expect(onClose).toHaveBeenCalled();
  });

  it('recomputes live placement and keeps a viewport gap', () => {
    const triggerGap = MENU_TRIGGER_GAP_FALLBACK_PX;
    const edge = MENU_GAP_FALLBACK_PX;
    render(<Harness />);
    const anchor = screen.getByTestId('menu-anchor');
    const menu = document.body.querySelector('.ui-menu--fixed') as HTMLElement;
    mockBox(anchor, { top: 80, left: 860, width: 130, height: 34 });
    mockBox(menu, { top: 0, left: 0, width: 220, height: 120 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(menu.dataset.placement).toBe('bottom');
    expect(Number.parseFloat(menu.style.top)).toBe(80 + 34 + triggerGap);
    expect(Number.parseFloat(menu.style.left) + 220).toBeLessThanOrEqual(window.innerWidth - edge);
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(edge);

    mockBox(anchor, { top: window.innerHeight - 50, left: 80, width: 130, height: 34 });
    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(menu.dataset.placement).toBe('top');
    expect(menu.style.top).toBe('');
    expect(Number.parseFloat(menu.style.bottom)).toBeGreaterThan(edge);
  });

  it('select menu inherits the shared Menu gap from the right edge', () => {
    const edge = MENU_GAP_FALLBACK_PX;
    render(
      <SelectMenu
        data-testid="audit-filter"
        aria-label="结果"
        value="all"
        options={[
          { value: 'all', label: '全部结果' },
          { value: 'executed', label: '已执行' },
        ]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('audit-filter'));
    const trigger = screen.getByTestId('audit-filter').parentElement as HTMLElement;
    const menu = document.body.querySelector('.ui-menu--fixed') as HTMLElement;
    mockBox(trigger, { top: 72, left: window.innerWidth - 140, width: 130, height: 34 });
    mockBox(menu, { top: 0, left: 0, width: 220, height: 132 });
    act(() => { window.dispatchEvent(new Event('resize')); });
    const right = Number.parseFloat(menu.style.left) + 220;
    expect(right).toBeLessThanOrEqual(window.innerWidth - edge);
    expect(right).not.toBe(window.innerWidth);
  });
});
