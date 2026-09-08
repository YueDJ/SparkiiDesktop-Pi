import { useEffect, useState } from 'react';
import { Button, useErrors } from '@sparkii/ui';

export type UserSkillRow = {
  name: string;
  description: string;
  hasScripts: boolean;
  warnings: string[];
  kind?: 'skill' | 'pack';
  skillCount?: number;
};

export type SkillsPaneApi = {
  listUserSkills?(): Promise<{ agent: { id: string; name: string } | null; skills: UserSkillRow[] }>;
  previewUserSkill?(sourceDir: string): Promise<
    | { ok: true; skill: UserSkillRow; destName: string }
    | { ok: false; reason: string; diagnostics?: string[] }
  >;
  chooseSkillFolder?(): Promise<{ path?: string }>;
  importUserSkill?(opts: { sourceDir: string; overwrite?: boolean }): Promise<
    { ok: true; name: string } | { ok: false; reason: string; name?: string; diagnostics?: string[] }
  >;
  uninstallUserSkill?(opts: { name: string }): Promise<{ ok: true } | { ok: false; reason: string }>;
  openUserSkillsDir?(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
};

const REASON_TEXT: Record<string, string> = {
  'not-skill-root': '所选文件夹不是技能或技能包（需要 SKILL.md，或含 skills/ / Pi 技能包）',
  'invalid-skill': '无法加载该技能（缺少可用的 description）',
  exists: '已存在同名技能',
  overlap: '源路径与技能库重叠，无法导入',
  'not-found': '未找到该技能',
  'no-user-library': '未配置用户技能库',
  'bad-name': '技能名称不合法',
  unavailable: '无法读取所选文件夹',
};

function reasonMessage(reason: string, diagnostics?: string[]): string {
  const base = REASON_TEXT[reason] ?? `操作失败：${reason}`;
  if (diagnostics?.length) return `${base}：${diagnostics.join('；')}`;
  return base;
}

export function SettingsSkillsPane({ api }: { api?: SkillsPaneApi }) {
  const { reportError } = useErrors();
  const [agent, setAgent] = useState<{ id: string; name: string } | null>(null);
  const [skills, setSkills] = useState<UserSkillRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = async () => {
    if (!api?.listUserSkills) {
      setAgent(null);
      setSkills([]);
      setLoaded(true);
      return;
    }
    try {
      const result = await api.listUserSkills();
      setAgent(result.agent);
      setSkills(result.skills);
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, [api]);

  const importFolder = async () => {
    if (!api?.chooseSkillFolder || !api.previewUserSkill || !api.importUserSkill) return;
    try {
      const chosen = await api.chooseSkillFolder();
      if (!chosen.path) return;
      const preview = await api.previewUserSkill(chosen.path);
      if (!preview.ok) {
        reportError(reasonMessage(preview.reason, preview.diagnostics), { source: '系统设置' });
        return;
      }
      const scriptsHint = preview.skill.hasScripts ? '\n其中的命令仍要审批。' : '';
      const packHint = preview.skill.kind === 'pack' && preview.skill.skillCount
        ? `（${preview.skill.skillCount} 个技能）`
        : '';
      const label = preview.skill.kind === 'pack' ? '技能包' : '技能';
      if (!window.confirm(`导入${label}「${preview.skill.name}」${packHint}？\n${preview.skill.description}${scriptsHint}`)) return;
      let result = await api.importUserSkill({ sourceDir: chosen.path });
      if (!result.ok && result.reason === 'exists') {
        if (!window.confirm(`技能「${result.name ?? preview.skill.name}」已存在，要覆盖吗？`)) return;
        result = await api.importUserSkill({ sourceDir: chosen.path, overwrite: true });
      }
      if (!result.ok) {
        reportError(reasonMessage(result.reason, result.diagnostics), { source: '系统设置' });
        return;
      }
      await refresh();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  const uninstall = async (name: string) => {
    if (!api?.uninstallUserSkill) return;
    if (!window.confirm(`卸载技能「${name}」？`)) return;
    try {
      const result = await api.uninstallUserSkill({ name });
      if (!result.ok) {
        reportError(reasonMessage(result.reason), { source: '系统设置' });
        return;
      }
      await refresh();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  const openFolder = async () => {
    if (!api?.openUserSkillsDir) return;
    try {
      const result = await api.openUserSkillsDir();
      if (!result.ok) reportError(reasonMessage(result.reason), { source: '系统设置' });
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e), { source: '系统设置' });
    }
  };

  const noLibrary = loaded && !agent;
  const actionsDisabled = noLibrary;

  return (
    <>
      <h3 className="settings-section-title">技能</h3>
      {noLibrary ? (
        <div className="ui-muted settings-hint">未配置用户技能库</div>
      ) : (
        <div className="ui-muted settings-hint">
          这些技能仅用于「{agent?.name ?? ''}」。装上的 skill 在新会话里生效。
        </div>
      )}
      <div className="settings-actions">
        <Button onClick={importFolder} disabled={actionsDisabled}>导入文件夹</Button>
        <Button onClick={openFolder} disabled={actionsDisabled}>打开技能文件夹</Button>
      </div>
      {loaded && !noLibrary && skills.length === 0 && (
        <div className="ui-muted settings-hint">还没有安装技能。</div>
      )}
      <div className="settings-skill-list">
        {skills.map((skill) => (
          <div key={skill.name} className="settings-skill-row">
            <div className="settings-skill-main">
              <div className="settings-skill-name">{skill.name}</div>
              <div className="ui-muted settings-skill-desc">{skill.description}</div>
              {skill.hasScripts && (
                <div className="ui-muted settings-skill-note">其中的命令仍要审批。</div>
              )}
              {skill.warnings.map((warning) => (
                <div key={warning} className="ui-muted settings-skill-warn">{warning}</div>
              ))}
            </div>
            <Button variant="danger" disabled={actionsDisabled} onClick={() => void uninstall(skill.name)}>
              卸载
            </Button>
          </div>
        ))}
      </div>
    </>
  );
}
