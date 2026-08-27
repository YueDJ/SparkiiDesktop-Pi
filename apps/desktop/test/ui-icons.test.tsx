import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SendIcon, ChevronDownIcon } from '@sparkii/ui';

describe('ui icons', () => {
  it('renders stroke-based icons with currentColor', () => {
    const { container } = render(<><SendIcon /><ChevronDownIcon /></>);
    expect(container.querySelectorAll('svg').length).toBe(2);
    expect(container.querySelector('svg')?.getAttribute('stroke')).toBe('currentColor');
  });
});
