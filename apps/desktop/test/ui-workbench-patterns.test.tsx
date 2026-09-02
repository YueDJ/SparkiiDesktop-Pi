import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown, ToolCard, LifecycleCard } from '@sparkii/ui';

describe('shared workbench patterns from @sparkii/ui', () => {
  it('renders markdown, tool card, lifecycle card', () => {
    render(<Markdown text="# 标题" />);
    expect(screen.getByText('标题')).toBeTruthy();
    render(<ToolCard toolName="bash" input={{ command: 'ls' }} />);
    expect(screen.getByText(/bash/)).toBeTruthy();
    render(<LifecycleCard entry={{ event: 'agent_start', label: 'Pi 开始处理', status: 'running' } as any} />);
    expect(screen.getByText('Pi 开始处理')).toBeTruthy();
  });
});
