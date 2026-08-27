import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Drawer, Modal, Menu, MenuItem } from '@sparkii/ui';

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
});
