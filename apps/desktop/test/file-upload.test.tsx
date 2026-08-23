import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { widgetRegistry } from '../src/composer/registry.js';

describe('FileUpload widget', () => {
  it('shows the selected document path', () => {
    const FileUpload = widgetRegistry['file-upload'];
    render(<FileUpload id="upload" bind="documents" state={{ documents: ['C:/tmp/contract.pdf'] }} onAction={() => {}} />);
    expect(screen.getByText('C:/tmp/contract.pdf')).toBeTruthy();
  });
  it('shows nothing when no document selected', () => {
    const FileUpload = widgetRegistry['file-upload'];
    const { container } = render(<FileUpload id="upload" bind="documents" state={{ documents: [] }} onAction={() => {}} />);
    expect(container.querySelector('[data-testid="upload-selected"]')).toBeNull();
  });
});
