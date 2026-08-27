import { useState } from 'react';
import { Menu, MenuItem } from '../primitives/Menu.js';

export interface ModelEffortProps {
  model: string | null;
  defaultModel: string | null;
  models: string[];
  thinkingLevel: string | null;
  thinkingLevels: string[];
  onModelChange(model: string | null): void;
  onThinkingLevelChange(level: string | null): void;
}

const LEVEL_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

function levelLabel(level: string): string {
  return LEVEL_LABELS[level] ?? level;
}

type Submenu = 'root' | 'model' | 'thinking';

export function ModelEffortControl(props: ModelEffortProps) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<Submenu>('root');
  const currentModel = props.model ?? props.defaultModel ?? '默认';
  const currentLevel = props.thinkingLevel ? levelLabel(props.thinkingLevel) : '默认';
  const close = () => { setOpen(false); setSub('root'); };

  return (
    <div className="ui-model-effort">
      <button type="button" className="ui-btn ui-btn--md ui-model-effort-trigger" data-testid="model-effort-trigger" onClick={() => setOpen((v) => !v)}>
        {currentModel} · {currentLevel}
      </button>
      {open && (
        <Menu open onClose={close}>
          {sub === 'root' ? (
            <>
              <MenuItem label="模型" hint={currentModel} onSelect={() => setSub('model')} />
              <MenuItem label="思考强度" hint={currentLevel} onSelect={() => setSub('thinking')} />
            </>
          ) : sub === 'model' ? (
            <>
              <MenuItem label="返回" trailing="‹" onSelect={() => setSub('root')} />
              <MenuItem
                label="默认（跟随配置）"
                hint={props.defaultModel ?? undefined}
                trailing={props.model === null ? '✓' : ''}
                onSelect={() => { close(); props.onModelChange(null); }}
              />
              {props.models.map((m) => (
                <MenuItem key={m} label={m} trailing={props.model === m ? '✓' : ''} onSelect={() => { close(); props.onModelChange(m); }} />
              ))}
            </>
          ) : (
            <>
              <MenuItem label="返回" trailing="‹" onSelect={() => setSub('root')} />
              <MenuItem
                label="默认（跟随配置）"
                trailing={props.thinkingLevel === null ? '✓' : ''}
                onSelect={() => { close(); props.onThinkingLevelChange(null); }}
              />
              {props.thinkingLevels.map((l) => (
                <MenuItem key={l} label={levelLabel(l)} trailing={props.thinkingLevel === l ? '✓' : ''} onSelect={() => { close(); props.onThinkingLevelChange(l); }} />
              ))}
            </>
          )}
        </Menu>
      )}
    </div>
  );
}
