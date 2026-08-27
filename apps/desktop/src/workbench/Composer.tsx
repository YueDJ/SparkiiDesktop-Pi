import { ChatComposer } from '@sparkii/ui';

export interface ComposerProps {
  busy: boolean;
  models: string[];
  defaultModel: string | null;
  model: string | null;
  onModelChange(model: string | null): void;
  thinkingLevels: string[];
  thinkingLevel: string | null;
  onThinkingLevelChange(level: string | null): void;
  workspacePath: string | null;
  workspaceKind: 'auto' | 'user';
  onChooseWorkspace(): void;
  onClearWorkspace(): void;
  onSend(text: string): void;
  onStop(): void;
}

export function Composer(props: ComposerProps) {
  return (
    <ChatComposer
      busy={props.busy}
      workspacePath={props.workspacePath}
      workspaceKind={props.workspaceKind}
      onChooseWorkspace={props.onChooseWorkspace}
      onClearWorkspace={props.onClearWorkspace}
      modelProps={{
        model: props.model,
        defaultModel: props.defaultModel,
        models: props.models,
        thinkingLevel: props.thinkingLevel,
        thinkingLevels: props.thinkingLevels,
        onModelChange: props.onModelChange,
        onThinkingLevelChange: props.onThinkingLevelChange,
      }}
      onSend={props.onSend}
      onStop={props.onStop}
    />
  );
}
