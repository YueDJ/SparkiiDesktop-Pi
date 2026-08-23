import { useEffect, useState } from 'react';
import type { SparkiiApi } from '../types/sparkii-api.js';

type Msg = { role: string; text: string; streaming: boolean };

export function ChatWorkbench(props: { api: SparkiiApi }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [draft, setDraft] = useState('');
  useEffect(() => props.api.on('chat-event', (p: any) => {
    if (p?.type !== 'message') return;
    const role = p.role ?? 'assistant';
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
  return (
    <div>
      <div>{msgs.map((m, i) => <div key={i}>{m.role}: {m.text}</div>)}</div>
      <input value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button onClick={() => { props.api.prompt(draft); setDraft(''); }}>发送</button>
    </div>
  );
}
