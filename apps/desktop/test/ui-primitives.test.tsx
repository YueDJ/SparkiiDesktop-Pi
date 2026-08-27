import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button, IconButton, Badge, StatusBadge, Tag, Card } from '@sparkii/ui';

describe('ui primitives', () => {
  it('renders button variants and sizes', () => {
    render(<Button variant="primary" size="lg" data-testid="b">发送</Button>);
    expect(screen.getByTestId('b').className).toContain('ui-btn--primary');
    expect(screen.getByTestId('b').className).toContain('ui-btn--lg');
  });

  it('renders an icon button with an accessible name', () => {
    render(<IconButton label="设置" data-testid="icon">⚙</IconButton>);
    expect(screen.getByTestId('icon').getAttribute('aria-label')).toBe('设置');
  });

  it('renders status badge semantic class', () => {
    render(<StatusBadge status="running" />);
    expect(screen.getByText('运行中').className).toContain('ui-status-badge--running');
  });

  it('renders badge, tag and card', () => {
    render(<><Badge>3</Badge><Tag>本地</Tag><Card data-testid="card">内容</Card></>);
    expect(screen.getByText('3').className).toContain('ui-badge');
    expect(screen.getByText('本地').className).toContain('ui-tag');
    expect(screen.getByTestId('card').className).toContain('ui-card');
  });
});
