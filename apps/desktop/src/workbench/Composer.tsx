import { ChatComposer, type ComposerAttachment } from '@sparkii/ui';

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
  getLocalPath?(file: File): string;
  onChooseWorkspace(): void;
  onSend(text: string, attachments: ComposerAttachment[]): void;
  onStop(): void;
}

export function Composer(props: ComposerProps) {
  return (
    <ChatComposer
      busy={props.busy}
      workspacePath={props.workspacePath}
      getLocalPath={props.getLocalPath}
      onChooseWorkspace={props.onChooseWorkspace}
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
