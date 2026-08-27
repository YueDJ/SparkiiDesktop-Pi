import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Drawer, Menu, MenuItem } from '@sparkii/ui';

describe('ui overlays and menu', () => {
  it('drawer closes on backdrop and close button', () => {
    const onClose = vi.fn();
    render(<Drawer open title="会话" onClose={onClose}>内容</Drawer>);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('drawer-backdrop'));
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('menu item shows hint and calls select', () => {
    const onSelect = vi.fn();
    render(<Menu open onClose={vi.fn()}><MenuItem label="模型" hint="deepseek-v4-pro" onSelect={onSelect} /></Menu>);
    expect(screen.getByText('deepseek-v4-pro')).toBeTruthy();
    fireEvent.click(screen.getByText('模型'));
    expect(onSelect).toHaveBeenCalled();
  });
});
