import type { ReactNode } from 'react';

export function ChatMessage({ role, text, thinking, streaming = false, children }: { role: 'user' | 'assistant'; text: string; thinking?: string; streaming?: boolean; children?: ReactNode }) {
  return (
    <div className={`ui-chat-message ui-chat-message--${role}`}>
      {thinking && <details className="ui-thinking" open={streaming}><summary>思考过程</summary><div>{thinking}</div></details>}
      <div className="ui-chat-message-body">{children ?? text}</div>
      {streaming && <span className="ui-caret" aria-hidden="true" />}
    </div>
  );
}
