import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SettingsView } from '../src/shell/SettingsView.js';

afterEach(cleanup);

describe('SettingsView', () => {
  it('renders the LLM pane by default', () => {
    render(<SettingsView />);
    expect(screen.getAllByText('大模型连接').length).toBeGreaterThan(0);
    expect(screen.getByText('模型状态')).toBeTruthy();
  });

  it('switches to the data and privacy pane', () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByText('数据与隐私'));
    expect(screen.getByText('数据目录')).toBeTruthy();
  });

  it('fetch models populates the status list for the current node', async () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByText('拉取模型列表'));
    await screen.findByText(/已拉取 2 个模型/);
    expect(screen.getByText('qwen2.5 · 本地')).toBeTruthy();
  });
});
