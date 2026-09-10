import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RuntimeCenter, StatusBar } from '@sparkii/ui';
import { SettingsView } from '../src/shell/SettingsView.js';
import {
  DOCUMENT_PARSE_DISK_FULL,
  DOCUMENT_PARSE_NOT_READY,
} from '../electron/main/document-parse-layout.js';
import {
  DOCUMENT_PARSE_SPAWN_FAILED,
  DOCUMENT_PARSE_STOPPED,
} from '../electron/main/document-parse-supervisor.js';

const FORBIDDEN = /worker|sidecar|OCR|Paddle|JSON-RPC/i;

const LOCKED_ERRORS = [
  DOCUMENT_PARSE_NOT_READY,
  DOCUMENT_PARSE_DISK_FULL,
  DOCUMENT_PARSE_SPAWN_FAILED,
  DOCUMENT_PARSE_STOPPED,
] as const;

const parsingSnap = {
  status: 'parsing' as const,
  fileName: 'scan.pdf',
  agentDisplayName: '合同审核智能体',
  page: 3,
  total: 12,
  waiting: [{ sessionId: 's2', agentDisplayName: '通用智能体', fileName: 'invoice.jpg' }],
};

function makeSettingsApi() {
  return {
    getSettings: vi.fn().mockResolvedValue({
      activeProviderId: 'deepseek',
      documentParse: { idleMinutes: 5, keepResident: false },
    }),
    saveSettings: vi.fn().mockResolvedValue({}),
    saveDocumentParseSettings: vi.fn().mockResolvedValue({ ok: true }),
    listDocumentParseModules: vi.fn().mockResolvedValue([
      { id: 'baseline', label: '基础解析', bundled: true, installed: true, canDownload: false },
      { id: 'seal', label: '印章', bundled: false, installed: false, canDownload: false },
      { id: 'formula', label: '公式', bundled: false, installed: false, canDownload: false },
      { id: 'chart', label: '图表', bundled: false, installed: false, canDownload: false },
    ]),
    retryDocumentParse: vi.fn().mockResolvedValue({ ok: true }),
    importDocumentParseModule: vi.fn().mockResolvedValue({ ok: true }),
    downloadDocumentParseModule: vi.fn().mockResolvedValue({ ok: false, error: '网络不可达，请改用导入离线包。' }),
    getDocumentParse: vi.fn().mockResolvedValue({ status: 'stopped', waiting: [] }),
    listProviders: vi.fn().mockResolvedValue([
      { id: 'deepseek', name: 'DeepSeek', kind: 'builtin', baseUrl: 'https://api.deepseek.com', apiKeyAuth: true, oauthAuth: false },
    ]),
    getApiKey: vi.fn().mockResolvedValue(''),
  } as any;
}

afterEach(cleanup);

describe('document-parse copy rules', () => {
  it('locks the four user-facing error strings', () => {
    expect(DOCUMENT_PARSE_NOT_READY).toBe('文档解析尚未就绪，请到设置 → 文档解析查看。');
    expect(DOCUMENT_PARSE_DISK_FULL).toBe('磁盘空间不足，无法准备文档解析。');
    expect(DOCUMENT_PARSE_SPAWN_FAILED).toBe('内存不足或文档解析无法启动，请到设置 → 文档解析查看。');
    expect(DOCUMENT_PARSE_STOPPED).toBe('文档解析已停止。');
  });

  it('does not put worker/OCR/Paddle/JSON-RPC in the locked error strings', () => {
    for (const message of LOCKED_ERRORS) {
      expect(message).not.toMatch(FORBIDDEN);
    }
  });

  it('renders RuntimeCenter and StatusBar parsing copy without internal names', () => {
    const { container } = render(
      <>
        <RuntimeCenter
          snapshot={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
          documentParse={parsingSnap}
          onStop={vi.fn()}
          onRelease={vi.fn()}
          onCancelQueue={vi.fn()}
          onStopParse={vi.fn()}
          onReleaseParse={vi.fn()}
          onCancelLoad={vi.fn()}
        />
        <StatusBar
          statusText="就绪"
          runtimePool={{ active: 1, queued: 0, maxAgents: 4, sessions: [], queue: [] }}
          documentParse={parsingSnap}
          onOpenQueue={vi.fn()}
        />
      </>,
    );
    expect(screen.getByText(/正在解析/)).toBeTruthy();
    expect(screen.getByText(/文档解析进行中/)).toBeTruthy();
    expect(container.textContent).not.toMatch(FORBIDDEN);

    fireEvent.click(screen.getByRole('button', { name: '停止解析' }));
    expect(container.textContent).not.toMatch(FORBIDDEN);
  });

  it('renders Settings 文档解析 without internal names', async () => {
    render(<SettingsView api={makeSettingsApi()} />);
    fireEvent.click(screen.getByRole('button', { name: '文档解析' }));
    await screen.findByRole('heading', { name: '文档解析' });
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it('scans supervisor exported user strings', () => {
    expect(DOCUMENT_PARSE_SPAWN_FAILED).not.toMatch(FORBIDDEN);
    expect(DOCUMENT_PARSE_STOPPED).not.toMatch(FORBIDDEN);
  });
});
