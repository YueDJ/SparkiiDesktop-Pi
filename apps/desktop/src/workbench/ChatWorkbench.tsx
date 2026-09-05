import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';
import { useErrors } from '@sparkii/ui';

type Msg = { role: string; text: string; streaming: boolean };

function messageText(message: any): string {
  if (typeof message?.text === 'string') return message.text;
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('');
}

export function ChatWorkbench(props: { api: SparkiiApi }) {
  const { reportError } = useErrors();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => props.api.on('chat-event', (p: any) => {
    if (p?.type !== 'message_start' && p?.type !== 'message_update' && p?.type !== 'message_end') return;
    const role = String(p?.message?.role ?? 'assistant');
    if (role === 'user') return; // the draft is echoed locally when we send it
    if (role !== 'assistant') return;
    const text = messageText(p?.message);
    const streaming = p.type !== 'message_end';
    setMsgs((xs) => {
      // Pi resends the whole message every tick; find the open slot and replace it rather than
      // stitching `delta` fragments, which lose text whenever a tick is missed.
      const idx = xs.findIndex((m) => m.role === 'assistant' && m.streaming);
      if (idx < 0) return [...xs, { role: 'assistant', text, streaming }];
      const next = [...xs];
      next[idx] = { role: 'assistant', text, streaming };
      return next;
    });
  }), [props.api]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setMsgs((xs) => [...xs, { role: 'user', text, streaming: false }]);
    setDraft('');
    setBusy(true);
    props.api.prompt(text).catch((e: any) => reportError(String(e?.message ?? e), { source: '通用智能体' })).finally(() => setBusy(false));
  };

  return (
    <div>
      <div>{msgs.map((m, i) => <div key={i}>{m.role}: {m.text}</div>)}</div>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={send} disabled={busy}>{busy ? '发送中…' : '发送'}</button>
    </div>
  );
}
