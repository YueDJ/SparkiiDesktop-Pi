import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import WysiwygEditor from '../agents/bid-writing/surface/wysiwyg.js';

// Minimal 1x1 PNG bytes, base64.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

afterEach(() => {
  cleanup();
  delete (window as any).sparkii;
  vi.restoreAllMocks();
});

describe('WYSIWYG editor (B1 / architect review round 2)', () => {
  beforeEach(() => {
    // jsdom does not implement object URLs / atob fully in all setups.
    if (!URL.createObjectURL) (URL as any).createObjectURL = vi.fn(() => 'blob:mock');
    if (!URL.revokeObjectURL) (URL as any).revokeObjectURL = vi.fn();
  });

  it('renders images as visible blocks (no raw ![]() source) and loads bytes via fenced workspaceReadBytes', async () => {
    const workspaceReadBytes = vi.fn().mockResolvedValue({ ok: true, op: 'readBytes', path: '', bytesBase64: PNG_B64 });
    (window as any).sparkii = { workspaceReadBytes };
    const onEditFigure = vi.fn();
    render(
      <WysiwygEditor
        value={'# 方案\n\n![总体架构](figures/arch.png)\n\n正文段落'}
        sessionId="sess-1"
        onChange={() => {}}
        onEditFigure={onEditFigure}
        placeholder="正文"
      />,
    );
    // WYSIWYG mode: raw markdown source is NOT shown as text.
    expect(screen.queryByText(/!\[总体架构\]/)).toBeNull();
    // Image is a visible block; clicking it asks to edit the source.
    const fig = await screen.findByText('编辑图源');
    await act(async () => { fig.click(); });
    expect(onEditFigure).toHaveBeenCalledWith('figures/arch.png');
    // Bytes loaded through the fenced workspace IPC with the correct workspace
    // path mapping (figures/ -> output/figures/, NOT output/manuscript/).
    await waitFor(() => {
      expect(workspaceReadBytes).toHaveBeenCalledWith({ sessionId: 'sess-1', path: 'output/figures/arch.png' });
    });
  });

  it('switches to source mode and preserves markdown byte-for-byte', async () => {
    (window as any).sparkii = {};
    const md = '# 标题\n\n正文带 **加粗** 与 ![图](figures/a.png)';
    render(
      <WysiwygEditor value={md} sessionId="s1" onChange={() => {}} onEditFigure={() => {}} placeholder="正文" />,
    );
    await act(async () => { screen.getByText('查看源码').click(); });
    const ta = screen.getByPlaceholderText('正文') as HTMLTextAreaElement;
    expect(ta.value).toBe(md);
  });
});
