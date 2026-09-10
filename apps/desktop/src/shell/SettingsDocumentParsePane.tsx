import { useEffect, useState } from 'react';
import { Button, SettingsRow, Switch, TextField, useErrors } from '@sparkii/ui';

export type DocumentParseModuleRow = {
  id: string;
  label: string;
  bundled?: boolean;
  installed: boolean;
  canDownload: boolean;
};

export type DocumentParsePaneApi = {
  getSettings?(): Promise<unknown>;
  saveDocumentParseSettings?(partial: { idleMinutes: number; keepResident: boolean }): Promise<{ ok: true }>;
  listDocumentParseModules?(): Promise<DocumentParseModuleRow[]>;
  retryDocumentParse?(): Promise<{ ok: true }>;
  importDocumentParseModule?(path?: string): Promise<{ ok: boolean; error?: string }>;
  downloadDocumentParseModule?(id: string): Promise<{ ok: boolean; error?: string }>;
  getDocumentParse?(): Promise<{
    status: 'stopped' | 'starting' | 'parsing' | 'idle' | 'resident';
    waiting: unknown[];
  }>;
};

const FALLBACK_MODULES: DocumentParseModuleRow[] = [
  { id: 'baseline', label: '基础解析', bundled: true, installed: true, canDownload: false },
  { id: 'seal', label: '印章', bundled: false, installed: false, canDownload: false },
  { id: 'formula', label: '公式', bundled: false, installed: false, canDownload: false },
  { id: 'chart', label: '图表', bundled: false, installed: false, canDownload: false },
];

const STATUS_LABEL: Record<string, string> = {
  stopped: '未启动',
  starting: '正在加载',
  parsing: '正在解析',
  idle: '空闲',
  resident: '常驻',
};

export function SettingsDocumentParsePane({ api }: { api?: DocumentParsePaneApi }) {
  const { reportError } = useErrors();
  const [idleMinutes, setIdleMinutes] = useState(5);
  const [keepResident, setKeepResident] = useState(false);
  const [modules, setModules] = useState<DocumentParseModuleRow[]>(FALLBACK_MODULES);
  const [status, setStatus] = useState<string | null>(null);
  const [info, setInfo] = useState('');

  const load = async () => {
    try {
      const raw = await api?.getSettings?.();
      const dp = ((raw ?? {}) as { documentParse?: { idleMinutes?: number; keepResident?: boolean } }).documentParse ?? {};
      if (typeof dp.idleMinutes === 'number' && Number.isFinite(dp.idleMinutes)) setIdleMinutes(dp.idleMinutes);
      setKeepResident(dp.keepResident === true);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '文档解析' });
    }
    try {
      const listed = await api?.listDocumentParseModules?.();
      if (listed && listed.length > 0) setModules(listed);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '文档解析' });
    }
    try {
      const snap = await api?.getDocumentParse?.();
      if (snap) setStatus(STATUS_LABEL[snap.status] ?? '未启动');
    } catch {
      /* optional status line */
    }
  };

  useEffect(() => {
    void load();
  }, [api]);

  const save = async () => {
    if (!api?.saveDocumentParseSettings) return;
    try {
      await api.saveDocumentParseSettings({ idleMinutes, keepResident });
      setInfo('设置已保存');
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '文档解析' });
    }
  };

  const reload = async () => {
    try {
      await api?.retryDocumentParse?.();
      setInfo('已重新加载');
      const snap = await api?.getDocumentParse?.();
      if (snap) setStatus(STATUS_LABEL[snap.status] ?? '未启动');
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '文档解析' });
    }
  };

  const importOffline = async () => {
    try {
      const result = await api?.importDocumentParseModule?.();
      if (!result) return;
      if (!result.ok) {
        reportError(result.error ?? '无法识别该离线包。', { source: '文档解析' });
        return;
      }
      setInfo('已导入离线包');
      const listed = await api?.listDocumentParseModules?.();
      if (listed && listed.length > 0) setModules(listed);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '文档解析' });
    }
  };

  const download = async (id: string) => {
    try {
      const result = await api?.downloadDocumentParseModule?.(id);
      if (!result) return;
      if (!result.ok) {
        reportError(result.error ?? '网络不可达，请改用导入离线包。', { source: '文档解析' });
        return;
      }
      setInfo('已下载');
      const listed = await api?.listDocumentParseModules?.();
      if (listed && listed.length > 0) setModules(listed);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '文档解析' });
    }
  };

  return (
    <>
      <h3 className="settings-section-title">文档解析</h3>
      {status != null && <div className="ui-muted settings-hint">当前：{status}</div>}
      <SettingsRow label="空闲后释放">
        <TextField
          data-testid="document-parse-idle-minutes"
          className="settings-timeout"
          type="number"
          min={1}
          max={60}
          value={idleMinutes}
          disabled={keepResident}
          onChange={(e) => setIdleMinutes(Number(e.target.value))}
        />
      </SettingsRow>
      <SettingsRow label="保持常驻" hint="大约占用 1 GB 以上内存">
        <Switch checked={keepResident} onCheckedChange={setKeepResident} label="保持常驻" />
      </SettingsRow>
      <div className="settings-actions">
        <Button onClick={reload}>重新加载</Button>
        <Button variant="primary" onClick={save}>保存</Button>
      </div>
      {info && <div className="ui-muted settings-hint">{info}</div>}
      <h3 className="settings-section-title settings-title-mt">模块</h3>
      <div className="settings-skill-list">
        {modules.map((mod) => (
          <div key={mod.id} className="settings-skill-row">
            <div className="settings-skill-main">
              <div className="settings-skill-name">{mod.label}</div>
              <div className="ui-muted settings-skill-note">
                {mod.bundled ? '已随包' : mod.installed ? '已导入' : '未安装'}
              </div>
            </div>
            {!mod.bundled && (
              <Button disabled={!mod.canDownload} onClick={() => void download(mod.id)}>下载</Button>
            )}
          </div>
        ))}
      </div>
      <div className="settings-actions">
        <Button onClick={importOffline}>导入离线包</Button>
      </div>
    </>
  );
}
