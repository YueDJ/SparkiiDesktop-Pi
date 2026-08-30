import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';
import { useErrors } from '@sparkii/ui';

type Msg = { role: string; text: string; streaming: boolean };

export function ChatWorkbench(props: { api: SparkiiApi }) {
  const { reportError } = useErrors();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => props.api.on('chat-event', (p: any) => {
    if (p?.type !== 'message') return;
    const role = p.role ?? 'assistant';
    if (role === 'user') return; // user messages are echoed locally
    if (typeof p.delta === 'string') {
      setMsgs((xs) => {
        const last = xs[xs.length - 1];
        if (last && last.role === role && last.streaming) return [...xs.slice(0, -1), { ...last, text: last.text + p.delta }];
        return [...xs, { role, text: p.delta, streaming: true }];
      });
    } else if (typeof p.text === 'string') {
      setMsgs((xs) => {
        const last = xs[xs.length - 1];
        if (last && last.role === role && last.streaming) return [...xs.slice(0, -1), { role, text: p.text, streaming: false }];
        return [...xs, { role, text: p.text, streaming: false }];
      });
    }
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
